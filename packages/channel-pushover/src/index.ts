/**
 * The Pushover channel of the alert system. It gives the procedures of the channel contract of
 * `@mark1russell7/alerts`: `describe`, `send`, `status` and `cancel`. The calls of the Pushover API
 * come from `@procedures/notify/pushover`.
 */

import { COPY_ID, LEVELS, WHY_LIMITS, type AddressField, type ChannelDescriptor, type ChannelId, type ChannelProcedures, type Instant, type SendOutcome } from "@mark1russell7/alerts";
import { isQuotaError, type Quota, type QuotaError, type QuotaGate, type QuotaReading, type QuotaState } from "polite-crawler/api";
import {
  callPushover,
  extractPushoverCancelled,
  extractPushoverReceipt,
  extractPushoverSent,
  PUSHOVER_KEY,
  PUSHOVER_LIMITS,
  PUSHOVER_RETRY_MIN_MS,
  pushoverCancelByTagRequest,
  pushoverCancelRequest,
  pushoverReceiptRequest,
  type PushoverFailure,
  type PushoverFetch,
  type PushoverRequest,
  type PushoverResponse,
  type PushoverSent,
  pushoverSendRequest,
} from "@procedures/notify/pushover";
import { type PushoverMapOptions, priorityOf, pushoverMessageOf, sendFailureOf, statusOf } from "./map.ts";

export { priorityOf, pushoverMessageOf, sendFailureOf, statusOf } from "./map.ts";
export type { PushoverMapOptions, Refusal } from "./map.ts";

/** The time limit of one call when the options give none, in milliseconds. */
export const PUSHOVER_TIMEOUT_MS = 10_000;

/** The time between two repeats of a `life-safety` message when the options give none, in milliseconds. It is also the minimum. */
export const PUSHOVER_REPEAT_MS: number = PUSHOVER_RETRY_MIN_MS;

/** The id of the channel. */
export const CHANNEL_ID = "pushover" as ChannelId;

/**
 * The most calls of one client in progress at the same time. The Pushover API asks for no more than 2
 * HTTP requests at the same time, and it limits an IP address that opens more.
 */
const PUSHOVER_MAX_IN_FLIGHT = 2;

/** The count of messages that Pushover gives one application in a month, with no paid upgrade. */
export const PUSHOVER_MONTHLY_LIMIT = 10_000;

/**
 * The units of the monthly quota that only a `life-safety` message can use. Pushover refuses each
 * message at 0 left, also at priority 2. Thus the reserve must hold the `life-safety` messages until
 * the reset. The value 1000 is an assumption. It ends when the log of the live instance gives the count
 * of the `life-safety` sends of 30 days.
 */
export const PUSHOVER_RESERVE = 1_000;

/**
 * The monthly quota of the messages of one application. Its window starts at midnight in
 * `America/Chicago` on the first day of the month, as the reset of the example of the Pushover API.
 * The count of each answer of Pushover corrects the local count.
 */
export const PUSHOVER_QUOTA: Quota = {
  name: "Pushover messages",
  limit: PUSHOVER_MONTHLY_LIMIT,
  reserve: PUSHOVER_RESERVE,
  window: { kind: "calendar", unit: "month", timeZone: "America/Chicago" },
};

/**
 * The messages that tell of the entry into the reserve: one in each window of `PUSHOVER_QUOTA`. Such a
 * message passes the reserve. Thus the person knows that only `life-safety` comes until the reset.
 */
export const PUSHOVER_RESERVE_NOTICES: Quota = {
  name: "Pushover reserve notices",
  limit: 1,
  window: PUSHOVER_QUOTA.window,
};

/**
 * This function gives the units of a message in the quota: 0 at priority 2, and 1 below it. Thus the
 * quota does not stop a `life-safety` message at any time.
 */
export function pushoverCost(priority: number): number {
  return priority === 2 ? 0 : 1;
}

