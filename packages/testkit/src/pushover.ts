/**
 * This module holds a scripted Pushover API for the fault suite. It stands on the scripted server of
 * `@mark1russell7/rigor-testkit/http`, thus a fault proxy can stand between the channel and the API.
 *
 * - Each send gets the next receipt of a list, with the emergency priority.
 * - Each read of a receipt tells that the person acknowledged the message. Thus the person acknowledges each message that the system reads.
 * - Each cancel, by receipt or by tag, succeeds.
 *
 * The ledger of a run comes from the records of the requests that the server read whole. A message that the server
 * read is a message that Pushover accepted, also when its answer did not get to the channel.
 *
 * The home of a fake of the Pushover API is `@procedures/notify`, next to its request builders. This module moves
 * there when notify has one. The request went to the owner of `@procedures/notify` on 2026-11-15.
 */
import type { ScriptedRequest, ScriptedRoute, ScriptedServerOptions } from "@mark1russell7/rigor-testkit/http";

/** The path of the API version, as the request builders of `@procedures/notify/pushover` write it. */
const API = "/1";

/** The receipt of the send at `index`: 30 letters and digits, as the Pushover API gives them. */
export function receiptOf(index: number): string {
  return `rcpt${String(index).padStart(26, "0")}`;
}

/**
 * This function gives the routes of the scripted Pushover API, with `receipts` receipts. A send after the last
 * receipt gets the last receipt again, thus the case stops before that.
 */
export function pushoverApi(receipts: number): ScriptedServerOptions {
  const json = (body: object) => ({ fields: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ids = Array.from({ length: receipts }, (_, index) => receiptOf(index));
  const routes: ScriptedRoute[] = [
    {
      method: "POST",
      path: `${API}/messages.json`,
      replies: ids.map((receipt, index) => json({ status: 1, request: `send-${String(index)}`, receipt })),
    },
    ...ids.flatMap((receipt): ScriptedRoute[] => [
      {
        method: "GET",
        path: `${API}/receipts/${receipt}.json`,
        // The times are 0: Pushover gives 0 for a time that did not occur, thus the channel takes the time of its read.
        replies: [json({ status: 1, request: `read-${receipt}`, acknowledged: 1, acknowledged_at: 0, last_delivered_at: 0, expired: 0, expires_at: 4102444800, called_back: 0, called_back_at: 0 })],
      },
      { method: "POST", path: `${API}/receipts/${receipt}/cancel.json`, replies: [json({ status: 1, request: `cancel-${receipt}` })] },
    ]),
  ];
  // A cancel by tag has the tag in its path. The script cannot know the tags, thus each other request gets a success.
  return { routes, unmatched: json({ status: 1, request: "other", canceled: 1 }) };
}

/** One message that the scripted API accepted. Each position is the place of a request in the records of the server. */
export interface AcceptedMessage {
  readonly receipt: string;
  /** The first tag of the message. The Pushover channel tags a `life-safety` message with its delivery key. */
  readonly tag?: string;
  /** The position of the send. */
  readonly position: number;
  /** The connection of the send, as the server numbers them. */
  readonly connection: number;
  /** The position of the first read of the receipt. The person acknowledged the message at this read. */
  readonly readAt?: number;
  /** The position of the first cancel that reached the message: a cancel of its receipt, or a cancel of its tag after the send. */
  readonly cancelledAt?: number;
}

/** What the scripted API got in one run. */
export interface PushoverLedger {
  readonly messages: readonly AcceptedMessage[];
  /** The count of each kind of request. */
  readonly counts: { readonly sends: number; readonly reads: number; readonly cancels: number; readonly tagCancels: number; readonly other: number };
}

const SEND = `${API}/messages.json`;
const READ = /^\/1\/receipts\/([A-Za-z0-9]{30})\.json$/;
const CANCEL = /^\/1\/receipts\/([A-Za-z0-9]{30})\/cancel\.json$/;
const TAG_CANCEL = /^\/1\/receipts\/cancel_by_tag\/([^/]+)\.json$/;

/** This function gives the ledger of the records of a scripted Pushover API. */
export function ledgerOf(requests: readonly ScriptedRequest[]): PushoverLedger {
  const sends: { receipt: string; tag?: string; position: number; connection: number }[] = [];
  const reads = new Map<string, number>();
  const cancels: { position: number; receipt?: string; tag?: string }[] = [];
  let other = 0;
  let tagCancels = 0;
  let readCount = 0;
  for (const [position, request] of requests.entries()) {
    const path = request.target.split("?")[0] ?? "";
    if (request.method === "POST" && path === SEND && request.reply >= 0) {
      const tag = new URLSearchParams(request.body).get("tags")?.split(",")[0];
      sends.push({ receipt: receiptOf(request.reply), position, connection: request.connection, ...(tag === undefined || tag === "" ? {} : { tag }) });
      continue;
    }
    const read = request.method === "GET" ? READ.exec(path) : null;
    if (read !== null) {
      readCount += 1;
      if (!reads.has(read[1]!)) reads.set(read[1]!, position);
      continue;
    }
    const cancel = request.method === "POST" ? CANCEL.exec(path) : null;
    if (cancel !== null) {
      cancels.push({ position, receipt: cancel[1]! });
      continue;
    }
    const byTag = request.method === "POST" ? TAG_CANCEL.exec(path) : null;
    if (byTag !== null) {
      tagCancels += 1;
      cancels.push({ position, tag: decodeURIComponent(byTag[1]!) });
      continue;
    }
    other += 1;
  }
  const messages = sends.map((send): AcceptedMessage => {
    const readAt = reads.get(send.receipt);
    const cancelledAt = cancels.find((c) => c.position > send.position && (c.receipt === send.receipt || (c.tag !== undefined && c.tag === send.tag)))?.position;
    return { ...send, ...(readAt === undefined ? {} : { readAt }), ...(cancelledAt === undefined ? {} : { cancelledAt }) };
  });
  return {
    messages,
    counts: { sends: sends.length, reads: readCount, cancels: cancels.length - tagCancels, tagCancels, other },
  };
}
