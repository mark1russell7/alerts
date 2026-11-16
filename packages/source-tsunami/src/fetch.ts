/**
 * The fetch function of the tsunami source. It asks `www.tsunami.gov` for the latest CAP message of one center, through
 * polite-crawler. The file is a fixed URL, so a request names no place of the watch.
 *
 * The file holds only the latest message. A later message of the center replaces it. A message that the center
 * replaces in less than one interval is not seen. A later bulletin of an event has each block that is in effect, and
 * it references the earlier bulletins. So the reports stay correct, but the source loses the time of the lost message.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { splitFeed } from "@mark1russell7/alerts-format-cap";
import type { Condition, Pace, Reply, Transport } from "polite-crawler/api";

import type { TsunamiCenter } from "./centers.ts";

/** The base URL of the site of the tsunami warning centers. */
export const TSUNAMI_BASE_URL = "https://www.tsunami.gov";

/** The options of the fetch function of the tsunami source. */
export interface TsunamiFetchOptions {
  /** The center of the source. */
  readonly center: TsunamiCenter;
  /** The pace of polite-crawler: the host scheduler and the clock. The two centers share one host. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `TSUNAMI_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface TsunamiFetchInput {
  readonly watch: Watch;
}

/** This function gives the observation of one answer: its whole body, with the validators of the answer. */
export function observationOf(center: TsunamiCenter, reply: Reply, url: string, fetched: Instant, latency: number): Observation {
  const contentType = reply.headers["content-type"] ?? "text/xml";
  const etag = reply.headers["etag"];
  const lastModified = reply.headers["last-modified"];
  return {
    id: observationId({ source: center.id, contentType, url, body: reply.body }),
    source: center.id,
    fetched,
    contentType,
    body: reply.body,
    transport: {
      url,
      status: reply.status,
      latency,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
    },
  };
}

/**
 * This function makes the fetch function of the source of one center. The fetch does not throw for a failure of the
 * source: it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) of the file of the center, with the `Last-Modified`
 * time of the last full answer. The source is a stream. A 304 answer tells that the message did not change, so the
 * fetch gives no observation. A full answer gives one observation. The fetch gives no cursor.
 *
 * A cut with no framing can look whole to the HTTP client. So a body whose root element does not end (`splitFeed`)
 * fails the fetch. A whole document that is not CAP gives one observation, and the map tells of the change.
 */
export function createTsunamiFetch(options: TsunamiFetchOptions): (input: TsunamiFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const { center } = options;
  const requester = createRequester({
    source: center.id,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? TSUNAMI_BASE_URL,
    headers: { accept: "application/cap+xml, application/xml, text/xml", "user-agent": options.userAgent },
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = options.pace.now;
  const conditions = new Map<string, Condition>();
  let answered = false;

  return async (_input, signal) => {
    const requested = await requester.get({ path: center.path, what: `the latest message of ${center.name}`, conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      if (answered) return { ok: true, observations: [], complete: true };
      // A 304 with no earlier full answer: the next request sends no condition
      conditions.delete(url);
      return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` } };
    }
    if (!splitFeed(answer.reply.body).whole) {
      // poll keeps the condition of each 2xx answer. A cut body must not be the base of a later 304.
      conditions.delete(url);
      answered = false;
      return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    }
    answered = true;
    return { ok: true, observations: [observationOf(center, answer.reply, url, now(), latency)], complete: true };
  };
}
