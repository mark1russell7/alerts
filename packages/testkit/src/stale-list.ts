/**
 * AL-13, case 6: a stale or repeated list of a snapshot source. The IEM source gives the list of the NWS events in effect.
 * A row that ends leaves the list with no cancel. Thus the runtime ends a report that is absent from `SNAPSHOT_MISSES`
 * complete lists in a row. An old list from a cache or from a late copy of a database is complete, but it is not current.
 *
 * Each arm has `fetches` fetches of the IEM source, on a fast case clock from the time of the IEM fixture. The list of each
 * fetch comes from three real rows of the IEM list of 2026-11-15 at 13:20 UTC:
 *
 * - `r1`: a row that stays in the list.
 * - `r2`: the row of a new event. It is in the list from fetch 3, and it has the newest product time.
 * - `r3`: a row that leaves the list at fetch 4. Thus its report ends at fetch 5.
 *
 * In an arm, the fault proxy of `@mark1russell7/rigor-proxy` gives an old list to some fetches. The server does not get them.
 *
 * - `control`: no old list. This arm is the control of the case.
 * - `repeat`: fetch 3 gets the list of fetch 2 again.
 * - `stale-once`: fetch 4 gets the list of fetch 0.
 * - `stale-twice`: fetches 4 and 5 get the list of fetch 0.
 * - `stale-after-end`: fetch 7 gets the list of fetch 0, after the end of the report of `r3`.
 *
 * The gates of each arm compare the events of the runtime with the true list of each fetch:
 *
 * - `noFalseEnd`: no `ended` event names a report whose row is in the true list.
 * - `noFalseBack`: no `back` event names a report whose row is not in the true list.
 * - `settles`: after the last fetch, the reports that ended are the reports of the rows that are not in the true list.
 */
import type { FetchOutcome, Observation, PlaceId, ReportId, SourceProcedures, Watch } from "@mark1russell7/alerts";
import { openRuntime, openRuntimeLog, SNAPSHOT_MISSES, sourcePace, type RuntimeEvent, type RuntimeOptions } from "@mark1russell7/alerts-runtime";
import { createIemSource, IEM_DESCRIPTOR, LIST_PATH, SOURCE_ID } from "@mark1russell7/alerts-source-iem";
import { type Fault, faultPlanOf } from "@mark1russell7/rigor-chaos";
import { random } from "@mark1russell7/rigor-generators";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { fetchTransport, type Transport } from "polite-crawler/api";
import { caseClock } from "./source-down.ts";

/** The id and the seed of the case. The jitter of the pace of each arm comes from this seed and the name of the arm. */
export const CASE_6_ID = "al-13-case-6";
/** The origin of the source in the case. The transport of the case refuses each other origin. */
export const CASE_6_ORIGIN = "http://iem.test";
const USER_AGENT = "alerts-testkit/0 (fault suite)";
const JSON_TYPE = { "content-type": "application/json" };

/** The name of a row of the case. */
export type RowName = "r1" | "r2" | "r3";

/** The names of the rows, in their order. */
export const ROW_NAMES: readonly RowName[] = ["r1", "r2", "r3"];

/** The three rows of the case. Each one is a row of the IEM fixture `county-zone-20261115T1320Z.json`, with no change. */
export const ROWS: Readonly<Record<RowName, Readonly<Record<string, unknown>>>> = {
  r1: {
    index: 744,
    utc_product_issue: "2026-11-15T09:28:00Z",
    utc_issue: "2026-11-15T09:28:00Z",
    utc_expire: "2026-11-15T17:00:00Z",
    ph_sig: "FG.Y",
    wfo: "MAF",
    eventid: 5,
    phenomena: "FG",
    significance: "Y",
    ugc: "TXZ047",
    nws_color: "#708090",
    event_label: "Dense Fog Advisory",
  },
  r2: {
    index: 752,
    utc_product_issue: "2026-11-15T10:15:00Z",
    utc_issue: "2026-11-15T10:15:00Z",
    utc_expire: "2026-11-16T15:00:00Z",
    ph_sig: "CF.Y",
    wfo: "CRP",
    eventid: 25,
    phenomena: "CF",
    significance: "Y",
    ugc: "TXZ442",
    nws_color: "#7CFC00",
    event_label: "Coastal Flood Advisory",
  },
  r3: {
    index: 698,
    utc_product_issue: "2026-11-15T05:42:00Z",
    utc_issue: "2026-11-15T08:00:00Z",
    utc_expire: "2026-11-15T18:00:00Z",
    ph_sig: "FG.Y",
    wfo: "DDC",
    eventid: 20,
    phenomena: "FG",
    significance: "Y",
    ugc: "KSZ074",
    nws_color: "#708090",
    event_label: "Dense Fog Advisory",
  },
};

