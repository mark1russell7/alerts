/**
 * The fetch function of the EIA-930 source. It asks the API of EIA (`api.eia.gov/v2/electricity/rto/region-data`) for
 * the demand and the day-ahead demand forecast of each balancing authority of the past hours, through polite-crawler.
 * The query holds only the types of the values and the hours, so a request names no place of the watch.
 *
 * The API takes the key only in the query of the URL. The fetch removes the key from each URL and each message that it
 * gives. The id of an observation has the URL of the series with no hours and no key. Thus an hour that two fetches give
 * keeps its id, and the runtime keeps it one time.
 *
 * Each fetch reads the past `LIVE_HOURS` hours again: a balancing authority can send an hour late. Until the history
 * holds `BACKFILL_MS`, each fetch also reads the day before the oldest hour of the history. The cursor holds the hours
 * that the fetches read with no gap.
 */

import { DEFAULT_BASELINE, observationId, type Cursor, type FetchFailure, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester, type Requested } from "@mark1russell7/alerts-fetch";
import { redactSecrets } from "@mark1russell7/text/redact";
import type { Pace, Transport } from "polite-crawler/api";
import { z } from "zod";

import { AGGREGATE_RESPONDENTS, API_UNIT, hourBody, HOUR_MS, periodEnd, periodText, SOURCE_ID } from "./map.ts";

/** The base URL of the API of EIA. The host is a name of the API gateway `api.data.gov`. */
export const EIA_BASE_URL = "https://api.eia.gov";

/** The path of the data of the Hourly Electric Grid Monitor. */
export const DATA_PATH = "/v2/electricity/rto/region-data/data/";

/** The most rows of one answer in JSON. The documentation of the API gives this limit. */
export const MAX_ROWS = 5000;

/** The most requests of one window. Each request gives `MAX_ROWS` rows at most. */
export const MAX_PAGES = 5;

/** The count of whole hours before the newest hour that each fetch reads again. */
export const LIVE_HOURS = 6;

/** The count of hours of one read of the history. */
export const PAGE_HOURS = 24;

/** The history that the fetches read: the window of the baseline of the core, and one day more. */
export const BACKFILL_MS: number = DEFAULT_BASELINE.window + 24 * HOUR_MS;

/** The shortest time between two requests to the host. The FAQ of the API asks for less than 5 requests each second. */
export const MIN_INTERVAL_MS = 2000;

/** The longest time of one request, in milliseconds. One day of the history is more than 500 kB. */
export const TIMEOUT_MS = 30_000;

/** The date format of the hourly series in UTC, as the field `dateFormat` of each answer gives it. */
export const DATE_FORMAT = 'YYYY-MM-DD"T"HH24';

/** The options of the fetch function of the EIA-930 source. */
export interface Eia930FetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The API key of EIA. It goes into the query of each URL, and no URL or message of the fetch holds it. */
  readonly apiKey: string;
  /** The base URL. The default is `EIA_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is `MIN_INTERVAL_MS`. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface Eia930FetchInput {
  readonly watch: Watch;
  readonly cursor?: Cursor;
}

/** The hours that the fetches read with no gap: the end of the oldest hour and the end of the newest hour. */
export interface Covered {
  readonly from: Instant;
  readonly to: Instant;
}

/** This function gives the hours of a cursor. A cursor that is not two whole hours in their order gives `undefined`. */
export function coveredOf(cursor: Cursor | undefined): Covered | undefined {
  const from = periodEnd(cursor?.["from"]);
  const to = periodEnd(cursor?.["to"]);
  return from === undefined || to === undefined || from > to ? undefined : { from, to };
}

/** This function gives the cursor of the hours that the fetches read. */
export function cursorOf(covered: Covered): Cursor {
  return { from: periodText(covered.from), to: periodText(covered.to) };
}

/**
 * This function gives the path of one request: the demand and the forecast of the hours from `from` to `to`, with the
 * ends. The rows come in the order of the hour, the respondent and the type, so the pages do not overlap. The path has
 * no key.
 */
