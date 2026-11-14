/**
 * The fetch function of the NWS API source. It asks for the active alerts of the watched regions,
 * through polite-crawler, and gives one observation for each alert.
 */

import { observationId, type Cursor, type FetchFailure, type FetchOutcome, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { ApiError, send, type Answer, type Exchange, type Pace, type Reply, type Transport } from "polite-crawler/api";

import { SOURCE_ID } from "./map.ts";

/** The base URL of the NWS API. */
export const NWS_BASE_URL = "https://api.weather.gov";

/** The query of the canary: the newest test messages. The NWS sends a keepalive test message each 10 minutes. */
export const CANARY_PATH = "/alerts?status=test&limit=2";

/** The options of the fetch function of the NWS API source. */
export interface NwsFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /**
   * The `User-Agent` header. The NWS API refuses a request with no `User-Agent`. The NWS asks for a
   * name of the application and a contact. The instance gives it from its private settings.
   */
  readonly userAgent: string;
  /** The base URL. The default is `NWS_BASE_URL`. A test gives a different URL. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface NwsFetchInput {
  readonly watch: Watch;
  readonly cursor?: Cursor;
}

/** One query of a fetch: its path, and the effect of its failure. */
export interface Query {
  readonly path: string;
  /** True: the alerts of the watch. False: the canary query, whose failure only fails the canary check. */
  readonly main: boolean;
}

const STATE = /^[A-Z]{2}$/;
const UGC = /^[A-Z]{2}[CZ]\d{3}$/;

/**
 * This function calculates the queries of a watch. A place with a state code gives a query by state
 * (`area=`). A place with zone codes and no state code gives a query by zone (`zone=`). A place with
 * no such code gives the national query. A watch with no place gives no query of alerts. Each
 * watch also gives the canary query, so the health of the source is known with no place.
 *
 * The queries ask for all kinds and all statuses. The core filters the reports.
 */
export function queriesOf(watch: Watch): Query[] {
  const canary: Query = { path: CANARY_PATH, main: false };
  if (watch.places.length === 0) return [canary];
  const states = new Set<string>();
  const zones = new Set<string>();
  let national = false;
  for (const place of watch.places) {
    const own = place.codes
      .filter((code) => code.system === "state")
      .map((code) => code.code.trim().toUpperCase())
      .filter((code) => STATE.test(code));
    if (own.length > 0) {
      for (const state of own) states.add(state);
      continue;
    }
    const ugc = place.codes
      .filter((code) => code.system === "ugc")
      .map((code) => code.code.trim().toUpperCase())
      .filter((code) => UGC.test(code));
    if (ugc.length > 0) for (const zone of ugc) zones.add(zone);
    else national = true;
  }
  const list = (values: Set<string>): string => [...values].sort().join(",");
  const main: Query[] = national
    ? [{ path: "/alerts/active", main: true }]
    : [
        ...(states.size > 0 ? [{ path: `/alerts/active?area=${list(states)}`, main: true }] : []),
        ...(zones.size > 0 ? [{ path: `/alerts/active?zone=${list(zones)}`, main: true }] : []),
      ];
  return [...main, canary];
}

/** The text of a problem answer of the NWS API (RFC 7807), when the body is one. */
function problemDetail(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "detail" in parsed && typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // The body is not JSON: the status line tells enough.
  }
  return undefined;
}

