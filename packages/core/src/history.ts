/**
 * This module gives the history of the incidents for a time scrubber. The history of an incident has the parts of the
 * incident that this copy knew after each time of entry of its reports. The history is a pure calculation over the merge
 * state. The runtime gives it on its route `GET /history`, and a page replays how each incident grew.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import { assess, higherLevel, reachedAssessment } from "./assess.ts";
import type { AssessedLevel, AssessPolicy, EndMark, Incident, Instant, Kind, MergeState, PersonWatch, RegionCode, Report, ReportId, Severity, Status } from "./contracts.ts";
import { compareRegionCodes, regionCodeKey, SEVERITY_ORDER, type MapPlaceInput, type MapShape, type ShapeLookup } from "./map.ts";
import { incidents, type IncidentOptions, type LinkRule } from "./merge.ts";
import { areasWithoutBlocks, distinctShapes } from "./shapes.ts";

/** The name of the format of the history payload. A change that breaks a reader gets a new name. */
export const HISTORY_FORMAT = "alerts-history/1";

/**
 * One change of an incident: the parts of the incident that this copy knew at one time. A change comes at each time of
 * entry of a report of the incident. An end mark of a known report of the incident also gives a change.
 */
export interface HistoryChange {
  /** The time of the change on this copy. */
  readonly at: Instant;
  /** The reports of the incident that came in at this time, from the smallest. A change of an end mark only has no report. */
  readonly reports: readonly ReportId[];
  /** The highest level over each person at the time of the change, after the policy and the mutes. */
  readonly level: AssessedLevel;
  /** The highest severity of the parts at the time of the change. */
  readonly severity: Severity;
  /** False when each part ended at the time of the change. */
  readonly live: boolean;
  /** The earliest onset of the parts. */
  readonly onset?: Instant;
  /** The latest expiry of the parts. A part with no expiry gives no expiry. */
  readonly expires?: Instant;
  /** The region codes of the areas with a shape, in the order of the system and the code. The field `regions` of the payload has their shapes. */
  readonly codes: readonly RegionCode[];
  /** The polygons and the circles of the areas. Each shape comes one time. */
  readonly shapes: readonly MapShape[];
  /** The region codes of the areas with no shape in the store, in the order of the system and the code. */
  readonly unshaped: readonly RegionCode[];
}

/** The history of one incident of the merge state. */
export interface HistoryIncident {
  /** The anchor of the incident at the time of the payload. */
  readonly anchor: ReportId;
  /** The report ids of the incident at the time of the payload, from the smallest. */
  readonly reports: readonly ReportId[];
  readonly status: Status;
  readonly kind: Kind;
  /** The changes, from the oldest. */
  readonly changes: readonly HistoryChange[];
}

/** The shapes of one region code of the history, from the store of shapes. */
export interface HistoryRegion {
  readonly code: RegionCode;
  readonly shapes: readonly MapShape[];
}

/**
 * The answer of the history route of the runtime. The route is on the loopback address only, because the levels come
 * from the choices of the people. A reader replaces the history of each incident of the payload. It also drops each
 * history whose anchor is a report of an incident of the payload, because these incidents merged.
 */
export interface HistoryPayload {
  /** The format of the payload. A page of another format tells the reader to start the runtime of its own version. */
  readonly format: typeof HISTORY_FORMAT;
  /** The time of the history: the time of the last pass, or `null` before the first pass. */
  readonly at: Instant | null;
  /** The payload has each incident with a change at this time or later. The value `null` gives each incident. */
  readonly since: Instant | null;
  /**
   * The time of the newest change of the merge state, or `null` with no change. A reader gives it as `since` of its next
   * read. A value below the `since` of the read tells that a step of the clock moved the times back. Then the reader
   * reads each incident again with no `since`.
   */
  readonly next: Instant | null;
  /** The incidents with a change at `since` or later, in the order of their anchors. Each incident has each of its changes. */
  readonly incidents: readonly HistoryIncident[];
  /** The shapes of each code of the changes of the payload, one time each, in the order of the system and the code. */
  readonly regions: readonly HistoryRegion[];
}

/**
 * The times of entry on this copy. A report or an end mark of another copy comes later than its own time. Also, the
 * clock of the other copy is not the clock of this copy. Thus the history replays what this copy knew at each time.
 */
export interface EntryTimes {
  /** This function gives the time of entry of a report on this copy. */
  report(report: Report): Instant;
  /** This function gives the time of entry of an end mark on this copy. */
  mark(mark: EndMark): Instant;
}

/** The times of entry with no import: the time of receipt of each report, and the time of each end mark. */
export const OWN_ENTRY_TIMES: EntryTimes = { report: (report) => report.received, mark: (mark) => mark.at };

/** These are the inputs of the history payload. */
export interface HistoryInput {
  /** The time of the history: the time of the last pass, or `null` before the first pass. */
  readonly at: Instant | null;
  /** The payload gives only the incidents with a change at this time or later. The default `null` gives each incident. */
  readonly since?: Instant | null;
  /** The merge state of the copy. The history has the incidents of this state. */
  readonly merge: MergeState;
  /** The times of entry on this copy. The default `OWN_ENTRY_TIMES` reads the times of the copy that wrote each part. */
  readonly entered?: EntryTimes;
  /** The watches of the people. The level of each change is the highest level over these people. */
  readonly people: readonly PersonWatch[];
  readonly places: readonly MapPlaceInput[];
  /** The policy of the assessment: the policy of the delivery. The default is the policy of the core. */
  readonly policy?: AssessPolicy;
  readonly shape: ShapeLookup;
  /** The link rule of the delivery step and the view. */
  readonly link?: LinkRule;
}

