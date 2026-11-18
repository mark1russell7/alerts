/**
 * The fetch function of the feed of Azure Status. It reads the RSS feed through polite-crawler. The request holds no
 * place and no query.
 *
 * The source is a snapshot. The feed holds one item for each incident that has not ended. Each item gives one body. An
 * incident that ends leaves the feed, and thus the list.
 */

import { observationId, type FetchOutcome, type FetchSignal, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { readFeed, type FeedEntry } from "@mark1russell7/alerts-format-cap";
import type { Pace, Transport } from "polite-crawler/api";

import { AZURE_BASE, AZURE_SOURCE, FEED_PATH } from "./feed.ts";

/** The longest time of one request when the source gives none, in milliseconds. */
export const FEED_TIMEOUT_MS = 30_000;

/** The media type of each observation: the fetch gives each incident as JSON. */
export const INCIDENT_CONTENT_TYPE = "application/json";

/** The options of the fetch function of the feed. */
export interface AzureFetchOptions {
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
export interface AzureFetchInput {
  readonly watch: Watch;
}

/** The incidents of one feed. */
export interface Incidents {
  /** The body of each item, in the order of the feed. An item with no `guid` gives its own body, with no key. */
  readonly bodies: readonly string[];
  /** True: each item has a `guid`. */
  readonly complete: boolean;
}

/** This function gives the body of one item with a `guid`: its key, its title, its link, its time, its categories and its text. */
function incidentBody(key: string, entry: FeedEntry): string {
  return JSON.stringify({
    key,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.link === undefined ? {} : { link: entry.link }),
    ...(entry.updated === undefined ? {} : { published: entry.updated }),
    categories: entry.categories ?? [],
    ...(entry.summary === undefined ? {} : { description: entry.summary }),
  });
}

/**
 * This function gives the bodies of the items of a feed: one body for each `guid`. Two equal `guid` values give one
 * body, the first. An item with no `guid` gives its own body with no key, and `complete` false. Then the map tells of the change.
 */
export function incidentBodies(entries: readonly FeedEntry[]): Incidents {
  const seen = new Set<string>();
  const bodies: string[] = [];
  let complete = true;
  for (const entry of entries) {
    if (entry.id === undefined) {
      bodies.push(JSON.stringify(entry));
      complete = false;
      continue;
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    bodies.push(incidentBody(entry.id, entry));
  }
  return { bodies, complete };
}

/**
 * This function makes the fetch function of the feed. The fetch does not throw for a failure of the source: it gives
 * `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one GET. The feed host sends no `ETag` and no `Last-Modified` date, so each answer is a full answer. The
 * outcome has no time of the data: the `lastBuildDate` of the feed is the time of the build, not of the data.
 */
export function createAzureFetch(options: AzureFetchOptions): (input: AzureFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: AZURE_SOURCE,
    pace: options.pace,
    transport: options.transport,
    baseUrl: AZURE_BASE,
    headers: { accept: "application/rss+xml, text/xml;q=0.9, application/xml;q=0.8", "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? FEED_TIMEOUT_MS,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
  });
  const now = options.pace.now;

  return async (_input, signal) => {
    const requested = await requester.get({ path: FEED_PATH, what: "the RSS feed of Azure Status" }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    // A request with no condition gives no 304 answer: the requester gives only a 2xx answer as a success.
    const { url, answer, latency } = requested;
    const read = readFeed(answer.reply.body);
    if (!read.ok) {
      return { ok: false, failure: read.malformed ? { kind: "network", message: `truncated or malformed body: ${url}` } : { kind: "server", message: `the answer is not the RSS feed of Azure Status (${read.reason}): ${url}` } };
    }
    const incidents = incidentBodies(read.entries);
    const lossy = read.problems.some((problem) => problem.lossy === true);
    const fetched = now();
    const transport = { url, status: answer.reply.status, latency };
    const observations: Observation[] = incidents.bodies.map((body) => ({
      id: observationId({ source: AZURE_SOURCE, contentType: INCIDENT_CONTENT_TYPE, url: `${requester.baseUrl}${FEED_PATH}`, body }),
      source: AZURE_SOURCE,
      fetched,
      contentType: INCIDENT_CONTENT_TYPE,
      body,
      transport,
    }));
    return { ok: true, observations, complete: incidents.complete && !lossy };
  };
}
