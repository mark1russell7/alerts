/**
 * This module holds the outside heartbeat. After each pass with no error, the runtime pings a check of
 * Healthchecks.io. When the pings stop, Healthchecks.io alerts the owner: the process stopped, the
 * computer stopped, or its network is down. A pass in which a channel refused a send pings `/fail`,
 * because then the system cannot tell the person itself.
 *
 * The ping URL is a secret. No ping body and no error text holds it. A ping body holds no place and no person.
 */
import type { Duration, HealthState, Instant, SourceId } from "@mark1russell7/alerts";
import type { WallClock } from "@mark1russell7/algebra/clock";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";

/** The kinds of a failed send that stop each delivery to the person until the owner acts. */
export const UNREACHABLE: readonly string[] = ["auth", "refused", "rate-limited"];

/** The time between two pings of the same kind. The period of the check is this time. */
export const HEARTBEAT_EVERY: Duration = 60_000;

/** The longest time of one ping. */
export const HEARTBEAT_LIMIT: Duration = 10_000;

/** The parts of a pass that the heartbeat reads. A `Pass` of the runtime has them. */
export interface PassSummary {
  readonly at: Instant;
  readonly view: { readonly health: readonly { readonly source: SourceId; readonly state: HealthState }[] };
  readonly delivery?: { readonly failures: readonly { readonly call: string; readonly channel: string; readonly kind: string }[] };
}

/** One ping: `success` goes to the ping URL, `fail` goes to the ping URL and `/fail`. */
export interface Ping {
  readonly kind: "success" | "fail";
  /** Healthchecks.io keeps this text with the ping. */
  readonly body: string;
}

/** The state of the heartbeat: the last ping that it started. */
export interface HeartbeatState {
  readonly last?: { readonly at: Instant; readonly kind: Ping["kind"] };
}

/**
 * This function gives the ping of a pass. A send that a channel refused gives `fail`, with the channel
 * and the kind. Else the ping is `success`, with the state of each source. No text of a failure goes
 * into the body, because it can quote a request.
 */
export function pingOf(pass: PassSummary): Ping {
  const refused = (pass.delivery?.failures ?? []).filter((failure) => failure.call === "send" && UNREACHABLE.includes(failure.kind));
  if (refused.length > 0) {
    const lines = [...new Set(refused.map((failure) => `The channel ${failure.channel} gave the kind ${failure.kind} to a send.`))].sort();
    return { kind: "fail", body: lines.join("\n") };
  }
  return { kind: "success", body: pass.view.health.map((health) => `${health.source}: ${health.state}`).join("\n") };
}

/**
 * This function adds one pass to the state of the heartbeat. A ping goes in four cases: no ping went
 * before, the kind changes, `every` passed after the last ping, or the wall clock stepped back.
 */
export function heartbeatStep(state: HeartbeatState, pass: PassSummary, every: Duration): { readonly state: HeartbeatState; readonly ping?: Ping } {
  const ping = pingOf(pass);
  const last = state.last;
  const due = last === undefined || last.kind !== ping.kind || pass.at - last.at >= every || pass.at < last.at;
  return due ? { state: { last: { at: pass.at, kind: ping.kind } }, ping } : { state };
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
 * is in flight. The hook throws no error.
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
  let state: HeartbeatState = {};
  let flight = false;
  return (pass) => {
    if (flight) return;
    const step = heartbeatStep(state, pass, every);
    if (step.ping === undefined) return;
    state = step.state;
    flight = true;
    const controller = new AbortController();
    const cancel = options.clock.after(limit, () => controller.abort());
    const kind = step.ping.kind;
    const request = { method: "POST" as const, headers: { "user-agent": options.userAgent, "content-type": "text/plain; charset=utf-8" }, body: step.ping.body, signal: controller.signal };
    Promise.resolve()
      .then(() => options.fetch(pingUrl(options.url, kind), request))
      .then(
        (response) => {
          if (response.status < 200 || response.status > 299) options.onError(`The ${kind} ping of the heartbeat got the status ${response.status}.`);
        },
        (error: unknown) => {
          // An error of a fetch can quote the URL. The redaction removes it.
          const cause = controller.signal.aborted ? `It took longer than ${limit} ms.` : redactSecrets(errorMessage(error), [options.url]);
          options.onError(`The ${kind} ping of the heartbeat failed. ${cause}`);
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