export function queryPath(from: Instant, to: Instant, offset: number): string {
  const sort = ["period", "respondent", "type"].map((column, index) => `sort[${String(index)}][column]=${column}&sort[${String(index)}][direction]=asc`).join("&");
  return `${DATA_PATH}?frequency=hourly&data[0]=value&facets[type][]=D&facets[type][]=DF&start=${periodText(from)}&end=${periodText(to)}&${sort}&offset=${String(offset)}&length=${String(MAX_ROWS)}`;
}

const countSchema = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]);
const pageSchema = z.object({
  response: z.object({
    total: countSchema,
    frequency: z.literal("hourly"),
    dateFormat: z.literal(DATE_FORMAT),
    data: z.array(z.unknown()),
  }),
});
const rowSchema = z.object({
  period: z.string().refine((value) => periodEnd(value) !== undefined),
  respondent: z.string().min(1),
  type: z.enum(["D", "DF"]),
  value: z.union([z.null(), z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]),
  "value-units": z.literal(API_UNIT),
});

/** The read of one answer: the rows and the count of all the rows of the query, or a body that is not the series. */
export type Page = { readonly kind: "page"; readonly rows: readonly unknown[]; readonly total: number } | { readonly kind: "other" };

/** This function reads one answer. A body that does not parse gives `undefined`. */
export function readPage(body: string): Page | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const page = pageSchema.safeParse(parsed);
  return page.success ? { kind: "page", rows: page.data.response.data, total: page.data.response.total } : { kind: "other" };
}

/** The bodies of the rows of one window. */
export interface Hours {
  /** One body for each hour of a balancing authority with a row of the demand, in the order of the hour and the respondent. */
  readonly bodies: readonly string[];
  /** The JSON text of each row that is not valid. */
  readonly invalid: readonly string[];
}

/**
 * This function groups the rows into hours. An hour of a balancing authority has a body when it has a row of the demand.
 * The rows of the regions and of the lower 48 states (`AGGREGATE_RESPONDENTS`) give no body.
 */
export function hoursOf(rows: readonly unknown[]): Hours {
  const hours = new Map<string, { period: string; respondent: string; demand?: number | null; forecast?: number | null }>();
  const invalid = new Set<string>();
  for (const row of rows) {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) {
      invalid.add(JSON.stringify(row));
      continue;
    }
    const { period, respondent, type, value } = parsed.data;
    if (AGGREGATE_RESPONDENTS.includes(respondent)) continue;
    const key = JSON.stringify([period, respondent]);
    const hour = hours.get(key) ?? { period, respondent };
    // One row twice keeps the last row.
    if (type === "D") hour.demand = value;
    else hour.forecast = value;
    hours.set(key, hour);
  }
  const bodies = [...hours.entries()]
    .filter(([, hour]) => hour.demand !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, hour]) => hourBody(hour.period, hour.respondent, hour.demand ?? null, hour.forecast ?? null));
  return { bodies, invalid: [...invalid] };
}

/**
 * The error codes of the API gateway `api.data.gov` for a key that it does not accept. The gateway gives each code with
 * the status 403.
 */
export const KEY_ERROR_CODES: readonly string[] = ["API_KEY_MISSING", "API_KEY_INVALID", "API_KEY_DISABLED", "API_KEY_UNAUTHORIZED"];

/**
 * This function gives the failure of a request. A 403 with a key error code (`KEY_ERROR_CODES`) is `auth`: the key is bad, and
 * a new try does not help. Each other failure stays as the requester gives it.
 */
export function failureOfRequest(requested: Extract<Requested, { ok: false }>): FetchFailure {
  const reply = requested.answer?.reply;
  if (reply?.status !== 403) return requested.failure;
  let code: unknown;
  try {
    code = (JSON.parse(reply.body) as { error?: { code?: unknown } } | null)?.error?.code;
  } catch {
    return requested.failure;
  }
  return typeof code === "string" && KEY_ERROR_CODES.includes(code) ? { kind: "auth", message: requested.failure.message } : requested.failure;
}

