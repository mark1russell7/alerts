/**
 * AL-13, case 3: a changed format. The NWS changes the format of its replies. The alert system must not change the level
 * of an alert with no sign of the change.
 *
 * A fault proxy of `@mark1russell7/rigor-proxy` puts an `answer` in place of the main reply: the status 200 and the main
 * body with one change. The case has one arm for each change:
 *
 * - `geocode-renamed`: each key of each geocode becomes lowercase, so `UGC` and `SAME` become `ugc` and `same`.
 * - `features-renamed`: the key `features` of the collection becomes `alerts`.
 * - `sent-epoch`: the sent time of each alert becomes a count of milliseconds since 1970.
 * - `severity-renamed`: the severities `Extreme`, `Severe`, `Moderate` and `Minor` become `Critical`, `High`, `Medium` and `Low`.
 * - `urgency-renamed`: the urgencies `Immediate`, `Expected`, `Future` and `Past` become `Now`, `Soon`, `Later` and `Over`.
 * - `field-added`: each alert gets the new field `colour`. This change keeps the meaning of each alert.
 *
 * For each arm, `fetchEvents` of the runtime makes the record of the fetch, and the case adds it to the health of the
 * source. Then it assesses each alert for one person who watches the regions of each alert of the baseline.
 *
 * The gate of an arm that changes a meaning: each alert keeps its level, or the health is `changed` or `failing`. The
 * gate of an arm that keeps the meaning: each alert keeps its level, and the health is not `changed` or `failing`.
 */
