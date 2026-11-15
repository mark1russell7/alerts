/**
 * The map from an answer of a server to a failure of a fetch. Each source of the alert system that
 * calls a server through polite-crawler uses this map.
 */

import type { FetchFailure } from "@mark1russell7/alerts";
import { statusLine, type Answer } from "polite-crawler/api";

/**
 * A reader of the problem text in the body of an answer that is not a success. It gives `undefined`
 * when the body has no such text.
 */
export type Detail = (body: string) => string | undefined;

/** The longest problem text in a message of a failure, in characters. */
export const MAX_DETAIL = 200;

/**
 * This function reads the text `detail` of a problem document (RFC 9457, earlier RFC 7807). The NWS
 * API sends one. A body that is not such a document gives `undefined`.
 */
export function problemDetail(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // The body is not JSON: the status line tells enough.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("detail" in parsed) || typeof parsed.detail !== "string") return undefined;
  return parsed.detail;
}

/**
 * This function gives the problem text of a body for a message. The text of a server is not safe:
 * the function changes each control character to a space and keeps `MAX_DETAIL` characters.
 */
function detailOf(body: string, detail: Detail | undefined): string | undefined {
  if (detail === undefined) return undefined;
  let text: string | undefined;
  try {
    text = detail(body);
  } catch {
    // A reader that throws gives no text. The status line still tells the failure.
    return undefined;
  }
  const clean = text?.replace(/\p{Cc}/gu, " ").trim().slice(0, MAX_DETAIL);
  return clean === "" ? undefined : clean;
}

/**
 * This function maps an answer that is not a success to a failure of a fetch. The message is the
 * status line of polite-crawler, and the problem text of `detail` when it finds one.
 *
 * - A 429 is `rate-limited`, with the wait that the server asked for.
 * - A 502, 503 or 504, and each other 5xx, is `server`.
 * - A 401 is `auth`. Each other refusal is `refused`.
 * - Each other outcome is `refused`, with the name of the outcome in the message.
 */
export function failureOf(answer: Answer, detail?: Detail): FetchFailure {
  const { reply, classified } = answer;
  const text = detailOf(reply.body, detail);
  const message = text === undefined ? statusLine(reply) : `${statusLine(reply)}: ${text}`;
  const retryAfter = classified.retryAfterMs === undefined ? {} : { retryAfter: classified.retryAfterMs };
  switch (classified.outcome) {
    case "rate-limited":
      return { kind: "rate-limited", message, ...retryAfter };
    case "unavailable":
      return { kind: "server", message, ...retryAfter };
    case "blocked":
      return reply.status === 401 ? { kind: "auth", message } : { kind: "refused", message };
    case "error":
      return reply.status >= 500 ? { kind: "server", message, ...retryAfter } : { kind: "refused", message };
    default:
      return { kind: "refused", message: `${message} (${classified.outcome})` };
  }
}