/**
 * This function tells if a value has the form of a key of Pushover: 30 letters and digits. The API token of an
 * application, a user key and a group key have this form. A start of the system examines each key with it, thus a
 * bad key stops the start, before the first alert.
 */
export function isPushoverKey(value: unknown): value is string {
  return typeof value === "string" && PUSHOVER_KEY.test(value);
}

/** The options of the Pushover channel. */
export interface PushoverChannelOptions extends PushoverMapOptions {
  /** The API token of the application. The private configuration gives it at run time. */
  readonly token: string;
  /** The fetch of each call. */
  readonly fetch: PushoverFetch;
  /**
   * The gate of the monthly messages of the application, for example `quotaGate(PUSHOVER_QUOTA, ...)` of
   * `polite-crawler/api` with a store in a file. With no gate, the channel counts nothing.
   *
   * - A send takes the units of `pushoverCost` before its call. A `life-safety` message takes no unit.
   * - A refusal of the gate gives `reserved` while Pushover still sends. Else it gives `rate-limited`.
   * - The count of each answer of Pushover goes into the gate. A message that Pushover refused gives back its unit.
   */
  readonly quota?: QuotaGate | undefined;
  /**
   * The gate of `PUSHOVER_RESERVE_NOTICES`, with the store of `quota`. A message with `useReserve` passes the
   * reserve when this gate gives it a unit. With no such gate, the reserve stops it as the others.
   */
  readonly reserveNotices?: QuotaGate | undefined;
  /** The platform of the device of the person. It adds the push service of the platform to `dependsOn`. */
  readonly platform?: "ios" | "android" | undefined;
  /** The time limit of one call. The default is 10 seconds. */
  readonly timeoutMs?: number | undefined;
  /** This function gives the time in milliseconds since the epoch. The default is `Date.now`. */
  readonly now?: (() => Instant) | undefined;
}

/**
 * The fields of the address of a person on Pushover. The user key has the key form of `@procedures/notify`. A device
 * name of Pushover has up to 25 letters, digits, `_` and `-`. An empty device name sends to each device of the person.
 */
export const PUSHOVER_ADDRESS: readonly AddressField[] = [
  { name: "user", required: true, pattern: PUSHOVER_KEY.source, form: "a key of Pushover: 30 letters and digits" },
  { name: "device", required: false, pattern: "[A-Za-z0-9_-]{0,25}", form: "a device name of Pushover: up to 25 letters, digits, _ and -" },
];

/** This function gives the descriptor of the channel for a platform. */
export function pushoverDescriptor(platform?: "ios" | "android"): ChannelDescriptor {
  const push = platform === "ios" ? ["provider:apns"] : platform === "android" ? ["provider:fcm"] : [];
  // The push endpoint of the platform carries each message to the phone: Apple for iOS, Firebase Cloud Messaging for Android.
  const pushServices = platform === "ios" ? ["domain:api.push.apple.com"] : platform === "android" ? ["domain:fcm.googleapis.com"] : [];
  return {
    id: CHANNEL_ID,
    title: "Pushover",
    dependsOn: ["provider:pushover", ...push],
    services: ["domain:api.pushover.net", ...pushServices],
    // The calls of the channel reach only the API of Pushover. The push service of the phone platform is not an endpoint.
    api: ["domain:api.pushover.net"],
    uses: ["internet", "dns", "power"],
    // A `life-safety` message at priority 2 sounds through silent mode with the Critical Alerts of the app.
    breaksThrough: true,
    repeats: true,
    ack: "poll",
    // Only a message at priority 2 has a receipt, thus only its level asks for an acknowledgment.
    ackLevels: LEVELS.filter((level) => priorityOf(level, false) === 2),
    maxTitle: PUSHOVER_LIMITS.title,
    maxBody: PUSHOVER_LIMITS.message,
    maxInFlight: PUSHOVER_MAX_IN_FLIGHT,
    why: WHY_LIMITS.push,
    address: PUSHOVER_ADDRESS,
  };
}

