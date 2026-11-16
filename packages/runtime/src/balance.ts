/**
 * The watch of the balance of a paid provider account, and the quota of the spend of a channel.
 *
 * - The runtime starts `check` of each watch in each pass. A watch reads only when it is due: at its first check, then once in each interval.
 * - A failed read keeps the last read that passed. The core gives the line `unread` when the last read is too old.
 * - The watch keeps no record. After a restart, the first check reads again.
 */
import type { BalanceRead, ChannelDescriptor, ChannelId, Duration, Instant, ProviderBalance, SpendConfig } from "@mark1russell7/alerts";
import type { WallClock } from "@mark1russell7/algebra/clock";
import { errorMessage } from "@mark1russell7/text";
import { quotaGate, type Quota, type QuotaGate, type QuotaGateOptions } from "polite-crawler/api";
import { limited } from "./limit.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The answer of a reader of a balance. A reader does not throw. A throw is a failure too. */
export type BalanceReading = { readonly ok: true; readonly balance: number; readonly currency: string } | { readonly ok: false; readonly message: string };

/** The options of one watch. */
export interface BalanceWatchOptions {
  /** The provider, as an id in the `dependsOn` of its channels: for example `provider:twilio`. */
  readonly provider: string;
  /** The name of the provider in a text: for example `Twilio`. */
  readonly title: string;
  /** The channels that the account pays for. The reports have their subjects. */
  readonly channels: readonly ChannelId[];
  /** Below this balance, in the currency of the account, the core gives the line `low`. */
  readonly floor: number;
  /** This function reads the balance. It stops at the abort of the signal. */
  readonly read: (signal: AbortSignal) => Promise<BalanceReading>;
  /** The time between two reads that pass. The default is one day. */
  readonly every?: Duration;
  /** The time after a failed read before the next read. The default is one hour. */
  readonly retry?: Duration;
  /** The longest time with no read that passed. The default is 2 days. Thus one failed day gives no line. */
  readonly maxAge?: Duration;
  /** The longest time of one read. The default is 30 seconds. */
  readonly limit?: Duration;
}

/** The watch of one provider account. */
export interface BalanceWatch {
  readonly provider: string;
  /** This method reads the balance when the read is due, and gives no result. It does not throw. */
  check(clock: WallClock, stop?: AbortSignal): Promise<void>;
  /** This method gives the time of the next read. Before the first check, the read is due at once. */
  nextReadAt(): Instant | undefined;
  /** This method gives the watch as data of the core. Before the first check, it gives `undefined`. */
  balance(): ProviderBalance | undefined;
  /** This method gives the message of the last read when it failed. */
  failure(): string | undefined;
  /**
   * This method moves the own times of the watch by the size of a step of the wall clock. They are the start of the
   * watch, the time of the last read and the time of the next read. Thus the next read keeps its distance on the monotonic clock.
   */
  shift(size: Duration): void;
}

/**
 * This function makes the watch of one provider account.
 *
 * @throws Error when the watch has no channel, or when a time or the floor is not valid.
 */
export function balanceWatch(options: BalanceWatchOptions): BalanceWatch {
  const every = options.every ?? DAY;
  const retry = options.retry ?? HOUR;
  const maxAge = options.maxAge ?? 2 * DAY;
  const limit = options.limit ?? 30_000;
  if (options.channels.length === 0) throw new Error(`The balance watch of ${options.provider} has no channel. Its reports reach no person.`);
  if (!Number.isFinite(options.floor)) throw new Error(`The floor of the balance of ${options.provider} is not a number.`);
  for (const [name, value] of Object.entries({ every, retry, maxAge, limit })) {
    if (!(Number.isInteger(value) && value > 0)) throw new Error(`The time ${name} of the balance watch of ${options.provider} is not a whole count of milliseconds above 0.`);
  }
  let since: Instant | undefined;
  let read: BalanceRead | undefined;
  let next: Instant | undefined;
  let failed: string | undefined;
  let running: Promise<void> | undefined;

  const once = async (clock: WallClock, stop?: AbortSignal): Promise<void> => {
    const own = new AbortController();
    let stopped = false;
    const onStop = (): void => {
      stopped = true;
      own.abort(stop?.reason);
    };
    if (stop?.aborted === true) return;
    stop?.addEventListener("abort", onStop, { once: true });
    const work = Promise.resolve().then(() => options.read(own.signal));
    const late = (): BalanceReading => ({ ok: false, message: `The read of the balance took longer than ${limit} ms.` });
    const thrown = (error: unknown): BalanceReading => ({ ok: false, message: `The read of the balance failed: ${errorMessage(error)}` });
    const reading = await limited(work, limit, clock, late, thrown);
    stop?.removeEventListener("abort", onStop);
    own.abort(new Error("The read of the balance ended."));
    // A read that the stop ended is not a fault of the provider. The next start reads again.
    if (stopped) return;
    const at = clock.now();
    const valid = reading.ok && Number.isFinite(reading.balance) && /^[A-Z]{3}$/.test(reading.currency);
    if (reading.ok && valid) {
      read = { balance: reading.balance, currency: reading.currency, at };
      failed = undefined;
      next = at + every;
    } else {
      failed = reading.ok ? "The read of the balance gave no finite balance or no currency code." : reading.message;
      next = at + retry;
    }
  };

  return {
    provider: options.provider,
    check(clock, stop) {
      since ??= clock.now();
      if (running !== undefined) return running;
      if (next !== undefined && clock.now() < next) return Promise.resolve();
      running = once(clock, stop).finally(() => {
        running = undefined;
      });
      return running;
    },
    nextReadAt: () => next,
    balance() {
      if (since === undefined) return undefined;
      const { provider, title, channels, floor } = options;
      return { provider, title, channels, floor, maxAge, since, ...(read === undefined ? {} : { read }) };
    },
    failure: () => failed,
    shift(size) {
      if (since !== undefined) since += size;
      if (next !== undefined) next += size;
      if (read !== undefined) read = { ...read, at: read.at + size };
    },
  };
}

