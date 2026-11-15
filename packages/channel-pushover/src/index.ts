/**
 * The Pushover channel of the alert system. It gives the procedures of the channel contract of
 * `@mark1russell7/alerts`: `describe`, `send`, `status` and `cancel`. The calls of the Pushover API
 * come from `@procedures/notify/pushover`.
 */

import type { ChannelDescriptor, ChannelId, ChannelProcedures, Instant, SendOutcome } from "@mark1russell7/alerts";
import {
  callPushover,
  extractPushoverCancelled,
  extractPushoverReceipt,
  extractPushoverSent,
  PUSHOVER_KEY,
  PUSHOVER_LIMITS,
  pushoverCancelRequest,
  pushoverReceiptRequest,
  type PushoverFailure,
  type PushoverFetch,
  type PushoverRequest,
  type PushoverResponse,
  pushoverSendRequest,
} from "@procedures/notify/pushover";
import { type PushoverMapOptions, pushoverMessageOf, sendFailureOf, statusOf } from "./map.ts";

export { cut, priorityOf, pushoverMessageOf, sendFailureOf, statusOf } from "./map.ts";
export type { PushoverMapOptions, Refusal } from "./map.ts";

/** The id of the channel. */
export const CHANNEL_ID = "pushover" as ChannelId;

/** The options of the Pushover channel. */
export interface PushoverChannelOptions extends PushoverMapOptions {
  /** The API token of the application. The private configuration gives it at run time. */
  readonly token: string;
  /**
   * The fetch of each call. The runtime gives `withQuota(gate, fetch)` of `polite-crawler/api`, with a
   * cost of 1 for `/messages.json` and 0 for the other calls. Thus the channel cannot send more
   * messages than the monthly limit of the application.
   */
  readonly fetch: PushoverFetch;
  /** The platform of the device of the person. It adds the push service of the platform to `dependsOn`. */
  readonly platform?: "ios" | "android" | undefined;
  /** The time limit of one call. The default is 10 seconds. */
  readonly timeoutMs?: number | undefined;
  /** This function gives the time in milliseconds since the epoch. The default is `Date.now`. */
  readonly now?: (() => Instant) | undefined;
}

/** The refusal of a quota, as `QuotaError` of `polite-crawler/api` gives it. */
interface QuotaRefusal {
  readonly message: string;
  readonly resetAt: number;
}

/**
 * This function tells if an error of the fetch is a `QuotaError` of `polite-crawler/api`. It reads
 * the fields of the error, its name and `resetAt`. A test with `instanceof` fails when two copies of
 * the package exist.
 */
export function isQuotaRefusal(error: unknown): error is QuotaRefusal {
  return error instanceof Error && error.name === "QuotaError" && typeof (error as { resetAt?: unknown }).resetAt === "number";
}

/** This function gives the descriptor of the channel for a platform. */
export function pushoverDescriptor(platform?: "ios" | "android"): ChannelDescriptor {
  const push = platform === "ios" ? ["provider:apns"] : platform === "android" ? ["provider:fcm"] : [];
  return {
    id: CHANNEL_ID,
    title: "Pushover",
    dependsOn: ["provider:pushover", ...push],
    uses: ["internet", "power"],
    // A `life-safety` message at priority 2 sounds through silent mode with the Critical Alerts of the app.
    breaksThrough: true,
    repeats: true,
    ack: "poll",
    maxTitle: PUSHOVER_LIMITS.title,
    maxBody: PUSHOVER_LIMITS.message,
  };
}

/**
 * This function makes the procedures of the Pushover channel.
 *
 * - `send` does not throw. A refusal of the quota is a failure of the kind `rate-limited`, thus the escalation goes to its next step.
 * - `status` does not throw. A receipt that the channel cannot read keeps the state `accepted`.
 * - `cancel` throws when Pushover does not stop the repeats, thus the caller can try again.
 */
export function createPushoverChannel(options: PushoverChannelOptions): ChannelProcedures {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const descriptor = pushoverDescriptor(options.platform);

  /** One call. A refusal of the quota stops the call before Pushover counts it. */
  const call = async <Result>(request: PushoverRequest, extract: (response: PushoverResponse) => Result | PushoverFailure) => {
    let quota: QuotaRefusal | undefined;
    const guarded: PushoverFetch = async (url, init) => {
      try {
        return await options.fetch(url, init);
      } catch (error) {
        if (isQuotaRefusal(error)) quota = error;
        throw error;
      }
    };
    const result = await callPushover(guarded, request, extract, { timeoutMs });
    return { result, quota };
  };

  return {
    describe: () => descriptor,

    async send({ message, address }): Promise<SendOutcome> {
      const at = now();
      if (!PUSHOVER_KEY.test(options.token)) return { ok: false, kind: "auth", message: "The API token is not 30 letters and digits." };
      const mapped = pushoverMessageOf(message, address, at, options);
      if ("refused" in mapped) return { ok: false, kind: "refused", message: mapped.refused };
      let request: PushoverRequest;
      try {
        request = pushoverSendRequest(options.token, mapped);
      } catch (error) {
        return { ok: false, kind: "refused", message: error instanceof Error ? error.message : "The message breaks a rule of the Pushover API." };
      }
      const { result, quota } = await call(request, extractPushoverSent);
      if (quota !== undefined) return { ok: false, kind: "rate-limited", message: quota.message, retryAfter: Math.max(0, quota.resetAt - at) };
      if (!result.ok) return sendFailureOf(result, at);
      return { ok: true, receipt: { request: result.request, ...(result.receipt === undefined ? {} : { receipt: result.receipt }) }, accepted: at };
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
      const { result } = await call(request, extractPushoverReceipt);
      if (!result.ok) return { state: "accepted", at, reason: `The receipt was not read: ${result.errors.join(" ")}` };
      return statusOf(result, at);
    },

    async cancel({ receipt }) {
      const id = receipt["receipt"];
      // A message below priority 2 does not repeat, thus nothing stops.
      if (id === undefined) return;
      const { result } = await call(pushoverCancelRequest(options.token, id), extractPushoverCancelled);
      if (!result.ok) throw new Error(`Pushover did not stop the repeats (${result.kind}): ${result.errors.join(" ")}`);
    },
  };
}