/**
 * This function makes the procedures of the Pushover channel.
 *
 * - `send` does not throw. A refusal of the quota is a failure of the kind `rate-limited`, thus the escalation goes to its next step.
 * - `status` does not throw. A receipt that the channel cannot read keeps the state `accepted`.
 * - `cancel` stops the repeats by the tag of the receipt: the delivery key. Thus it also stops a copy of a send whose receipt the log does not have. A receipt with no tag stops by its id.
 * - `cancel({ copy })` stops one copy by its copy id, the second tag of the message. The other copies of the key continue.
 * - `cancel` is idempotent. A cancel that Pushover refuses ends without an error, because Pushover does not know the receipt (it keeps a receipt for one week). Thus no repeats continue.
 * - `cancel` throws for each other failure, thus the caller can try again. A request that Pushover refused does not go again, because many refusals can block the address of the caller.
 */
export function createPushoverChannel(options: PushoverChannelOptions): ChannelProcedures {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? PUSHOVER_TIMEOUT_MS;
  const descriptor = pushoverDescriptor(options.platform);

  /** One call. */
  const call = <Result>(request: PushoverRequest, extract: (response: PushoverResponse) => Result | PushoverFailure): Promise<Result | PushoverFailure> =>
    callPushover(options.fetch, request, extract, { timeoutMs });

  return {
    describe: () => descriptor,

    async send({ message, address, copy }): Promise<SendOutcome> {
      if (copy !== undefined && !COPY_ID.test(copy)) return { ok: false, kind: "refused", message: `The copy id "${copy}" has a character that the path of a stop cannot have.` };
      const at = now();
      if (!isPushoverKey(options.token)) return { ok: false, kind: "auth", message: "The API token is not 30 letters and digits." };
      const mapped = pushoverMessageOf(message, address, at, options, copy);
      if ("refused" in mapped) return { ok: false, kind: mapped.kind ?? "refused", message: mapped.refused };
      let request: PushoverRequest;
      try {
        request = pushoverSendRequest(options.token, mapped);
      } catch (error) {
        return { ok: false, kind: "refused", message: error instanceof Error ? error.message : "The message breaks a rule of the Pushover API." };
      }
      const gate = options.quota;
      // A message with no priority has the normal priority 0.
      const cost = pushoverCost(mapped.priority ?? 0);
      let taken: QuotaState | undefined;
      let notice: QuotaState | undefined;
      if (gate !== undefined && cost > 0) {
        try {
          taken = gate.take(cost);
        } catch (error) {
          // A refusal of the gate stops the send. A fault of the store of the gate does not: the message goes with no count.
          if (isQuotaError(error)) {
            const refusal = quotaRefusal(gate, error, at);
            const pass = refusal.kind === "reserved" && message.useReserve === true ? takeNotice(options.reserveNotices) : "refused";
            if (pass === "refused") return refusal;
            notice = pass;
          }
        }
      }
      const result = await call(request, extractPushoverSent);
      if (gate !== undefined) noteAnswer(gate, result, taken === undefined ? undefined : { cost, at: taken.at });
      if (options.reserveNotices !== undefined && notice !== undefined) noteAnswer(options.reserveNotices, result, { cost: 1, at: notice.at }, false);
      if (!result.ok) return sendFailureOf(result, at);
      // An emergency carries the delivery key as its tag. The receipt keeps the tag, thus a cancel stops each copy of the key.
      const tag = mapped.emergency?.tags?.[0];
      return {
        ok: true,
        receipt: { request: result.request, ...(result.receipt === undefined ? {} : { receipt: result.receipt }), ...(tag === undefined ? {} : { tag }) },
        accepted: at,
      };
    },

    async status({ receipt }) {
      const at = now();
      const id = receipt["receipt"];
      // Only a message at priority 2 has a receipt.
      if (id === undefined) return { state: "accepted", at, reason: "Pushover tells no state of a message below priority 2." };
      let request: PushoverRequest;
      try {
        request = pushoverReceiptRequest(options.token, id);
      } catch (error) {
        return { state: "accepted", at, reason: error instanceof Error ? error.message : "The receipt is not valid." };
      }
      const result = await call(request, extractPushoverReceipt);
      if (!result.ok) return { state: "accepted", at, reason: `The receipt was not read: ${result.errors.join(" ")}` };
      return statusOf(result, at);
    },

    async cancel(target) {
      let request: PushoverRequest | undefined;
      if ("copy" in target) {
        // The copy id is the second tag of the message. It stops only this copy, and the new copy of the key continues.
        if (!COPY_ID.test(target.copy)) throw new Error(`The copy id "${target.copy}" has a character that the path of a stop cannot have.`);
        request = pushoverCancelByTagRequest(options.token, target.copy);
      } else {
        const tag = target.receipt["tag"];
        const id = target.receipt["receipt"];
        // The tag stops each message of the delivery key, also a copy whose receipt the log does not have.
        request = tag !== undefined ? pushoverCancelByTagRequest(options.token, tag) : id !== undefined ? pushoverCancelRequest(options.token, id) : undefined;
      }
      // A message below priority 2 does not repeat, thus nothing stops.
      if (request === undefined) return;
      const result = await call(request, extractPushoverCancelled);
      // A refusal tells that Pushover does not know the receipt: it is old, or it is not of this application. Nothing repeats under it.
      if (!result.ok && result.kind !== "refused") throw new Error(`Pushover did not stop the repeats (${result.kind}): ${result.errors.join(" ")}`);
    },
  };
}