/** The result of the read of one window of hours. */
type WindowRead = { readonly ok: true; readonly observations: readonly Observation[]; readonly complete: boolean } | { readonly ok: false; readonly failure: FetchFailure };

/**
 * This function makes the fetch function of the EIA-930 source. The fetch does not throw for a failure of the source: it
 * gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * - A failure of the read of the past hours fails the fetch. A failure of the read of the history does not: the cursor
 *   then keeps the oldest hour, and the next fetch reads that day again.
 * - The answers have no validators, so the fetch sends no condition.
 * - A cut answer does not parse, so it fails the fetch.
 */
export function createEia930Fetch(options: Eia930FetchOptions): (input: Eia930FetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const secrets = [options.apiKey];
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? EIA_BASE_URL,
    headers: { accept: "application/json", "user-agent": options.userAgent },
    minIntervalMs: options.minIntervalMs ?? MIN_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    secrets,
  });
  const now = options.pace.now;
  const key = `&api_key=${encodeURIComponent(options.apiKey)}`;
  const series = `${requester.baseUrl}${DATA_PATH}?frequency=hourly&facets[type][]=D&facets[type][]=DF`;
  const span = (from: Instant, to: Instant): string => `${periodText(from)} to ${periodText(to)}`;

  /** This function reads the hours from `from` to `to`, in pages of `MAX_ROWS` rows. */
  async function readWindow(from: Instant, to: Instant, what: string, signal: FetchSignal | undefined): Promise<WindowRead> {
    const rows: unknown[] = [];
    let first: { readonly url: string; readonly status: number } | undefined;
    let latency = 0;
    let total = 0;
    let other: string | undefined;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const requested = await requester.get({ path: `${queryPath(from, to, rows.length)}${key}`, what: `${what} (${span(from, to)})` }, signal);
      if (!requested.ok) return { ok: false, failure: failureOfRequest(requested) };
      const url = redactSecrets(requested.url, secrets);
      first ??= { url, status: requested.answer.reply.status };
      latency += requested.latency;
      const page = readPage(requested.answer.reply.body);
      if (page === undefined) return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
      if (page.kind === "other") {
        other = requested.answer.reply.body;
        break;
      }
      rows.push(...page.rows);
      total = page.total;
      if (rows.length >= total || page.rows.length === 0) break;
    }
    const fetched = now();
    const transport = { ...(first ?? {}), latency };
    const observation = (body: string, contentType = "application/json"): Observation => ({
      id: observationId({ source: SOURCE_ID, contentType, url: series, body }),
      source: SOURCE_ID,
      fetched,
      contentType,
      body,
      transport,
    });
    // An answer that is not the series gives one observation of its body. Then the map tells of the change.
    if (other !== undefined) return { ok: true, observations: [observation(redactSecrets(other, secrets))], complete: false };
    const hours = hoursOf(rows);
    const observations = [...hours.bodies, ...hours.invalid].map((body) => observation(body));
    return { ok: true, observations, complete: hours.invalid.length === 0 && rows.length >= total };
  }

  return async (input, signal) => {
    // The newest hour is the last whole hour. The API names an hour by its end.
    const to = Math.floor(now() / HOUR_MS) * HOUR_MS;
    const from = to - LIVE_HOURS * HOUR_MS;
    const live = await readWindow(from, to, "the demand of the past hours", signal);
    if (!live.ok) return { ok: false, failure: live.failure };
    // The history of the cursor counts only when it meets the past hours with no gap.
    const before = coveredOf(input.cursor);
    let oldest = before !== undefined && before.to >= from - HOUR_MS && before.from <= from ? before.from : from;
    const observations = [...live.observations];
    const limit = to - BACKFILL_MS;
    if (oldest > limit) {
      const start = Math.max(oldest - PAGE_HOURS * HOUR_MS, limit);
      const history = await readWindow(start, oldest - HOUR_MS, "the demand of older hours", signal);
      if (history.ok) observations.push(...history.observations);
      if (history.ok && history.complete) oldest = start;
    }
    return { ok: true, observations, complete: live.complete, cursor: cursorOf({ from: oldest, to }) };
  };
}