/** This function maps an answer that is not a success to a failure of the fetch. */
export function failureOf(answer: Answer): FetchFailure {
  const { reply, classified } = answer;
  const detail = problemDetail(reply.body);
  const message = `${String(reply.status)} ${reply.statusText}${detail === undefined ? "" : `: ${detail}`}`.trim();
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

/** The observations of one answer. The value `complete` is true if the answer was a full list of alerts. */
interface Read {
  readonly observations: Observation[];
  readonly complete: boolean;
}

/**
 * This function splits an answer of the NWS API into observations: one for each alert. A JSON body
 * that is not a feature collection gives one observation of the whole body. Then the answer is not complete.
 *
 * A body that is not valid JSON gives `undefined`, and the fetch fails. A cut with no framing can look
 * whole to the HTTP client. Thus a body that does not parse is not a change of the format.
 */
export function readAnswer(reply: Reply, url: string, fetched: Instant, latency: number): Read | undefined {
  const contentType = reply.headers["content-type"] ?? "application/geo+json";
  const etag = reply.headers["etag"];
  const lastModified = reply.headers["last-modified"];
  const transport = {
    url,
    status: reply.status,
    latency,
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
  const observation = (body: string): Observation => ({
    id: observationId({ source: SOURCE_ID, contentType, url, body }),
    source: SOURCE_ID,
    fetched,
    contentType,
    body,
    transport,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.body);
  } catch {
    return undefined;
  }
  const features =
    typeof parsed === "object" && parsed !== null && "features" in parsed && Array.isArray(parsed.features) ? (parsed.features as unknown[]) : undefined;
  if (features === undefined) return { observations: [observation(reply.body)], complete: false };
  return { observations: features.map((feature) => observation(JSON.stringify(feature))), complete: true };
}

/** The result of one query. */
type QueryResult = { readonly ok: true; readonly read: Read } | { readonly ok: false; readonly failure: FetchFailure };

/**
 * This function makes the fetch function of the NWS API source. The fetch does not throw for a
 * failure of the source: it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * TODO(AL-8): polite-crawler 0.6.2 gives `poll` with ETag requests. Then the fetch keeps the last
 * answer of each query, and a 304 answer costs no body. Until then, each fetch reads the full list.
 */
export function createNwsFetch(options: NwsFetchOptions): (input: NwsFetchInput, signal?: AbortSignal) => Promise<FetchOutcome> {
  const baseUrl = (options.baseUrl ?? NWS_BASE_URL).replace(/\/+$/, "");
  const host = new URL(baseUrl).host;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.pace.now;

  async function query(path: string, signal: AbortSignal | undefined): Promise<QueryResult> {
    const url = `${baseUrl}${path}`;
    const exchange: Exchange = {
      method: "GET",
      url,
      headers: { accept: "application/geo+json", "user-agent": options.userAgent },
      body: null,
    };
    let timedOut = false;
    let latency = 0;
    // The latency is the time of the transport only. The wait of the scheduler is not part of it.
    const timed: Transport = async (request, outer) => {
      const own = AbortSignal.timeout(timeoutMs);
      own.addEventListener("abort", () => (timedOut = true), { once: true });
      const started = now();
      try {
        return await options.transport(request, outer === undefined ? own : AbortSignal.any([outer, own]));
      } finally {
        latency = now() - started;
      }
    };
    let answer: Answer;
    try {
      answer = await send(
        options.pace,
        timed,
        { source: SOURCE_ID, host, minIntervalMs: options.minIntervalMs ?? 1000, what: `the alerts ${path}`, exchange },
        signal,
      );
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (timedOut) return { ok: false, failure: { kind: "timeout", message: `no answer in ${String(timeoutMs)} ms: ${url}` } };
      const message = error instanceof ApiError ? error.message : errorMessage(error);
      return { ok: false, failure: { kind: "network", message } };
    }
    if (answer.classified.outcome !== "ok") return { ok: false, failure: failureOf(answer) };
    const read = readAnswer(answer.reply, url, now(), latency);
    if (read === undefined) {
      return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    }
    return { ok: true, read };
  }

  return async ({ watch }, signal) => {
    const queries = queriesOf(watch);
    const observations: Observation[] = [];
    let complete = true;
    for (const { path, main } of queries) {
      const result = await query(path, signal);
      if (!result.ok) {
        // The failure of the canary query does not fail the fetch. The canary check then fails.
        if (main) return { ok: false, failure: result.failure };
        continue;
      }
      observations.push(...result.read.observations);
      if (main && !result.read.complete) complete = false;
    }
    return { ok: true, observations, complete };
  };
}