/**
 * This function gives the refusal of the gate. Pushover refuses each message after an answer with 0
 * left, or when the window has no unit left. Else the gate keeps the reserve for `life-safety`.
 */
function quotaRefusal(gate: QuotaGate, error: QuotaError, at: Instant): Extract<SendOutcome, { readonly ok: false }> {
  const state = gate.state();
  const full = state.blockedUntil !== undefined || state.used >= gate.quota.limit;
  return { ok: false, kind: full ? "rate-limited" : "reserved", message: error.message, retryAfter: Math.max(0, error.resetAt - at) };
}

/** This function gives the count of an answer of Pushover, as a reading of the gate. */
function readingOf(result: PushoverSent | PushoverFailure): QuotaReading | undefined {
  if (result.ok) return result.limits === undefined ? undefined : { remaining: result.limits.remaining, resetAt: result.limits.resetAt };
  return result.kind === "rate-limited" ? { remaining: 0, ...(result.resetAt === undefined ? {} : { resetAt: result.resetAt }) } : undefined;
}

/**
 * This function takes the unit of a message of the reserve. It gives `refused` when the window has no
 * such unit left. A fault of the store gives the message its pass with no count, as for the quota.
 */
function takeNotice(gate: QuotaGate | undefined): QuotaState | "refused" | undefined {
  if (gate === undefined) return "refused";
  try {
    return gate.take(1);
  } catch (error) {
    return isQuotaError(error) ? "refused" : undefined;
  }
}

/**
 * This function puts the answer of Pushover into the gate. A message that Pushover refused gives back
 * its unit. A failed write of the count does not change the outcome of the send, and the next answer
 * gives the count again. The gate of the reserve notices counts no reading of Pushover.
 */
function noteAnswer(gate: QuotaGate, result: PushoverSent | PushoverFailure, taken: { readonly cost: number; readonly at: number | undefined } | undefined, reads = true): void {
  try {
    if (!result.ok && (result.kind === "auth" || result.kind === "refused") && taken?.at !== undefined) gate.giveBack?.(taken.cost, taken.at);
    const reading = reads ? readingOf(result) : undefined;
    if (reading !== undefined) gate.note(reading);
  } catch {
    // The count of the gate can be low until the next answer. The send has its outcome.
  }
}