/**
 * This function gives the payload of the history route. At each time of a change, it makes the incidents of the known
 * reports of each incident, at that time. Two parts of an incident before their merge give one change: the highest
 * level and severity, and each area of the two parts. The work for an incident with no change at `since` or later is
 * only the read of its times.
 */
export function historyPayload(input: HistoryInput): HistoryPayload {
  const since = input.since ?? null;
  const entered = input.entered ?? OWN_ENTRY_TIMES;
  const options: IncidentOptions = input.link === undefined ? {} : { link: input.link };
  const byId = new Map(input.merge.reports.map((report) => [report.id, report]));
  const entries = new Map(input.merge.reports.map((report) => [report.id, entered.report(report)]));
  // Each end mark has its time of entry. Thus the parts at a time have only the marks that this copy knew at that time.
  const marks = new Map<ReportId, EndMark[]>();
  for (const mark of input.merge.ends) marks.set(mark.report, [...(marks.get(mark.report) ?? []), { ...mark, at: entered.mark(mark) }]);
  const lookups = new Map<string, readonly MapShape[] | undefined>();
  const lookup = (code: RegionCode): readonly MapShape[] | undefined => {
    const key = regionCodeKey(code);
    if (!lookups.has(key)) lookups.set(key, input.shape(code));
    return lookups.get(key);
  };

  let next: Instant | null = null;
  const shown: HistoryIncident[] = [];
  // The groups of the reports do not read the time. Thus the time of the current incidents changes nothing.
  for (const incident of incidents(input.merge, input.at ?? 0, options)) {
    const own = incident.reports.flatMap((id) => byId.get(id) ?? []);
    const ownMarks = incident.reports.flatMap((id) => marks.get(id) ?? []);
    const times = [...new Set([...own.map((report) => entries.get(report.id)!), ...ownMarks.map((mark) => mark.at)])].sort((a, b) => a - b);
    const last = times.at(-1);
    if (last === undefined) continue;
    if (next === null || last > next) next = last;
    if (since !== null && last < since) continue;
    const changes: HistoryChange[] = [];
    for (const at of times) {
      const known = own.filter((report) => entries.get(report.id)! <= at);
      if (known.length === 0) continue;
      const came = known.filter((report) => entries.get(report.id) === at).map((report) => report.id);
      const marked = new Set(ownMarks.filter((mark) => mark.at === at).map((mark) => mark.report));
      if (came.length === 0 && !known.some((report) => marked.has(report.id))) continue;
      const parts = incidents({ ...input.merge, reports: known, ends: ownMarks }, at, options);
      changes.push(changeOf(at, parts, came.sort(compareCodeUnits), input, lookup));
    }
    shown.push({ anchor: incident.anchor, reports: incident.reports, status: incident.status, kind: incident.kind, changes });
  }

  const regions = new Map<string, HistoryRegion>();
  for (const change of shown.flatMap((incident) => incident.changes)) {
    for (const code of change.codes) {
      const key = regionCodeKey(code);
      if (!regions.has(key)) regions.set(key, { code, shapes: distinctShapes(lookup(code) ?? []) });
    }
  }
  return { format: HISTORY_FORMAT, at: input.at, since, next, incidents: shown, regions: [...regions.values()].sort((a, b) => compareRegionCodes(a.code, b.code)) };
}

// The change of the parts of one incident at a time.
function changeOf(at: Instant, parts: readonly Incident[], reports: readonly ReportId[], input: HistoryInput, lookup: ShapeLookup): HistoryChange {
  let level: AssessedLevel = "none";
  for (const part of parts) {
    for (const person of input.people) level = higherLevel(level, reachedAssessment(assess(part, person, input.places, input.policy, at)).level);
  }
  const severity = parts.map((part) => part.severity).reduce((a, b) => (SEVERITY_ORDER.indexOf(b) < SEVERITY_ORDER.indexOf(a) ? b : a));
  const onsets = parts.flatMap((part) => (part.onset === undefined ? [] : [part.onset]));
  const expiries = parts.map((part) => part.expires);
  const codes = new Map<string, RegionCode>();
  const unshaped = new Map<string, RegionCode>();
  const shapes: MapShape[] = [];
  for (const area of areasWithoutBlocks(parts.flatMap((part) => part.areas))) {
    if (area.type === "polygon" || area.type === "circle") shapes.push(area);
    else if (area.type === "code") {
      const code = { system: area.system, code: area.code };
      const found = lookup(code);
      (found === undefined || found.length === 0 ? unshaped : codes).set(regionCodeKey(code), code);
    }
  }
  return {
    at,
    reports,
    level,
    severity,
    live: parts.some((part) => part.live),
    ...(onsets.length === 0 ? {} : { onset: Math.min(...onsets) }),
    ...(expiries.some((expires) => expires === undefined) ? {} : { expires: Math.max(...expiries.map((expires) => expires!)) }),
    codes: [...codes.values()].sort(compareRegionCodes),
    shapes: distinctShapes(shapes),
    unshaped: [...unshaped.values()].sort(compareRegionCodes),
  };
}