/** The first fetch with `r2` in the true list. */
export const R2_FROM = 3;
/** The first fetch with no `r3` in the true list. */
export const R3_UNTIL = 4;

/** This function gives the rows of the true list of a fetch, in their order. */
export function trueRows(fetch: number): RowName[] {
  return ROW_NAMES.filter((row) => (row === "r2" ? fetch >= R2_FROM : row === "r3" ? fetch < R3_UNTIL : true));
}

/** This function gives the body of the true list of a fetch, as IEM gives it: a JSON object with the rows in `data`. */
export function listOf(fetch: number): string {
  return JSON.stringify({ data: trueRows(fetch).map((row) => ROWS[row]) });
}

/** An arm of the case: the control, or a plan of old lists. */
export type StaleArm = "control" | "repeat" | "stale-once" | "stale-twice" | "stale-after-end";

/** The arms of the case. The run starts them at the same time, each with its own servers, proxy and clock. */
export const STALE_ARMS: readonly StaleArm[] = ["control", "repeat", "stale-once", "stale-twice", "stale-after-end"];

/** The old lists of each arm: for each fetch that gets an old list, the fetch of that list. The fetches are in their order. */
export const OLD_LISTS: Readonly<Record<StaleArm, ReadonlyMap<number, number>>> = {
  control: new Map(),
  repeat: new Map([[3, 2]]),
  "stale-once": new Map([[4, 0]]),
  "stale-twice": new Map([
    [4, 0],
    [5, 0],
  ]),
  "stale-after-end": new Map([[7, 0]]),
};

/** The settings of the case. */
export interface StaleSettings {
  /** The milliseconds of the case clock in one real millisecond. */
  readonly speed: number;
  /** The count of fetches of each arm. */
  readonly fetches: number;
  /** The start of the case clock, in milliseconds since the epoch. No row expires in the arm after this time. */
  readonly start: number;
}

/** The settings of the case. Each arm has 11 fetches of 2 minutes: 22 minutes of the case clock, 22 seconds at the speed 60. */
export const CASE_6_SETTINGS: StaleSettings = { speed: 60, fetches: 11, start: Date.parse("2026-11-15T13:20:00Z") };

/** The places of the watch of the source: Texas and Kansas, the states of the rows. */
const PLACES = [
  { id: "tx" as PlaceId, codes: [{ system: "state", code: "TX" }], bufferKm: 0 },
  { id: "ks" as PlaceId, codes: [{ system: "state", code: "KS" }], bufferKm: 0 },
] as const;
const IEM_WATCH: Watch = { places: PLACES };
const VIEW: RuntimeOptions["view"] = { places: PLACES, kinds: IEM_DESCRIPTOR.kinds, expectations: [], delay: { quantile: 0.9, level: 0.9 } };

/** The requests of an arm on each route. */
export interface StaleRoutes {
  direct: number;
  old: number;
}

/** The options of the transport of the case. */
export interface StaleTransportOptions {
  /** The transport that sends each request to a server. */
  readonly inner: Transport;
  /** The origin of the server of the true lists. */
  readonly direct: string;
  /** The origin of the fault proxy that gives the old lists. */
  readonly old: string;
  /** The fetches that get an old list. The transport counts each request of the source as one fetch, from 0. */
  readonly olds: ReadonlySet<number>;
  readonly counts: StaleRoutes;
}

/**
 * This function gives the transport of the case. It refuses each origin other than `CASE_6_ORIGIN`. It sends the request of
 * each fetch in `olds` to the fault proxy, and each other request to the server.
 */
export function staleTransport(options: StaleTransportOptions): Transport {
  const { inner, olds, counts } = options;
  let fetch = 0;
  return (exchange, signal) => {
    const url = new URL(exchange.url);
    if (url.origin !== CASE_6_ORIGIN) return Promise.reject(new TypeError(`The address ${exchange.url} is not an address of the case.`));
    const old = olds.has(fetch);
    fetch += 1;
    if (old) counts.old += 1;
    else counts.direct += 1;
    return inner({ ...exchange, url: `${old ? options.old : options.direct}${url.pathname}${url.search}` }, signal);
  };
}

/** This function gives the faults of the proxy of an arm. Each connection gets one answer with an old list, in the order of the fetches. */
export function oldAnswersOf(arm: StaleArm): Fault[] {
  return [...OLD_LISTS[arm].values()].map((list, connection) => ({
    connection,
    direction: "up",
    at: { frame: 0 },
    kind: "answer",
    status: 200,
    fields: JSON_TYPE,
    body: listOf(list),
  }));
}

