/**
 * The Pushover channel of the alert system. It gives the procedures of the channel contract of
 * `@mark1russell7/alerts`: `describe`, `send`, `status` and `cancel`. The calls of the Pushover API
 * come from `@procedures/notify/pushover`.
 */

import { COPY_ID, type ChannelDescriptor, type ChannelId, type ChannelProcedures, type Instant, type SendOutcome } from "@mark1russell7/alerts";
import { isQuotaError, type QuotaError } from "polite-crawler/api";
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
  pushoverSendRequest,
} from "@procedures/notify/pushover";
import { type PushoverMapOptions, pushoverMessageOf, sendFailureOf, statusOf } from "./map.ts";

export { priorityOf, pushoverMessageOf, sendFailureOf, statusOf } from "./map.ts";
export type { PushoverMapOptions, Refusal } from "./map.ts";

/** The time limit of one call when the options give none, in milliseconds. */
export const PUSHOVER_TIMEOUT_MS = 10_000;

/** The time between two repeats of a `life-safety` message when the options give none, in milliseconds. It is also the minimum. */
export const PUSHOVER_REPEAT_MS: number = PUSHOVER_RETRY_MIN_MS;

/** The id of the channel. */
export const CHANNEL_ID = "pushover" as ChannelId;

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
  /**
   * The fetch of each call. A fetch with a gate, for example `withQuota(gate, fetch)` of
   * `polite-crawler/api`, can refuse a call over the quota. The channel then gives `rate-limited`, with
   * the reset of the quota as the retry.
   */
  readonly fetch: PushoverFetch;
  /** The platform of the device of the person. It adds the push service of the platform to `dependsOn`. */
  readonly platform?: "ios" | "android" | undefined;
  /** The time limit of one call. The default is 10 seconds. */
  readonly timeoutMs?: number | undefined;
  /** This function gives the time in milliseconds since the epoch. The default is `Date.now`. */
  readonly now?: (() => Instant) | undefined;
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
 * - `cancel` stops the repeats by the tag of the receipt: the delivery key. Thus it also stops a copy of a send whose receipt the log does not have. A receipt with no tag stops by its id.
 * - `cancel({ copy })` stops one copy by its copy id, the second tag of the message. The other copies of the key continue.
 * - `cancel` is idempotent. A cancel that Pushover refuses ends without an error, because Pushover does not know the receipt (it keeps a receipt for one week). Thus no repeats continue.
 * - `cancel` throws for each other failure, thus the caller can try again. A request that Pushover refused does not go again, because many refusals can block the address of the caller.
 */
export function createPushoverChannel(options: PushoverChannelOptions): ChannelProcedures {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? PUSHOVER_TIMEOUT_MS;
  const descriptor = pushoverDescriptor(options.platform);

  /** One call. A refusal of the quota stops the call before Pushover counts it. */
  const call = async <Result>(request: PushoverRequest, extract: (response: PushoverResponse) => Result | PushoverFailure) => {
    let quota: QuotaError | undefined;
    const guarded: PushoverFetch = async (url, init) => {
      try {
        return await options.fetch(url, init);
      } catch (error) {
        if (isQuotaError(error)) quota = error;
        throw error;
      }
    };
    const result = await callPushover(guarded, request, extract, { timeoutMs });
    return { result, quota };
  };

  return {
    describe: () => descriptor,

    async send({ message, address, copy }): Promise<SendOutcome> {
      if (copy !== undefined && !COPY_ID.test(copy)) return { ok: false, kind: "refused", message: `The copy id "${copy}" has a character that the path of a stop cannot have.` };
      const at = now();
      if (!isPushoverKey(options.token)) return { ok: false, kind: "auth", message: "The API token is not 30 letters and digits." };
      const mapped = pushoverMessageOf(message, address, at, options, copy);
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
      const { result } = await call(request, extractPushoverReceipt);
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
      const { result } = await call(request, extractPushoverCancelled);
      // A refusal tells that Pushover does not know the receipt: it is old, or it is not of this application. Nothing repeats under it.
      if (!result.ok && result.kind !== "refused") throw new Error(`Pushover did not stop the repeats (${result.kind}): ${result.errors.join(" ")}`);
    },
  };
}