/** A monthly cap of the spend of a provider account: the fields of a `SpendConfig` of the configuration, and a name. */
export interface SpendCap extends Pick<SpendConfig, "monthlyUsd" | "reserveUsd" | "timeZone"> {
  /** The name of the quota in a message: for example `Twilio spend`. */
  readonly name: string;
}

/**
 * This function gives the spend entry of a channel with a cost: the first entry for a provider in the `dependsOn` of the
 * channel. The cap of the entry counts each send of the channel.
 */
export function spendEntryOf(descriptor: ChannelDescriptor, spend: readonly SpendConfig[] | undefined): SpendConfig | undefined {
  return spend?.find((entry) => descriptor.dependsOn.includes(entry.provider));
}

/** The unit of a quota of the spend, for the texts of the core. */
export const SPEND_UNIT = "cents";

/**
 * This function gives the quota of a cap for a gate of `polite-crawler/api`. The units are cents, and
 * the window is the calendar month. A send takes `spendUnits` of its cost.
 *
 * @throws Error when the cap or the reserve is not valid.
 */
export function spendQuota(cap: SpendCap): Quota {
  const limit = cents(cap.monthlyUsd);
  const reserve = cents(cap.reserveUsd ?? 0);
  if (!(limit > 0)) throw new Error(`The monthly cap of ${cap.name} is not above 0 US dollars.`);
  if (!(reserve >= 0 && reserve < limit)) throw new Error(`The reserve of ${cap.name} is not 0 or more and less than the cap.`);
  return { name: cap.name, limit, reserve, window: { kind: "calendar", unit: "month", timeZone: cap.timeZone } };
}

/**
 * This function gives the cost of one send in whole cents, rounded up. Thus the cap does not count less
 * than the price at any time. It rounds the cost to a millionth of a dollar first, so `0.07` gives 7, not 8.
 *
 * @throws Error when the cost is not 0 or more.
 */
export function spendUnits(costUsd: number): number {
  if (!(Number.isFinite(costUsd) && costUsd >= 0)) throw new Error("The cost of a send is not 0 or more US dollars.");
  return Math.ceil(Math.round(costUsd * 1_000_000) / 10_000);
}

/** The two gates of one cap of the spend. They count the same units. */
export interface SpendGates {
  /** The gate of each message below `life-safety`. It keeps the reserve of the cap. */
  readonly gate: QuotaGate;
  /** The gate of a `life-safety` message. It has no reserve. */
  readonly lifeSafety: QuotaGate;
}

/**
 * This function makes the two gates of one quota of the spend. The gates have one name, one key and one store,
 * thus they keep one record. Only the gate of `life-safety` takes the units of the reserve.
 *
 * @throws Error when the quota is not valid.
 */
export function spendGates(quota: Quota, options: QuotaGateOptions): SpendGates {
  return { gate: quotaGate(quota, options), lifeSafety: quotaGate({ ...quota, reserve: 0 }, options) };
}

function cents(usd: number): number {
  return Number.isFinite(usd) ? Math.round(usd * 100) : Number.NaN;
}
