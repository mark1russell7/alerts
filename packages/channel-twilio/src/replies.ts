/**
 * The read of the keyword replies to the Twilio number of the texts (AL-56). A STOP reply removes the number from the
 * opt-in of the texts, and a START reply puts it back. Twilio keeps its own STOP block too: it refuses each text to a
 * number that replied STOP.
 *
 * - The read gives the changes of all the replies from a time, not only the new ones. Thus the runtime keeps no state
 *   of the replies, and a restart reads them again.
 * - The read uses the default keywords of Twilio (`twilioOptOutKeyword`). A HELP reply and each other text change nothing.
 * - A read that cannot read each page is a failure, not a part of the list. A part of the list can miss a STOP.
 * - No failure holds the number of the texts.
 */

import type { Instant, OptInChange } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import {
  callTwilio,
  extractTwilioMessages,
  TWILIO_LIMITS,
  twilioMessageListRequest,
  twilioNextPageRequest,
  twilioOptOutKeyword,
  type TwilioCredentials,
  type TwilioFetch,
  type TwilioMessage,
  type TwilioRequest,
} from "@procedures/notify/twilio";
import { callFailureOf } from "./map.ts";

/** The time limit of one page of the read of the replies. */
export const TWILIO_REPLIES_TIMEOUT_MS = 10_000;

/** The most pages of one read of the replies. Each page has at most `TWILIO_LIMITS.pageSize` texts. */
export const TWILIO_REPLIES_PAGE_LIMIT = 20;

/** The options of the read of the replies. */
export interface TwilioRepliesOptions {
  readonly credentials: TwilioCredentials;
  readonly fetch: TwilioFetch;
  /** The Twilio number of the texts, in E.164 form: the recipient of the replies. */
  readonly to: string;
  /** The read gives only the replies at this time or later. Give the time of the first record of the opt-in list. */
  readonly since: Instant;
  /** The time limit of one page. The default is `TWILIO_REPLIES_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** The most pages of one read. The default is `TWILIO_REPLIES_PAGE_LIMIT`. */
  readonly pageLimit?: number;
}

/** The result of a read of the replies: the changes of the opt-in, the oldest first, or the reason of the failure. */
export type TwilioRepliesReading = { readonly ok: true; readonly changes: readonly OptInChange[] } | { readonly ok: false; readonly message: string };

/**
 * This function gives the change of the opt-in of one text, or `undefined`. Only a received text from a number, with
 * a time and the body of a STOP or a START keyword, changes the opt-in.
 */
export function optInChangeOf(message: TwilioMessage): OptInChange | undefined {
  if (message.direction !== "inbound" || message.from === undefined || message.dateSent === undefined) return undefined;
  const keyword = twilioOptOutKeyword(message.body);
  return keyword === "stop" || keyword === "start" ? { number: message.from, kind: keyword, at: message.dateSent } : undefined;
}

/**
 * This function reads the replies to the Twilio number of the texts from the time `since`, and gives the changes of
 * the opt-in. It reads each page of the list, up to the page limit. At the abort of the signal, it stops and throws.
 */
export async function readTwilioReplies(options: TwilioRepliesOptions, signal?: AbortSignal): Promise<TwilioRepliesReading> {
  const pageLimit = options.pageLimit ?? TWILIO_REPLIES_PAGE_LIMIT;
  const timeoutMs = options.timeoutMs ?? TWILIO_REPLIES_TIMEOUT_MS;
  const marked = [options.to];
  let request: TwilioRequest;
  try {
    request = twilioMessageListRequest(options.credentials, { to: options.to, dateSentAfter: options.since, pageSize: TWILIO_LIMITS.pageSize });
  } catch (error) {
    return { ok: false, message: `The read of the replies has no valid request: ${errorMessage(error)}` };
  }
  const changes: OptInChange[] = [];
  for (let page = 1; ; page++) {
    const result = await callTwilio(options.fetch, request, extractTwilioMessages, signal === undefined ? { timeoutMs } : { timeoutMs, signal });
    if (!result.ok) return { ok: false, message: `Twilio did not give page ${String(page)} of the replies (${result.kind}): ${callFailureOf(result, marked).message}` };
    for (const message of result.messages) {
      const change = optInChangeOf(message);
      if (change !== undefined && change.at >= options.since) changes.push(change);
    }
    if (result.nextPageUri === undefined) break;
    if (page >= pageLimit) return { ok: false, message: `The replies have more than ${String(pageLimit)} pages. The read gives no part of the list.` };
    try {
      request = twilioNextPageRequest(options.credentials, result.nextPageUri);
    } catch (error) {
      return { ok: false, message: `The next page of the replies is not valid: ${errorMessage(error)}` };
    }
  }
  return { ok: true, changes: changes.sort((first, second) => first.at - second.at) };
}