/** One fetch of the IEM source in an arm. */
export interface StaleFetch {
  /** The number of the fetch, from 0. */
  readonly fetch: number;
  /** The time of the end of the pass, after the start of the arm. */
  readonly at: number;
  /** True when the fetch went to the proxy, for an old list. */
  readonly old: boolean;
  readonly ok: boolean;
  /** True when the source gave the list as complete. */
  readonly complete: boolean;
  /** The rows of the observations of the fetch. */
  readonly rows: readonly RowName[];
  /** The rows of the reports in the `ended` events of the pass. */
  readonly ended: readonly RowName[];
  /** The rows of the reports in the `back` events of the pass. */
  readonly back: readonly RowName[];
}

/** The records of one arm. */
export interface StaleRecord {
  readonly arm: StaleArm;
  readonly fetches: readonly StaleFetch[];
  readonly requests: Readonly<StaleRoutes>;
  /** The count of the faults that the proxy recorded. */
  readonly faults: number;
  /** The count of the requests that the server of the true lists read. */
  readonly served: number;
  /** The count of the requests that the server behind the proxy read. When each fault falls at its point, the count is 0. */
  readonly leaked: number;
  /** The rows with one or more reports in the log. */
  readonly reported: readonly RowName[];
  /** The count of reports in an `ended` or `back` event with no row of the case. */
  readonly unknown: number;
  /** The message of a throw of a pass. */
  readonly error?: string;
}

const ROW_OF_UGC: ReadonlyMap<string, RowName> = new Map(ROW_NAMES.map((row) => [String(ROWS[row]["ugc"]), row]));

/** This function gives the row of the case of an observation of the IEM source, from the UGC code of its body. */
export function rowOf(observation: Pick<Observation, "body">): RowName | undefined {
  try {
    const body = JSON.parse(observation.body) as unknown;
    const ugc = typeof body === "object" && body !== null && "ugc" in body ? body.ugc : undefined;
    return typeof ugc === "string" ? ROW_OF_UGC.get(ugc) : undefined;
  } catch {
    return undefined;
  }
}

/** This function adds the row of each new report in the events to `rows`. The events of a fetch name the observation of each report. */
function learnRows(events: readonly RuntimeEvent[], observations: Map<string, RowName | undefined>, rows: Map<ReportId, RowName | undefined>): void {
  for (const event of events) {
    if (event.type === "observation") observations.set(event.observation.id, rowOf(event.observation));
    if (event.type === "fetch") for (const report of event.reports) rows.set(report.id, observations.get(report.observation));
  }
}

