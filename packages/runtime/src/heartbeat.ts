/**
 * This module holds the outside heartbeat. After each pass with no error, the runtime pings a check of
 * Healthchecks.io. When the pings stop, Healthchecks.io alerts the owner: the process stopped, the
 * computer stopped, or its network is down. While a channel refuses the sends, the heartbeat pings
 * `/fail`, because then the system cannot tell the person itself.
 *
 * The ping URL and the key of the management API are secrets. No ping body and no error text holds
 * them. A ping body holds no place and no person.
 */
import type { Duration, HealthState, Instant, SendOutcome, SourceId } from "@mark1russell7/alerts";
import type { WallClock } from "@mark1russell7/algebra/clock";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import type { Exchange } from "polite-crawler/api";
import type { LoopTimes } from "./loop.ts";

/** The kind of a failed call of a channel. */
export type ChannelFailureKind = Extract<SendOutcome, { readonly ok: false }>["kind"];

/** The kinds of a failed send that stop each delivery to the person until the owner acts. */
export const UNREACHABLE: readonly ChannelFailureKind[] = ["auth", "refused", "rate-limited"];
const unreachable: ReadonlySet<string> = new Set(UNREACHABLE);

/** The time between two pings of the same kind. */
export const HEARTBEAT_EVERY: Duration = 60_000;

/** The longest time of one ping. */
export const HEARTBEAT_LIMIT: Duration = 10_000;

/**
 * The count of failed passes between two pings that the check lets pass. After a failed pass, the
 * loop starts the next pass soon, and that pass does the work again. Thus one failed pass is not a stop.
 */
export const TOLERATED_FAILED_PASSES = 1;

/** The parts of a pass that the heartbeat reads. A `Pass` of the runtime has them. */
export interface PassSummary {
  readonly at: Instant;
  readonly view: { readonly health: readonly { readonly source: SourceId; readonly state: HealthState }[] };
  readonly delivery?: {
    readonly sent: readonly { readonly channel: string }[];
    readonly failures: readonly { readonly call: string; readonly channel: string; readonly kind: string; readonly retryAt: Instant }[];
  };
}

/** One ping: `success` goes to the ping URL, `fail` goes to the ping URL and `/fail`. */
export interface Ping {
  readonly kind: "success" | "fail";
  /** Healthchecks.io keeps this text with the ping. */
  readonly body: string;
}

/** The fail of a channel that refused a send. */
export interface HeldFail {
  /** The kinds of the refused sends, sorted. */
  readonly kinds: readonly string[];
  /** The latest `retryAt` of a refused send on the channel. */
  readonly until: Instant;
}

/** The state of the heartbeat: the last ping that it started, and the fail of each refused channel. */
export interface HeartbeatState {
  readonly last?: { readonly at: Instant; readonly kind: Ping["kind"] };
  readonly held: Readonly<Record<string, HeldFail>>;
}

/** The state of the heartbeat before the first pass. */
export const HEARTBEAT_START: HeartbeatState = { held: {} };

/**
 * This function gives the refused channels after a pass. The delivery step sends a failed call again
 * at the first pass at or after its `retryAt`. Thus no pass between a refusal and its retry ends the fail.
 *
 * - A send on the channel in `delivery.sent` ends the fail.
 * - A pass at or after `until` with no refusal on the channel ends the fail. That pass sent the call again.
 * - A refused send of the pass starts a fail or makes it longer. It comes last. Thus a send and a refusal on
 *   one channel in one pass keep the fail.
 */
export function holdStep(held: HeartbeatState["held"], pass: PassSummary): HeartbeatState["held"] {
  const sent = new Set((pass.delivery?.sent ?? []).map((delivery) => delivery.channel));
  const next: Record<string, HeldFail> = {};
  for (const [channel, hold] of Object.entries(held)) if (!sent.has(channel) && pass.at < hold.until) next[channel] = hold;
  for (const failure of pass.delivery?.failures ?? []) {
    if (failure.call !== "send" || !unreachable.has(failure.kind)) continue;
    const before = next[failure.channel];
    next[failure.channel] = {
      kinds: [...new Set([...(before?.kinds ?? []), failure.kind])].sort(),
      until: Math.max(before?.until ?? failure.retryAt, failure.retryAt),
    };
  }
  return next;
}

/**
 * This function gives the ping of a pass. A refused channel gives `fail`, with the channel and the
 * kind. Else the ping is `success`, with the state of each source. No text of a failure goes into the
 * body, because it can quote a request.
 */
