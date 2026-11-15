/**
 * The fetch function of the IEM source. It asks the Iowa Environmental Mesonet (IEM) for the VTEC
 * events of the NWS that are in effect, by county and zone. It uses polite-crawler. It gives one
 * observation for each row of the list that the watch keeps.
 *
 * The list is national. The fetch asks with no filter, so a request names no state of the watch.
 * IEM reads the products of the NWS from its own feeds, not from the NWS API.
 */

import { observationId, type Cursor, type FetchOutcome, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester } from "@mark1russell7/alerts-fetch";
import { stateOfUgc, statesOf } from "@mark1russell7/alerts-format-nws";
import type { Pace, Reply, Transport } from "polite-crawler/api";

import { ROW_FIELDS, SOURCE_ID } from "./map.ts";

/** The base URL of the API of IEM. */
export const IEM_BASE_URL = "https://mesonet.agron.iastate.edu/api/1";

/** The path of the list of the VTEC events in effect, by county and zone. */
export const LIST_PATH = "/vtec/county_zone.json";

/** The options of the fetch function of the IEM source. */
export interface IemFetchOptions {
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The base URL. The default is `IEM_BASE_URL`. A test gives a different URL. The fetch removes the slashes at its end. */
  readonly baseUrl?: string;
  /** The shortest time between two requests to the host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface IemFetchInput {
  readonly watch: Watch;
  readonly cursor?: Cursor;
}

/**
 * This function examines one row of the list against the states of a watch. A row of a watched state
 * stays. A row with no state, for example a marine zone, also stays. A row that is not an object, or
 * that has no UGC text, stays, so the map tells of it.
 */
export function keepsRow(row: unknown, states: ReadonlySet<string> | undefined): boolean {
  if (states === undefined) return true;
  if (typeof row !== "object" || row === null || !("ugc" in row) || typeof row.ugc !== "string") return true;
  const state = stateOfUgc(row.ugc);
  return state === undefined || states.has(state);
}

/**
 * This function gives the body of the observation of one row: the fields of `ROW_FIELDS`, in their
 * order, with the values of the row. A field that the row does not have is absent.
 */
export function rowBody(row: unknown): string {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return JSON.stringify(row);
  const fields = row as Readonly<Record<string, unknown>>;
  const kept: Record<string, unknown> = {};
  for (const field of ROW_FIELDS) if (field in fields) kept[field] = fields[field];
  return JSON.stringify(kept);
}

/** The types of the fields of a row of the list: the structure that the fetch examines. */
const ROW_TYPES: Readonly<Record<(typeof ROW_FIELDS)[number], (value: unknown) => boolean>> = {
  wfo: (value) => typeof value === "string",
  phenomena: (value) => typeof value === "string",
  significance: (value) => typeof value === "string",
  eventid: (value) => typeof value === "number",
  ugc: (value) => typeof value === "string",
  utc_issue: (value) => typeof value === "string",
  utc_expire: (value) => value === null || typeof value === "string",
  utc_product_issue: (value) => typeof value === "string",
};

/** This function tells if a row has the structure of the list: each field of `ROW_FIELDS` with its type. */
export function isListRow(row: unknown): boolean {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
  const fields = row as Readonly<Record<string, unknown>>;
  return ROW_FIELDS.every((field) => field in fields && ROW_TYPES[field](fields[field]));
}

/** The observations of one answer. The value `complete` is true if the answer was the whole list. */
interface Read {
  readonly observations: Observation[];
  readonly complete: boolean;
}

/**
 * This function splits an answer of IEM into observations: one for each row that the states keep. A
 * JSON body that is not the list gives one observation of the whole body. Then the answer is not
 * complete, and the map tells of the change.
 *
 * The list is complete when its body parses, its `data` has at least one row, and each row has the
 * structure of `isListRow`. The core ends the events that leave a complete list, so a change of the
 * format must end no event. A body that does not parse gives `undefined`, and the fetch fails: a cut
 * with no framing can look whole to the HTTP client. The national list had 105 or more events at each
 * of 12 times in one year, so an empty list is a fault of IEM.
 *
 * The id of each observation has the URL of the list and the body of the row. The same row in two
 * answers gives one observation. A row that changes gives a new observation.
 */
export function readAnswer(reply: Reply, url: string, fetched: Instant, latency: number, states: ReadonlySet<string> | undefined): Read | undefined {
  const contentType = reply.headers["content-type"] ?? "application/json";
  const transport = { url, status: reply.status, latency };
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
  const data = typeof parsed === "object" && parsed !== null && "data" in parsed && Array.isArray(parsed.data) ? (parsed.data as unknown[]) : undefined;
  if (data === undefined) return { observations: [observation(reply.body)], complete: false };
  const rows = data.filter((row) => keepsRow(row, states));
  return { observations: rows.map((row) => observation(rowBody(row))), complete: data.length > 0 && data.every(isListRow) };
}

/**
 * This function makes the fetch function of the IEM source. The fetch does not throw for a failure
 * of the source: it gives `{ ok: false }`. It throws only when the signal of the caller aborts.
 *
 * Each fetch is one request of the whole list. IEM gives no ETag and no time of a change, so the
 * request has no condition. The fetch gives no cursor: the list holds each row that is in effect.
 */
export function createIemFetch(options: IemFetchOptions): (input: IemFetchInput, signal?: AbortSignal) => Promise<FetchOutcome> {
  const requester = createRequester({
    source: SOURCE_ID,
    pace: options.pace,
    transport: options.transport,
    baseUrl: options.baseUrl ?? IEM_BASE_URL,
    headers: { accept: "application/json", "user-agent": options.userAgent },
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const now = options.pace.now;

  return async ({ watch }, signal) => {
    const requested = await requester.get({ path: LIST_PATH, what: "the VTEC events in effect" }, signal);
    if (!requested.ok) return { ok: false, failure: requested.failure };
    const { url, answer, latency } = requested;
    const read = readAnswer(answer.reply, url, now(), latency, statesOf(watch));
    if (read === undefined) return { ok: false, failure: { kind: "network", message: `truncated or malformed body: ${url}` } };
    return { ok: true, observations: read.observations, complete: read.complete };
  };
}
