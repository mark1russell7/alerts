/**
 * The fetch function of the IPAWS source. It asks the public feed of FEMA IPAWS for the recent
 * alerts, through polite-crawler, and gives one observation for each alert that the watch keeps.
 *
 * The feed gives the alerts that IPAWS got after a time in the URL: `/public/recent/<time>`. The
 * feed answers for the last 30 minutes at most. The feed is national and has no filter by area.
 */

import { observationId, type Cursor, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { readCap, splitFeed } from "@mark1russell7/alerts-format-cap";
import { stateOfSame, stateOfUgc, statesOf } from "@mark1russell7/alerts-format-nws";
import type { Pace, Reply, Transport } from "polite-crawler/api";

import { NWS_SENDER, SOURCE_ID } from "./map.ts";

/** The base URL of the REST services of IPAWS-OPEN for the public. */
export const IPAWS_BASE_URL = "https://apps.fema.gov/IPAWSOPEN_EAS_SERVICE/rest";

/** The path of the public feed. The fetch adds `/<time>`, a UTC time to the second. */
export const FEED_PATH = "/public/recent";

/** The namespace of the root element of an answer of the feed, `ns1:alerts`. */
export const FEED_NAMESPACE = "http://gov.fema.ipaws.services/feed";

/** The longest time that the feed looks back: 30 minutes. The guide of the IPAWS-OPEN interface gives this limit. */
export const WINDOW_MS: number = 30 * 60_000;

/** The longest time that the fetch asks for: the window, less a margin of one minute for the clock of the server. */
export const LOOKBACK_MS: number = WINDOW_MS - 60_000;

/**
 * The overlap of two fetches. The next fetch asks again for the last 5 minutes. Thus a late alert of
 * IPAWS, or a difference of the clocks, does not make a gap. The ids of the observations make each
 * copy of an alert one observation.
 */
export const OVERLAP_MS: number = 5 * 60_000;

/** The name of the field of the cursor: the time that the next fetch asks for. */
export const CURSOR_SINCE = "since";

/** The options of the fetch function of the IPAWS source. */
export interface IpawsFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `IPAWS_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface IpawsFetchInput {
  readonly watch: Watch;
  readonly cursor?: Cursor;
}

/** This function gives a time as the feed takes it: `2026-11-15T06:00:00Z`, in UTC, to the second. */
export function feedTime(time: Instant): string {
  return new Date(Math.floor(time / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** The time that one fetch asks for, and the value `complete` of its outcome. */
export interface Since {
  readonly since: Instant;
  /** False: the cursor is older than the window of the feed, or it is not a time. The fetch then has a gap. */
  readonly complete: boolean;
}

/**
 * This function calculates the time that a fetch asks for. With no cursor, the fetch asks for the
 * full window. A cursor older than the window gives the full window and a gap. A cursor after the
 * time of the fetch gives the time of the fetch.
 */
export function sinceOf(cursor: Cursor | undefined, now: Instant): Since {
  const floor = now - LOOKBACK_MS;
  const text = cursor?.[CURSOR_SINCE];
  if (text === undefined) return { since: floor, complete: true };
  const asked = Date.parse(text);
  if (Number.isNaN(asked) || asked < floor) return { since: floor, complete: false };
  return { since: Math.min(asked, now), complete: true };
}

// The SAME code of the full country (47 CFR 11.31).
const COUNTRY_SAME = "000000";

/**
 * This function examines one alert of the feed against the states of a watch. The fetch keeps each
 * alert of the NWS, for the whole country. The lateness of the NWS API source needs each copy of the
 * WEA messages. An alert of a different authority stays when one of its geocodes is in a watched
 * state. It also stays when it has no geocode of a state, or when it has the SAME code `000000` of the
 * full country. An alert that the reader refuses stays, so the map tells of it.
 */
export function keeps(alert: string, states: ReadonlySet<string> | undefined): boolean {
  if (states === undefined) return true;
  const read = readCap(alert);
  if (!read.ok) return true;
  if (read.alert.sender.trim().toLowerCase() === NWS_SENDER) return true;
  let stated = false;
  for (const info of read.alert.infos) {
    for (const area of info.areas) {
      for (const geocode of area.geocodes) {
        if (geocode.valueName === "SAME" && geocode.value.trim() === COUNTRY_SAME) return true;
        const state = geocode.valueName === "UGC" ? stateOfUgc(geocode.value) : geocode.valueName === "SAME" ? stateOfSame(geocode.value) : undefined;
        if (state === undefined) continue;
        if (states.has(state)) return true;
        stated = true;
      }
    }
  }
  return !stated;
}

/** The observations of one answer. The value `complete` is false when the answer is not the feed. */
interface Read {
  readonly observations: Observation[];
  readonly complete: boolean;
}

/**
 * This function splits an answer of the feed into observations: one for each alert that the states
 * keep. A whole document that is not the feed gives one observation of the whole body. Then the
 * answer is not complete, and the map tells of the change.
 *
 * A cut document gives `undefined`, and the fetch fails. A cut with no framing can look whole to the
 * HTTP client. Thus a body that does not end is not a change of the format.
 *
 * The id of each observation has the URL of the feed with no time. Each fetch asks with a new time,
 * and the map does not read the time. So one alert in two answers gives one observation.
 */
export function readAnswer(reply: Reply, url: string, feedUrl: string, fetched: Instant, latency: number, states: ReadonlySet<string> | undefined): Read | undefined {
  const contentType = reply.headers["content-type"] ?? "application/xml";
  const transport = { url, status: reply.status, latency };
  const observation = (body: string): Observation => ({
    id: observationId({ source: SOURCE_ID, contentType, url: feedUrl, body }),
    source: SOURCE_ID,
    fetched,
    contentType,
    body,
    transport,
  });
  const feed = splitFeed(reply.body);
  if (!feed.whole) return undefined;
  const isFeed = feed.root !== undefined && feed.root.slice(feed.root.indexOf(":") + 1) === "alerts" && feed.namespace === FEED_NAMESPACE;
  if (!isFeed) return { observations: [observation(reply.body)], complete: false };
  return { observations: feed.alerts.filter((alert) => keeps(alert, states)).map(observation), complete: true };
}

/**
 * This function makes the fetch function of the IPAWS source. The fetch does not throw for a failure
 * of the source: it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one request. Its outcome has the cursor of the next fetch: the time of the request,
 * less `OVERLAP_MS`. A failed fetch gives no cursor, so the next fetch asks again from the old cursor.
 */
export function createIpawsFetch(options: IpawsFetchOptions): (input: IpawsFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? IPAWS_BASE_URL,
    headers: { accept: "application/xml", "user-agent": options.userAgent },
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const feedUrl = `${requester.baseUrl}${FEED_PATH}`;
  const now = options.pace.now;

  return async ({ watch, cursor }, signal) => {
    const started = now();
    const { since, complete } = sinceOf(cursor, started);
    const requested = await requester.get({ path: `${FEED_PATH}/${feedTime(since)}`, what: "the recent alerts" }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    const read = readAnswer(answer.reply, url, feedUrl, now(), latency, statesOf(watch));
    if (read === undefined) return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    return {
      ok: true,
      observations: read.observations,
      cursor: { [CURSOR_SINCE]: feedTime(Math.max(since, started - OVERLAP_MS)) },
      complete: complete && read.complete,
    };
  };
}