export function pingOf(pass: PassSummary, held: HeartbeatState["held"] = holdStep({}, pass)): Ping {
  const refused = Object.entries(held).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (refused.length > 0) {
    const lines = refused.flatMap(([channel, hold]) => hold.kinds.map((kind) => `The channel ${channel} gave the kind ${kind} to a send.`));
    return { kind: "fail", body: lines.join("\n") };
  }
  return { kind: "success", body: pass.view.health.map((health) => `${health.source}: ${health.state}`).join("\n") };
}

/**
 * This function adds one pass to the state of the heartbeat. A ping goes in four cases: no ping went
 * before, the kind changes, `every` passed after the last ping, or the wall clock stepped back. While
 * `busy` is true, a ping is in flight. Then no ping goes, and only the fails change.
 */
export function heartbeatStep(state: HeartbeatState, pass: PassSummary, every: Duration, busy = false): { readonly state: HeartbeatState; readonly ping?: Ping } {
  const held = holdStep(state.held, pass);
  const ping = pingOf(pass, held);
  const last = state.last;
  const due = !busy && (last === undefined || last.kind !== ping.kind || pass.at - last.at >= every || pass.at < last.at);
  return due ? { state: { held, last: { at: pass.at, kind: ping.kind } }, ping } : { state: { ...state, held } };
}

/** The options of `heartbeatGap`. */
export interface GapOptions {
  /** The time between two pings of the same kind. The default is `HEARTBEAT_EVERY`. */
  readonly every?: Duration;
  /** The longest time of one ping. The default is `HEARTBEAT_LIMIT`. */
  readonly limit?: Duration;
  /** The count of failed passes between the two pings. The default is `TOLERATED_FAILED_PASSES`. */
  readonly failedPasses?: number;
}

/**
 * This function gives the longest time between the arrivals of two success pings. The period plus the
 * grace of the check must be this time or more. Else the check goes down while the runtime works.
 *
 * - A ping starts at the end of a pass, when `every` passed after the time of the last ping. The time of a pass is in the pass.
 * - The next pass starts `retryCap` after the end of a pass at most, because the shortest interval of a source is `retryCap`.
 * - Thus the next ping starts `every` + 2 × `passLimit` + `retryCap` after the last ping at most. It arrives within `limit`.
 * - Each failed pass adds `passLimit` + `retryCap`.
 */
export function heartbeatGap(times: Pick<LoopTimes, "passLimit" | "retryCap">, options: GapOptions = {}): Duration {
  const every = options.every ?? HEARTBEAT_EVERY;
  const limit = options.limit ?? HEARTBEAT_LIMIT;
  const failed = options.failedPasses ?? TOLERATED_FAILED_PASSES;
  return every + 2 * times.passLimit + times.retryCap + limit + failed * (times.passLimit + times.retryCap);
}

/** The fetch of the heartbeat. The global `fetch` is one. */
export type HeartbeatFetch = (url: string, init: { readonly method: "POST"; readonly headers: Record<string, string>; readonly body: string; readonly signal: AbortSignal }) => Promise<{ readonly status: number }>;

/** The options of the heartbeat. */
export interface HeartbeatOptions {
  /** The ping URL of the check, with `https`. It is a secret. */
  readonly url: string;
  readonly fetch: HeartbeatFetch;
  readonly clock: WallClock;
  /** The time between two pings of the same kind. The default is `HEARTBEAT_EVERY`. */
  readonly every?: Duration;
  /** The longest time of one ping. The default is `HEARTBEAT_LIMIT`. */
  readonly limit?: Duration;
  readonly userAgent: string;
  /** The heartbeat gives each failed ping to this function. Its text holds no URL. */
  readonly onError: (message: string) => void;
}

/** This function gives the URL of a ping: the ping URL, or the ping URL and `/fail`. A query of the ping URL stays. */
export function pingUrl(url: string, kind: Ping["kind"]): string {
  if (kind === "success") return url;
  const target = new URL(url);
  target.pathname = `${target.pathname.replace(/\/+$/, "")}/fail`;
  return target.toString();
}

/**
 * This function makes the hook of the heartbeat for the option `onPass` of the runtime. The hook
 * starts the ping and ends at once, thus a slow ping does not hold the pass. One ping at a time
 * is in flight. After a failed ping, the next pass pings again. The hook throws no error.
 */