/** This function starts one arm: a server, a proxy behind its own server, a new runtime and its passes on a new clock. */
export async function runStaleArm(arm: StaleArm, settings: StaleSettings = CASE_6_SETTINGS): Promise<StaleRecord> {
  const olds = OLD_LISTS[arm];
  const fresh = Array.from({ length: settings.fetches }, (_, fetch) => fetch).filter((fetch) => !olds.has(fetch));
  const server = await startScriptedServer({ routes: [{ path: LIST_PATH, replies: fresh.map((fetch) => ({ fields: JSON_TYPE, body: listOf(fetch) })) }] });
  const behind = olds.size === 0 ? undefined : await startScriptedServer({ routes: [] });
  const proxy = behind === undefined ? undefined : await startFaultProxy({ target: { host: behind.host, port: behind.port }, plan: faultPlanOf(oldAnswersOf(arm)), protocol: "http" });
  const clock = caseClock(settings.start, settings.speed);
  const counts: StaleRoutes = { direct: 0, old: 0 };
  const transport = staleTransport({
    inner: fetchTransport({ userAgent: USER_AGENT }),
    direct: server.url,
    old: proxy === undefined ? CASE_6_ORIGIN : `http://${proxy.host}:${String(proxy.port)}`,
    olds: new Set(olds.keys()),
    counts,
  });
  const jitter = random(`${CASE_6_ID}-${arm}`);
  // The pace of production: the pace of an instance on the case clock, with the jitter of the arm.
  const pace = { ...sourcePace({ now: clock.now, after: clock.after }, clock, 1), random: () => jitter.next() };
  const inner = createIemSource({ pace, transport, userAgent: USER_AGENT, baseUrl: CASE_6_ORIGIN });
  const outcomes: FetchOutcome[] = [];
  const source: SourceProcedures = {
    ...inner,
    fetch: async (input) => {
      const outcome = await inner.fetch(input);
      outcomes.push(outcome);
      return outcome;
    },
  };
  const log = openRuntimeLog(":memory:");
  const fetches: StaleFetch[] = [];
  const observations = new Map<string, RowName | undefined>();
  const rows = new Map<ReportId, RowName | undefined>();
  let unknown = 0;
  let error: string | undefined;
  try {
    const runtime = openRuntime({ log, clock, sources: [source], watch: () => IEM_WATCH, view: VIEW, run: `${CASE_6_ID}-${arm}` });
    let seen = 0;
    // A pass with no fetch adds no fetch. The bound stops an arm whose source does not fetch.
    for (let pass = 0; fetches.length < settings.fetches && pass < 4 * settings.fetches; pass += 1) {
      const result = await runtime.pass();
      const all = [...log.read()];
      const events = all.slice(seen);
      seen = all.length;
      learnRows(events, observations, rows);
      const rowsOf = (type: "ended" | "back"): RowName[] =>
        events.flatMap((event) =>
          event.type === type
            ? event.reports.flatMap((report) => {
                const row = rows.get(report);
                if (row === undefined) unknown += 1;
                return row === undefined ? [] : [row];
              })
            : [],
        );
      const outcome = outcomes[fetches.length];
      if (result.fetched.includes(SOURCE_ID) && outcome !== undefined) {
        const fetch = fetches.length;
        fetches.push({
          fetch,
          at: result.at - settings.start,
          old: olds.has(fetch),
          ok: outcome.ok,
          complete: outcome.ok && outcome.complete,
          rows: outcome.ok ? outcome.observations.flatMap((observation) => rowOf(observation) ?? []) : [],
          ended: rowsOf("ended"),
          back: rowsOf("back"),
        });
      }
      const next = Math.min(result.wakeAt ?? Number.POSITIVE_INFINITY, clock.now() + IEM_DESCRIPTOR.interval);
      await clock.sleep(next - clock.now());
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  log.close();
  await proxy?.close();
  const leaked = behind?.requests.length ?? 0;
  await behind?.close();
  const served = server.requests.length;
  await server.close();
  return {
    arm,
    fetches,
    requests: { ...counts },
    faults: proxy?.records.length ?? 0,
    served,
    leaked,
    reported: ROW_NAMES.filter((row) => [...rows.values()].includes(row)),
    unknown,
    ...(error === undefined ? {} : { error }),
  };
}

/** The gates of an arm. */
export interface StaleGates {
  readonly noFalseEnd: boolean;
  readonly noFalseBack: boolean;
  readonly settles: boolean;
}

/** The names of the gates, in their order. */
export const STALE_GATES: readonly (keyof StaleGates)[] = ["noFalseEnd", "noFalseBack", "settles"];

/** A row of an event at a fetch. */
export interface RowAt {
  readonly fetch: number;
  readonly row: RowName;
}

/** The gates of an arm, and the events that decide them. */
export interface StaleResult {
  readonly gates: StaleGates;
  /** Each end of a report whose row is in the true list of its fetch. */
  readonly falseEnds: readonly RowAt[];
  /** Each return of a report whose row is not in the true list of its fetch. */
  readonly falseBacks: readonly RowAt[];
  /** The rows whose reports ended after the last fetch. */
  readonly endedAtEnd: readonly RowName[];
}

/** This function gives the gates of an arm from the `ended` and `back` events of each fetch. */
export function staleGatesOf(record: Pick<StaleRecord, "fetches">): StaleResult {
  const falseEnds: RowAt[] = [];
  const falseBacks: RowAt[] = [];
  const ended = new Set<RowName>();
  for (const { fetch, ended: ends, back } of record.fetches) {
    const truth = new Set(trueRows(fetch));
    for (const row of ends) {
      if (truth.has(row)) falseEnds.push({ fetch, row });
      ended.add(row);
    }
    for (const row of back) {
      if (!truth.has(row)) falseBacks.push({ fetch, row });
      ended.delete(row);
    }
  }
  const last = record.fetches.at(-1);
  const out = last === undefined ? [] : ROW_NAMES.filter((row) => !trueRows(last.fetch).includes(row));
  const endedAtEnd = ROW_NAMES.filter((row) => ended.has(row));
  const settles = last !== undefined && endedAtEnd.length === out.length && out.every((row) => ended.has(row));
  return { gates: { noFalseEnd: falseEnds.length === 0, noFalseBack: falseBacks.length === 0, settles }, falseEnds, falseBacks, endedAtEnd };
}

/** The verdict of the case. A case with no read does not pass. */
export interface StaleVerdict {
  /**
   * True when the settings are valid, and each arm has each fetch with no error. Each true list is complete. Each old list
   * came from the proxy, and none got past it. The only event of the control is the end of `r3` at its fetch.
   */
  readonly read: boolean;
  readonly results: Readonly<Partial<Record<StaleArm, StaleResult>>>;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** This function gives each problem of the settings. The last old list needs `SNAPSHOT_MISSES` true lists after it, for `settles`. */
export function staleSettingsProblems(settings: StaleSettings): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(settings.speed) || settings.speed < 1) problems.push(`The speed ${String(settings.speed)} is not a finite number of 1 or more.`);
  const lastOld = Math.max(R3_UNTIL, ...STALE_ARMS.flatMap((arm) => [...OLD_LISTS[arm].keys()]));
  if (settings.fetches <= lastOld + SNAPSHOT_MISSES) problems.push(`The arm has ${String(settings.fetches)} fetches, too few for the end of a report after fetch ${String(lastOld)}.`);
  const latest = settings.start + settings.fetches * IEM_DESCRIPTOR.interval;
  for (const row of ROW_NAMES) {
    if (Date.parse(String(ROWS[row]["utc_expire"])) <= latest) problems.push(`The row ${row} expires in the arm.`);
  }
  return problems;
}

/** This function gives the verdict of the records of a run. */
export function staleVerdictOf(records: readonly StaleRecord[], settings: StaleSettings = CASE_6_SETTINGS): StaleVerdict {
  const problems = staleSettingsProblems(settings);
  for (const arm of STALE_ARMS) {
    const count = records.filter((record) => record.arm === arm).length;
    if (count !== 1) problems.push(`${arm}: ${String(count)} records, not 1.`);
  }
  for (const record of records) {
    const olds = OLD_LISTS[record.arm];
    if (record.error !== undefined) problems.push(`${record.arm}: a pass threw: ${record.error}`);
    if (record.fetches.length !== settings.fetches) problems.push(`${record.arm}: ${String(record.fetches.length)} fetches, not ${String(settings.fetches)}.`);
    const incomplete = record.fetches.filter((fetch) => !fetch.ok || (!fetch.old && !fetch.complete));
    if (incomplete.length > 0) problems.push(`${record.arm}: the fetches ${incomplete.map((fetch) => fetch.fetch).join(", ")} failed or gave a true list as not complete.`);
    if (record.requests.old !== olds.size || record.faults !== olds.size) {
      problems.push(`${record.arm}: ${String(record.requests.old)} requests to the proxy and ${String(record.faults)} faults, not ${String(olds.size)}.`);
    }
    if (record.leaked > 0) problems.push(`${record.arm}: ${String(record.leaked)} requests got to the server behind the proxy.`);
    if (record.served !== settings.fetches - olds.size) problems.push(`${record.arm}: the server read ${String(record.served)} requests, not ${String(settings.fetches - olds.size)}.`);
    if (record.reported.length !== ROW_NAMES.length) problems.push(`${record.arm}: the log has reports of the rows ${record.reported.join(", ") || "none"}, not of each row.`);
    if (record.unknown > 0) problems.push(`${record.arm}: ${String(record.unknown)} reports of an end or a return have no row of the case.`);
  }
  const control = records.find((record) => record.arm === "control");
  const endsAt = R3_UNTIL + SNAPSHOT_MISSES - 1;
  const events = control?.fetches.filter((fetch) => fetch.ended.length + fetch.back.length > 0) ?? [];
  if (events.length !== 1 || events[0]?.fetch !== endsAt || events[0].ended.join() !== "r3" || events[0].back.length > 0) {
    problems.push(`control: the only event is not the end of r3 at fetch ${String(endsAt)}.`);
  }
  const read = problems.length === 0;
  const results: Partial<Record<StaleArm, StaleResult>> = {};
  for (const record of records) results[record.arm] = staleGatesOf(record);
  const pass = read && STALE_ARMS.every((arm) => STALE_GATES.every((gate) => results[arm]?.gates[gate] === true));
  return { read, results, pass, problems };
}

/** The records of one run of the case. */
export interface StaleRun {
  readonly id: string;
  readonly seed: string;
  readonly settings: StaleSettings;
  readonly records: readonly StaleRecord[];
  readonly verdict: StaleVerdict;
}

/** This function starts the case: each arm at the same time. It gives the records and the verdict. */
export async function runStaleList(given: Partial<StaleSettings> = {}): Promise<StaleRun> {
  const settings: StaleSettings = { ...CASE_6_SETTINGS, ...given };
  const records = await Promise.all(STALE_ARMS.map((arm) => runStaleArm(arm, settings)));
  return { id: CASE_6_ID, seed: CASE_6_ID, settings, records, verdict: staleVerdictOf(records, settings) };
}