import {
  add,
  assess,
  type AssessedLevel,
  DEFAULT_ASSESS_POLICY,
  EMPTY_STATE,
  type FetchOutcome,
  type FetchRecord,
  type HealthState,
  type HealthTrack,
  incidents,
  type Instant,
  type MapProblem,
  type Observation,
  observeFetch,
  type PersonId,
  type PersonWatch,
  type PlaceId,
  type Report,
  type SourceProcedures,
  startHealth,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { fetchEvents } from "@mark1russell7/alerts-runtime";
import { checkCanary, mapObservation, NWS_DESCRIPTOR, SOURCE_ID } from "@mark1russell7/alerts-source-nws-api";
import { type Fault, faultPlanOf } from "@mark1russell7/rigor-chaos";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { caseBodies, type FetchLimits, type FetchResult, fetchResult, mainAfter, type OutcomeSummary, startNwsServer, summaryOf } from "./nws.ts";

/** The id of the case. */
export const CASE_3_ID = "al-13-case-3";

/** An arm of the case: one change of the format of the main reply. */
export type FormatArm = "geocode-renamed" | "features-renamed" | "sent-epoch" | "severity-renamed" | "urgency-renamed" | "field-added";

/** The arms of the case, in the order of a run. */
export const FORMAT_ARMS: readonly FormatArm[] = ["geocode-renamed", "features-renamed", "sent-epoch", "severity-renamed", "urgency-renamed", "field-added"];

/** The arms whose change keeps the meaning of each alert. Their gate also refuses a false change of the health. */
export const KEEPING_ARMS: ReadonlySet<FormatArm> = new Set<FormatArm>(["field-added"]);

/** The time limits of the fetches of the case. The scripted server answers in some milliseconds. */
export const CASE_3_LIMITS: FetchLimits = { timeoutMs: 5000 };

const SEVERITY_NAMES: Readonly<Record<string, string>> = { Extreme: "Critical", Severe: "High", Moderate: "Medium", Minor: "Low" };
const URGENCY_NAMES: Readonly<Record<string, string>> = { Immediate: "Now", Expected: "Soon", Future: "Later", Past: "Over" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const renamed = (names: Readonly<Record<string, string>>, value: unknown): unknown => (typeof value === "string" ? (names[value] ?? value) : value);

function changeProperties(arm: FormatArm, properties: Record<string, unknown>): Record<string, unknown> {
  switch (arm) {
    case "geocode-renamed": {
      const geocode = properties["geocode"];
      if (!isRecord(geocode)) return properties;
      return { ...properties, geocode: Object.fromEntries(Object.entries(geocode).map(([key, value]) => [key.toLowerCase(), value])) };
    }
    case "sent-epoch": {
      const sent = properties["sent"];
      return typeof sent === "string" ? { ...properties, sent: Date.parse(sent) } : properties;
    }
    case "severity-renamed":
      return { ...properties, severity: renamed(SEVERITY_NAMES, properties["severity"]) };
    case "urgency-renamed":
      return { ...properties, urgency: renamed(URGENCY_NAMES, properties["urgency"]) };
    case "field-added":
      return { ...properties, colour: "red" };
    case "features-renamed":
      return properties;
  }
}

/**
 * This function gives the main body with the change of an arm. The body is a feature collection. The function does not
 * change its input.
 */
export function changeOf(arm: FormatArm, collection: unknown): unknown {
  if (!isRecord(collection) || !Array.isArray(collection["features"])) throw new Error("the main body is not a feature collection");
  if (arm === "features-renamed") {
    const { features, ...rest } = collection;
    return { ...rest, alerts: features };
  }
  const features: readonly unknown[] = collection["features"];
  return {
    ...collection,
    features: features.map((feature) =>
      isRecord(feature) && isRecord(feature["properties"]) ? { ...feature, properties: changeProperties(arm, feature["properties"]) } : feature,
    ),
  };
}

/** The level of one alert of the baseline. The key of the alert is the id of its report. */
export interface AlertLevel {
  readonly report: string;
  readonly level: AssessedLevel;
}

/** The level of one alert of the baseline before and after the change of an arm. */
export interface LevelChange {
  readonly report: string;
  readonly before: AssessedLevel;
  readonly after: AssessedLevel;
}

/** The fetch of the server with no fault. */
export interface FormatBaseline {
  /** True when the main reply started its connection and the server wrote it whole. */
  readonly whole: boolean;
  readonly outcome: OutcomeSummary;
  /** The count of the reports of the map. */
  readonly reports: number;
  readonly problems: readonly MapProblem[];
  /** The health after the record of the baseline fetch. */
  readonly health: HealthState;
  /**
   * The time of the assessments: the newest sent time of the actual reports of the baseline. The keepalive of the canary
   * has the time of the run, so it does not count. Thus the levels do not change with the clock.
   */
  readonly at: Instant;
  /** The level of each alert of the baseline, for the person of the case. */
  readonly levels: readonly AlertLevel[];
}

/** The record of one arm. */
export interface FormatRecord {
  readonly arm: FormatArm;
  /** True when the proxy put its answer in place of the main reply: connection 0, down, frame 0. */
  readonly answered: boolean;
  readonly outcome: OutcomeSummary;
  /** True when the canary check of the fetch passed. A failed canary moves the health with no relation to the change. */
  readonly canary: boolean;
  /** The count of the reports of the map. */
  readonly reports: number;
  readonly fatal: readonly MapProblem[];
  /** The problems that keep the report, but the report lacks a value of the message or holds a fallback. */
  readonly lossy: readonly MapProblem[];
  /** The problems that keep the whole report. */
  readonly notes: readonly MapProblem[];
  /** The health after the record of the fetch of the arm. */
  readonly health: HealthState;
  /** The level of each alert of the baseline before and after the change. */
  readonly levels: readonly LevelChange[];
}

/** The verdict of a run. */
export interface FormatVerdict {
  /** False when the case cannot read. No read is not a pass. */
  readonly read: boolean;
  readonly pass: boolean;
  /** The gate of each arm. */
  readonly gates: Readonly<Record<FormatArm, boolean>>;
  readonly problems: readonly string[];
}

/** The records of one run of the case. */
export interface FormatRun {
  readonly id: string;
  readonly bodyBytes: number;
  readonly baseline: FormatBaseline;
  readonly records: readonly FormatRecord[];
  readonly verdict: FormatVerdict;
}

/** The options of a run. */
export interface FormatOptions {
  readonly arms?: readonly FormatArm[];
  readonly limits?: FetchLimits;
}

/** The health states that tell of a problem of the source. */
const TOLD: ReadonlySet<HealthState> = new Set<HealthState>(["changed", "failing"]);

/** This function gives the alerts of a record whose level changed. */
export const changesOf = (record: Pick<FormatRecord, "levels">): readonly LevelChange[] => record.levels.filter((one) => one.before !== one.after);

/** The map of the observations of one fetch. */
interface Mapped {
  readonly observations: readonly Observation[];
  readonly reports: readonly Report[];
  readonly problems: readonly MapProblem[];
}

function mapResult(result: FetchResult): Mapped {
  if ("thrown" in result || !result.outcome.ok) return { observations: [], reports: [], problems: [] };
  const observations = result.outcome.observations;
  const mapped = observations.map((observation) => mapObservation(observation));
  return { observations, reports: mapped.flatMap((one) => one.reports), problems: mapped.flatMap((one) => one.problems) };
}

/** The map and the canary check of the NWS source, as `createNwsSource` gives them. */
const PROCEDURES: Pick<SourceProcedures, "map" | "check"> = {
  map: ({ observation }) => mapObservation(observation),
  check: ({ observations }) => checkCanary(observations),
};

// The record of one fetch comes from `fetchEvents` of the runtime, so the case measures the fold of production.
function recordOf(result: FetchResult, at: Instant, took: number, known: ReadonlySet<string>): FetchRecord {
  const outcome: FetchOutcome = "thrown" in result ? { ok: false, failure: { kind: "network", message: `the fetch threw: ${result.thrown}` } } : result.outcome;
  const events = fetchEvents({ source: SOURCE_ID, procedures: PROCEDURES, started: at, ended: at + took, outcome, known: (id) => known.has(id) });
  const last = events.at(-1);
  if (last?.type !== "fetch") throw new Error("fetchEvents gave no fetch event");
  return last.record;
}

const outcomeOf = (result: FetchResult): OutcomeSummary => ("thrown" in result ? { ok: false, kind: "thrown", message: result.thrown } : summaryOf(result.outcome));

/** The person of the case: one place for each alert of the baseline, with the UGC codes of the alert, and no rule. */
export function watchOf(reports: readonly Report[]): { readonly person: PersonWatch; readonly places: readonly WatchedPlace[] } {
  const places = reports
    .map((report, index): WatchedPlace => ({
      id: `alert-${String(index)}` as PlaceId,
      codes: report.areas.flatMap((area) => (area.type === "code" && area.system === "ugc" ? [{ system: "ugc", code: area.code }] : [])),
      bufferKm: 0,
    }))
    .filter((place) => place.codes.length > 0);
  return { person: { person: "case-3" as PersonId, places: places.map((place) => place.id), rules: [] }, places };
}

/** This function gives the level of each report at a time: the level of its incident for the person. */
export function levelsOf(reports: readonly Report[], at: Instant, person: PersonWatch, places: readonly WatchedPlace[]): ReadonlyMap<string, AssessedLevel> {
  const levels = new Map<string, AssessedLevel>();
  for (const incident of incidents(add(EMPTY_STATE, { reports }), at)) {
    const { level } = assess(incident, person, places, DEFAULT_ASSESS_POLICY, at);
    for (const id of incident.reports) levels.set(id, level);
  }
  return levels;
}

/**
 * This function gives the time of the assessments of a baseline: the newest sent time of its actual reports. The canary
 * keepalive is a test message with the time of the run. When it counts, the recorded alerts end before that time, and
 * the case stops to read (AL-13).
 */
export function baselineAt(reports: readonly Pick<Report, "status" | "sent">[]): Instant {
  return reports.reduce((newest, report) => (report.status === "actual" ? Math.max(newest, report.sent) : newest), 0);
}

/** This function starts the case: a baseline fetch, then one fetch for each arm through a fault proxy. It gives the records and the verdict. */
export async function runChangedFormat(options: FormatOptions = {}): Promise<FormatRun> {
  const { arms = FORMAT_ARMS, limits = CASE_3_LIMITS } = options;
  // The canary check needs a recent keepalive, so the canary body gets a sent time at the start of the run.
  const bodies = caseBodies({ keepaliveSent: Date.now() });
  const main: unknown = JSON.parse(new TextDecoder().decode(bodies.main));
  const server = await startNwsServer(bodies, "length");
  try {
    const from = server.requests.length;
    const started = Date.now();
    const result = await fetchResult(server.url, limits);
    const took = Date.now() - started;
    const wire = mainAfter(server, from)?.wire;
    const mapped = mapResult(result);
    const known = new Set(mapped.observations.map((observation) => observation.id));
    const first = observeFetch(startHealth(SOURCE_ID, started), recordOf(result, started, took, new Set()), NWS_DESCRIPTOR);
    const at = baselineAt(mapped.reports);
    const { person, places } = watchOf(mapped.reports);
    const before = levelsOf(mapped.reports, at, person, places);
    const baseline: FormatBaseline = {
      whole: wire !== undefined && wire.offset === 0 && wire.whole,
      outcome: outcomeOf(result),
      reports: mapped.reports.length,
      problems: mapped.problems,
      health: first.health.state,
      at,
      levels: mapped.reports.map((report) => ({ report: report.id, level: before.get(report.id) ?? "none" })),
    };
    const records: FormatRecord[] = [];
    for (const arm of arms) {
      records.push(await runArm(arm, main, server, limits, first.track, known, baseline, person, places));
    }
    return { id: CASE_3_ID, bodyBytes: bodies.main.length, baseline, records, verdict: formatVerdictOf(baseline, records, arms) };
  } finally {
    await server.close();
  }
}

async function runArm(
  arm: FormatArm,
  main: unknown,
  server: { readonly host: string; readonly port: number },
  limits: FetchLimits,
  track: HealthTrack,
  known: ReadonlySet<string>,
  baseline: FormatBaseline,
  person: PersonWatch,
  places: readonly WatchedPlace[],
): Promise<FormatRecord> {
  const fault: Fault = {
    connection: 0,
    direction: "down",
    at: { frame: 0 },
    kind: "answer",
    status: 200,
    fields: { "content-type": "application/geo+json" },
    body: JSON.stringify(changeOf(arm, main)),
  };
  const proxy = await startFaultProxy({ target: { host: server.host, port: server.port }, plan: faultPlanOf([fault]), protocol: "http" });
  let result: FetchResult;
  const started = Date.now();
  try {
    result = await fetchResult(`http://${proxy.host}:${String(proxy.port)}`, limits);
  } finally {
    await proxy.close();
  }
  const took = Date.now() - started;
  const mapped = mapResult(result);
  const record = recordOf(result, started, took, known);
  const step = observeFetch(track, record, NWS_DESCRIPTOR);
  const after = levelsOf(mapped.reports, baseline.at, person, places);
  return {
    arm,
    answered: proxy.records.some((r) => r.kind === "answer" && r.connection === 0 && r.direction === "down" && r.frame === 0),
    outcome: outcomeOf(result),
    canary: record.canary?.pass === true,
    reports: mapped.reports.length,
    fatal: mapped.problems.filter((problem) => problem.fatal),
    lossy: mapped.problems.filter((problem) => problem.lossy === true),
    notes: mapped.problems.filter((problem) => !problem.fatal && problem.lossy !== true),
    health: step.health.state,
    levels: baseline.levels.map(({ report, level }) => ({ report, before: level, after: after.get(report) ?? "none" })),
  };
}

/**
 * This function gives the verdict of the records of a run. The case reads when the baseline is whole and healthy, with an
 * alert that has a level. Each arm also needs one record with its answer and a passed canary.
 */
export function formatVerdictOf(baseline: FormatBaseline, records: readonly FormatRecord[], arms: readonly FormatArm[] = FORMAT_ARMS): FormatVerdict {
  const problems: string[] = [];
  let read = true;
  const noRead = (problem: string): void => {
    read = false;
    problems.push(problem);
  };
  if (!baseline.whole) noRead("the baseline main reply is not whole on the wire");
  if (!baseline.outcome.ok || !baseline.outcome.complete) noRead("the baseline fetch did not give a complete list");
  if (baseline.health !== "healthy") noRead(`the baseline health is ${baseline.health}, not healthy`);
  if (!baseline.levels.some((one) => one.level !== "none")) noRead("no alert of the baseline has a level, so a change of a level cannot show");
  const gates = {} as Record<FormatArm, boolean>;
  for (const arm of FORMAT_ARMS) gates[arm] = false;
  for (const arm of arms) {
    const of = records.filter((record) => record.arm === arm);
    const record = of[0];
    if (record === undefined || of.length !== 1) {
      noRead(`${arm}: ${String(of.length)} records, not 1`);
      continue;
    }
    if (!record.answered) noRead(`${arm}: the proxy did not put its answer in place of the main reply`);
    if (!record.outcome.ok && record.outcome.kind === "thrown") noRead(`${arm}: the fetch threw: ${record.outcome.message}`);
    if (record.outcome.ok && !record.canary) noRead(`${arm}: the canary check failed, so the health tells nothing of the change`);
    const changes = changesOf(record).length;
    const told = TOLD.has(record.health);
    const keeps = KEEPING_ARMS.has(arm);
    gates[arm] = keeps ? changes === 0 && !told : changes === 0 || told;
    if (!gates[arm]) {
      problems.push(
        keeps
          ? `${arm}: the change keeps the meaning, but ${String(changes)} levels changed and the health is ${record.health}`
          : `${arm}: ${String(changes)} levels changed silently: the health is ${record.health}`,
      );
    }
  }
  return { read, pass: read && arms.every((arm) => gates[arm]), gates, problems };
}