export function heartbeat(options: HeartbeatOptions): (pass: PassSummary) => void {
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new Error("The ping URL of the heartbeat is not a URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("The ping URL of the heartbeat does not start with https.");
  const every = options.every ?? HEARTBEAT_EVERY;
  const limit = options.limit ?? HEARTBEAT_LIMIT;
  let state = HEARTBEAT_START;
  let flight = false;
  // A lost ping does not count. Thus one lost ping does not make the gap of two pings longer.
  const lost = (message: string): void => {
    state = { held: state.held };
    options.onError(message);
  };
  return (pass) => {
    const step = heartbeatStep(state, pass, every, flight);
    state = step.state;
    if (step.ping === undefined) return;
    flight = true;
    const controller = new AbortController();
    const cancel = options.clock.after(limit, () => controller.abort());
    const kind = step.ping.kind;
    const request = { method: "POST" as const, headers: { "user-agent": options.userAgent, "content-type": "text/plain; charset=utf-8" }, body: step.ping.body, signal: controller.signal };
    Promise.resolve()
      .then(() => options.fetch(pingUrl(options.url, kind), request))
      .then(
        (response) => {
          if (response.status < 200 || response.status > 299) lost(`The ${kind} ping of the heartbeat got the status ${response.status}.`);
        },
        (error: unknown) => {
          // An error of a fetch can quote the URL. The redaction removes it.
          const cause = controller.signal.aborted ? `It took longer than ${limit} ms.` : redactSecrets(errorMessage(error), [options.url]);
          lost(`The ${kind} ping of the heartbeat failed. ${cause}`);
        },
      )
      .finally(() => {
        cancel();
        flight = false;
      })
      // An error of `onError` does not stop the process.
      .catch(() => undefined);
  };
}

/** The base URL of the management API of Healthchecks.io. */
export const HEALTHCHECKS_API = "https://healthchecks.io/api/v3/";

/** This function gives the request that lists the checks of the project of the key. The key is a secret. */
export function checksRequest(apiKey: string, userAgent: string, base: string = HEALTHCHECKS_API): Exchange {
  return { method: "GET", url: new URL("checks/", base).toString(), headers: { accept: "application/json", "user-agent": userAgent, "x-api-key": apiKey }, body: null };
}

/** The times of a check of Healthchecks.io. */
export interface CheckTimes {
  /** The state of the check, for example `new`, `up` or `down`. */
  readonly status: string;
  /** The period of the check. */
  readonly timeout: Duration;
  readonly grace: Duration;
}

/**
 * This function finds the check of the ping URL in the answer of `checksRequest`. It gives a problem
 * when it finds no such check. A key that can only read gives no ping URL, thus it finds no check.
 * A problem names no URL and no key.
 */
export function checkOfPingUrl(body: string, url: string): { readonly ok: true; readonly check: CheckTimes } | { readonly ok: false; readonly problem: string } {
  let checks: unknown;
  try {
    checks = (JSON.parse(body) as { readonly checks?: unknown }).checks;
  } catch {
    return { ok: false, problem: "The answer of the management API is not valid JSON." };
  }
  if (!Array.isArray(checks)) return { ok: false, problem: "The answer of the management API has no list of checks." };
  const plain = (text: unknown): string | undefined => (typeof text === "string" ? text.replace(/\/+$/, "") : undefined);
  const records = checks.filter((entry: unknown): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
  const check = records.find((entry) => plain(entry["ping_url"]) === plain(url));
  if (check === undefined) return { ok: false, problem: "No check of the key has the ping URL of secrets.env. The key must be able to write, and the ping URL must be the URL with the id of the check." };
  const { timeout, grace, status } = check;
  if (typeof timeout !== "number" || typeof grace !== "number") return { ok: false, problem: "The check has a cron schedule. The heartbeat needs a check with a period." };
  return { ok: true, check: { status: typeof status === "string" ? status : "unknown", timeout: timeout * 1000, grace: grace * 1000 } };
}

/** This function gives the problem of the times of a check, or `undefined`. The period plus the grace must be `gap` or more. */
export function checkTimesProblem(check: CheckTimes, gap: Duration): string | undefined {
  const total = check.timeout + check.grace;
  return total >= gap ? undefined : `The period plus the grace of the check is ${total / 1000} s. The heartbeat needs ${Math.ceil(gap / 1000)} s or more.`;
}
