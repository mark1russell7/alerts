/**
 * The fetch of the feed catalog of the Mobility Database. One conditional GET through polite-crawler gives the text of the
 * catalog, or a 304 answer that keeps the last copy. The runtime keeps the copy in its private folder.
 */

import type { FetchFailure, FetchSignal, Instant, SourceId } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import type { Condition, Pace, Transport } from "polite-crawler/api";

import { CATALOG_URL, catalogFeeds } from "./catalog.ts";

/** The longest time of one request of the catalog, in milliseconds. The catalog has more than 2 MB. */
export const CATALOG_TIMEOUT_MS = 60_000;

/** The id of the requests of the catalog in each message of polite-crawler. */
export const CATALOG_SOURCE = "gtfs-catalog" as SourceId;

/** One copy of the catalog: its text, the time of the fetch, and the validators of the answer. */
export interface CatalogCopy {
  /** The text of the catalog, in CSV. */
  readonly text: string;
  /** The time of the last fetch that gave or kept this text. */
  readonly fetched: Instant;
  /** The `ETag`, the `Last-Modified` and the digest of the answer. The next fetch sends them in its conditions. */
  readonly condition?: Condition;
}

/** The result of one fetch of the catalog. */
export type CatalogFetched =
  | {
      readonly ok: true;
      /** The copy after the fetch. A 304 answer gives the last copy with the new time of the fetch. */
      readonly copy: CatalogCopy;
      /** True when the text is not the text of the last copy. */
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly failure: FetchFailure };

/** The fetch of the catalog. It takes the last copy, or `undefined` for the first fetch. */
export type CatalogFetch = (last: CatalogCopy | undefined, signal?: FetchSignal) => Promise<CatalogFetched>;

/** The options of the fetch of the catalog. */
export interface CatalogFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The URL of the catalog. The default is `CATALOG_URL`. */
  readonly url?: string;
  /** The longest time of one request, in milliseconds. The default is `CATALOG_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * This function makes the fetch of the catalog. The fetch does not throw for a failure of the server: it gives
 * `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * - A 304 answer keeps the text of the last copy. A 304 answer with no last copy is a failure.
 * - A text that `catalogFeeds` does not read is a failure, and the last copy stays.
 */
export function createCatalogFetch(options: CatalogFetchOptions): CatalogFetch {
  const target = new URL(options.url ?? CATALOG_URL);
  const path = `${target.pathname}${target.search}`;
  const requester = createRequester({
    source: CATALOG_SOURCE,
    pace: options.pace,
    transport: options.transport,
    baseUrl: target.origin,
    headers: { accept: "text/csv, text/plain;q=0.9", "user-agent": options.userAgent },
    timeoutMs: options.timeoutMs ?? CATALOG_TIMEOUT_MS,
  });
  const url = `${requester.baseUrl}${path}`;
  const now = options.pace.now;

  return async (last, signal) => {
    // Each fetch starts from the validators of the copy, not of an earlier fetch. Thus a copy from the file works as a copy in memory.
    const conditions = new Map<string, Condition>();
    if (last?.condition !== undefined) conditions.set(url, last.condition);
    const requested = await requester.get({ path, what: "the feed catalog of the Mobility Database", conditions }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { answer } = requested;
    if (answer.classified.outcome === "not-modified") {
      if (last === undefined) return { ok: false, failure: { kind: "server", message: `a 304 answer with no earlier copy: ${url}` } };
      return { ok: true, copy: { ...last, fetched: now() }, changed: false };
    }
    const text = answer.reply.body;
    const [problem] = catalogFeeds(text).problems;
    if (problem !== undefined) return { ok: false, failure: { kind: "server", message: `the answer is not the catalog (${problem}): ${url}` } };
    const condition = conditions.get(url);
    return { ok: true, copy: { text, fetched: now(), ...(condition === undefined ? {} : { condition }) }, changed: text !== last?.text };
  };
}
