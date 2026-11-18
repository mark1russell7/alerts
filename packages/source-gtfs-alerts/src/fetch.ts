/**
 * The fetch function of a GTFS Realtime feed of service alerts. It reads the feed through polite-crawler as bytes, and
 * decodes the protobuf message. The request holds no place and no query of its own.
 *
 * The feed is a snapshot. Each fetch gives one census of the feed and one observation for each alert that has not ended.
 * The body of an alert holds no time of the fetch. Thus an alert with no change gives the same observation again, and
 * the log keeps it one time. A differential feed lists only the changes, so its list is not complete.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import type { Condition, Pace, Transport } from "polite-crawler/api";

import { sourceIdOf, type GtfsFeed } from "./feed.ts";
import { alertText, censusText, ended, inEffect, NO_SERVICE } from "./map.ts";
import { decodeFeed, type FeedMessage } from "./proto.ts";

/** The longest time of one request when the source gives none, in milliseconds. */
export const FEED_TIMEOUT_MS = 30_000;

/** The media type of each observation. The fetch gives JSON that it makes from the decoded feed. */
export const BODY_TYPE = "application/json";

/** The value of the incrementality `DIFFERENTIAL` in the GTFS Realtime reference. */
export const DIFFERENTIAL = 1;

/** The options of the fetch function of a feed. */
export interface GtfsFetchOptions {
  /** The config of the feed. */
  readonly feed: GtfsFeed;
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `FEED_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface GtfsFetchInput {
  readonly watch: Watch;
}

/** The bodies of one decoded feed, and the time of its data. */
export interface FeedBodies {
  /** The body of the census, then the body of each alert that has not ended. */
  readonly bodies: readonly string[];
  /** False for a differential feed: its list holds only the changes. */
  readonly complete: boolean;
  /** The time of the feed, from its header. */
  readonly asOf?: Instant;
}

/**
 * This function gives the bodies of one decoded feed at the time of a fetch. The census counts the alerts in effect at
 * the time of the feed. An entity that the feed deletes, or that has no alert, gives no body.
 */
export function feedBodies(feed: Pick<GtfsFeed, "id">, message: FeedMessage, fetched: Instant): FeedBodies {
  const seconds = message.header?.timestamp;
  const asOf = seconds === undefined || seconds <= 0 ? undefined : seconds * 1000;
  const at = asOf ?? fetched;
  const entities = message.entity ?? [];
  const alerts = entities.filter((entity) => entity.isDeleted !== true && entity.alert !== undefined);
  const active = alerts.filter((entity) => inEffect(entity.alert!, at));
  const census = censusText({
    feed: feed.id,
    at: new Date(at).toISOString(),
    entities: entities.length,
    alerts: alerts.length,
    active: active.length,
    noService: active.filter((entity) => entity.alert!.effect === NO_SERVICE).length,
  });
  const open = alerts.filter((entity) => !ended(entity.alert!, fetched));
  const bodies = [...new Set([census, ...open.map((entity) => alertText(feed.id, entity.id ?? "", entity.alert!))])];
  return { bodies, complete: message.header?.incrementality !== DIFFERENTIAL, ...(asOf === undefined ? {} : { asOf }) };
}

/** This function decodes the bytes of a feed, or gives `undefined` for bytes that are not a feed. */
function decodeOrUndefined(bytes: Uint8Array): FeedMessage | undefined {
  try {
    return decodeFeed(bytes);
  } catch {
    return undefined;
  }
}

/**
 * This function makes the fetch function of a feed. The fetch does not throw for a failure of the source: it gives
 * `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) of the feed, with the `ETag` or `Last-Modified` of the
 * last full answer. A 304 answer has no body. Then the fetch decodes the bytes of the last full answer again.
 */
export function createGtfsFetch(options: GtfsFetchOptions): (input: GtfsFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const { feed } = options;
  const source = sourceIdOf(feed);
  const target = new URL(feed.url);
  const path = `${target.pathname}${target.search}`;
  // A failure text names the feed with no query: a query can hold a key.
  const shown = `${target.origin}${target.pathname}`;
  const requester = createRequester({
    source,
    pace: options.pace,
    transport: options.transport,
    baseUrl: target.origin,
    headers: { accept: "application/x-protobuf, application/octet-stream;q=0.9", "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? FEED_TIMEOUT_MS,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });
  const now = options.pace.now;
  const conditions = new Map<string, Condition>();
  let last: { readonly url: string; readonly message: FeedMessage } | undefined;

  const outcomeOf = (url: string, status: number, message: FeedMessage, latency: number): FetchOutcome => {
    const fetched = now();
    const transport = { url, status, latency };
    const { bodies, complete, asOf } = feedBodies(feed, message, fetched);
    const observations: Observation[] = bodies.map((body) => ({
      id: observationId({ source, contentType: BODY_TYPE, url: `${requester.baseUrl}${path}`, body }),
      source,
      fetched,
      contentType: BODY_TYPE,
      body,
      transport,
    }));
    return { ok: true, observations, complete, ...(asOf === undefined ? {} : { asOf }) };
  };

  return async (_input, signal) => {
    const requested = await requester.get({ path, what: "the service alerts of the transit feed", conditions, read: "bytes" }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    if (answer.classified.outcome === "not-modified") {
      if (last === undefined || last.url !== url) {
        // A 304 with no earlier full answer: the next request sends no condition
        conditions.delete(url);
        return { ok: false, failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${shown}` } };
      }
      return outcomeOf(url, 304, last.message, latency);
    }
    const bytes = answer.reply.bytes;
    const message = bytes === undefined ? undefined : decodeOrUndefined(bytes);
    if (message === undefined) {
      // poll keeps the condition of each 2xx answer. Bytes that do not decode must not be the base of a later 304.
      conditions.delete(url);
      last = undefined;
      return { ok: false, failure: { kind: "network", message: `the answer is not a GTFS Realtime feed: ${shown}` } };
    }
    last = { url, message };
    return outcomeOf(url, answer.reply.status, message, latency);
  };
}
