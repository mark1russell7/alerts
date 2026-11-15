/**
 * This module maps a `Message` of the core to a Pushover message. It also maps the answers of
 * Pushover to the outcomes of the channel contract. Each function here is pure.
 */

import type { Address, DeliveryStatus, Instant, Level, Message, SendOutcome } from "@mark1russell7/alerts";
import {
  PUSHOVER_EXPIRE_MAX_MS,
  PUSHOVER_LIMITS,
  PUSHOVER_RETRY_MIN_MS,
  type PushoverFailure,
  type PushoverMessage,
  type PushoverPriority,
  type PushoverReceipt,
} from "@procedures/notify/pushover";

/** The repeats of a `life-safety` message, and the sound of each level. */
export interface PushoverMapOptions {
  /** The time between two repeats of a `life-safety` message. The default and the minimum is 30 seconds. */
  readonly retryMs?: number | undefined;
  /** The time after which the repeats stop. The default and the maximum is 3 hours. An earlier `Message.expires` stops them earlier. */
  readonly expireMs?: number | undefined;
  /** The name of a Pushover sound for each level. Without a name, the device plays the sound that the person chose. */
  readonly sounds?: Partial<Readonly<Record<Level, string>>> | undefined;
}

/**
 * This function gives the priority of a message.
 *
 * - `life-safety`: `2`, the emergency priority. It repeats until the person acknowledges it. It is not quiet at any time.
 * - `urgent`: `1`, or `-1` when the message is quiet.
 * - `notice`: `0`, or `-1` when the message is quiet.
 * - `digest`: `-1`.
 */
export function priorityOf(level: Level, quiet: boolean): PushoverPriority {
  if (level === "life-safety") return 2;
  if (quiet || level === "digest") return -1;
  return level === "urgent" ? 1 : 0;
}

/**
 * This function cuts a text to `max` code points, as Pushover counts them. A cut text ends with an
 * ellipsis.
 *
 * The home of truncation is `@mark1russell7/text`, in its roadmap item X5. This function moves to
 * it after the npm release of X5. Until then, the channel keeps it.
 */
export function cut(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** A message that the channel does not send, with the reason. */
export interface Refusal {
  readonly refused: string;
}

/**
 * This function gives the Pushover message of a message of the core to an address. It gives a
 * refusal when the address has no user key, or when the message expired before `at`.
 *
 * - The address has the field `user`, and the optional field `device`.
 * - A title or a body over the limit of Pushover gets a cut. A URL over the limit is not sent, because a cut URL is broken.
 * - The delivery key is the first tag of a `life-safety` message. Thus a cancel by tag stops its repeats.
 * - The copy id of the send is its second tag. Thus a cancel by the copy id stops this copy only.
 */
export function pushoverMessageOf(message: Message, address: Address, at: Instant, options: PushoverMapOptions = {}, copy?: string): PushoverMessage | Refusal {
  const user = address["user"];
  if (user === undefined || user === "") return { refused: "The address has no user key." };
  if (message.expires !== undefined && message.expires <= at) return { refused: "The message expired before the send." };
  const priority = priorityOf(message.level, message.quiet);
  const title = cut(message.title, PUSHOVER_LIMITS.title);
  const body = message.body.trim() === "" ? title : cut(message.body, PUSHOVER_LIMITS.message);
  const left = message.expires === undefined ? Number.POSITIVE_INFINITY : message.expires - at;
  const device = address["device"];
  const sound = options.sounds?.[message.level];
  const url = message.url !== undefined && [...message.url].length <= PUSHOVER_LIMITS.url ? message.url : undefined;
  const retryMs = Math.max(PUSHOVER_RETRY_MIN_MS, options.retryMs ?? PUSHOVER_RETRY_MIN_MS);
  return {
    user,
    message: body,
    title,
    priority,
    ...(url === undefined ? {} : { url }),
    ...(device === undefined || device === "" ? {} : { devices: [device] }),
    ...(sound === undefined ? {} : { sound }),
    ...(priority === 2
      ? { emergency: { retryMs, expireMs: Math.max(retryMs, Math.min(PUSHOVER_EXPIRE_MAX_MS, options.expireMs ?? PUSHOVER_EXPIRE_MAX_MS, left)), tags: copy === undefined ? [message.key] : [message.key, copy] } }
      : left >= 1000 && Number.isFinite(left)
        ? { ttlMs: left }
        : {}),
  };
}

/** A send that failed: the kind of the failure of Pushover, its errors and its wait. */
export function sendFailureOf(failure: PushoverFailure, at: Instant): SendOutcome {
  const wait = failure.retryAfterMs ?? (failure.resetAt === undefined ? undefined : Math.max(0, failure.resetAt - at));
  return { ok: false, kind: failure.kind, message: failure.errors.join(" "), ...(wait === undefined ? {} : { retryAfter: wait }) };
}

/**
 * This function gives the state of a message from its receipt. Only an acknowledgment proves that
 * the person got the message. The time of the last repeat (`lastDeliveredAt`) is not a proof, thus
 * the state stays `accepted` until the person acknowledges or the repeats stop.
 */
export function statusOf(receipt: PushoverReceipt, at: Instant): DeliveryStatus {
  if (receipt.acknowledged) {
    return { state: "acknowledged", at: receipt.acknowledgedAt ?? at, ...(receipt.acknowledgedByDevice === undefined ? {} : { by: receipt.acknowledgedByDevice }) };
  }
  if (receipt.expired) return { state: "expired", at: receipt.expiresAt, reason: "The repeats stopped, and nobody acknowledged the message." };
  return { state: "accepted", at };
}
