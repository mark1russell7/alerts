/**
 * The merge of the alert system: the join of two merge states, and the incidents of a state.
 *
 * The join is the union of five grow-only sets, so it is idempotent, commutative and
 * associative. The incidents are a function of the state and a time. So each copy of the system
 * that gets the same reports gets the same incidents, in any order of arrival.
 */
import { stronglyConnectedComponents } from "@mark1russell7/collections/graph";
import { canonicalJson } from "@mark1russell7/rigor-generators";
import { compareCodeUnits } from "@mark1russell7/text/order";
import type {
  Acknowledgment,
  Area,
  Certainty,
  Delivery,
  EndMark,
  Incident,
  IncidentLine,
  Instant,
  Level,
  MergeState,
  PersonId,
  Report,
  ReportId,
  Severity,
  Tombstone,
  Urgency,
} from "./contracts.ts";
import { LEVELS } from "./contracts.ts";

/** The merge state with no part. */
export const EMPTY_STATE: MergeState = { reports: [], deliveries: [], acks: [], ends: [], retired: [] };

/** The parts of a merge state, in any order and with duplicates. */
export interface MergeParts {
  readonly reports?: readonly Report[];
  readonly deliveries?: readonly Delivery[];
  readonly acks?: readonly Acknowledgment[];
  readonly ends?: readonly EndMark[];
  readonly retired?: readonly Tombstone[];
}

/**
 * This function gives the one form of a merge state. It keeps one report for each id: for two
 * contents of one id, the content with the smaller canonical JSON. It keeps each delivery, each
 * acknowledgment and each end mark one time. It keeps one tombstone for each report, with the
 * latest `until`. Then it removes each report with a tombstone, and each delivery, acknowledgment
 * and end mark of such a report.
 */
export function normalize(parts: MergeParts): MergeState {
  const tombstones = new Map<ReportId, Tombstone>();
  for (const tombstone of parts.retired ?? []) {
    const held = tombstones.get(tombstone.report);
    if (held === undefined || tombstone.until > held.until) tombstones.set(tombstone.report, { report: tombstone.report, until: tombstone.until });
  }
  const kept = (report: ReportId): boolean => !tombstones.has(report);
  const reports = new Map<ReportId, { readonly report: Report; readonly text: string }>();
  for (const report of parts.reports ?? []) {
    if (!kept(report.id)) continue;
    const text = canonical(report);
    const held = reports.get(report.id);
    if (held === undefined || text < held.text) reports.set(report.id, { report, text });
  }
  return {
    reports: [...reports.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, held]) => held.report),
    deliveries: uniqueByText((parts.deliveries ?? []).filter((delivery) => kept(delivery.incident))),
    acks: uniqueByText((parts.acks ?? []).filter((ack) => kept(ack.incident))),
    ends: uniqueByText((parts.ends ?? []).filter((mark) => kept(mark.report))),
    retired: [...tombstones.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, tombstone]) => tombstone),
  };
}

/** This function gives the join of two merge states: the union of their parts. */
export function join(a: MergeState, b: MergeState): MergeState {
  return normalize({
    reports: [...a.reports, ...b.reports],
    deliveries: [...a.deliveries, ...b.deliveries],
    acks: [...a.acks, ...b.acks],
    ends: [...a.ends, ...b.ends],
    retired: [...a.retired, ...b.retired],
  });
}

/** This function adds parts to a merge state. A part that the state has already changes nothing. */
export function add(state: MergeState, parts: MergeParts): MergeState {
  return normalize({
    reports: [...state.reports, ...(parts.reports ?? [])],
    deliveries: [...state.deliveries, ...(parts.deliveries ?? [])],
    acks: [...state.acks, ...(parts.acks ?? [])],
    ends: [...state.ends, ...(parts.ends ?? [])],
    retired: [...state.retired, ...(parts.retired ?? [])],
  });
}

/**
 * The link rule of merge rule 3. The function `linkRule` makes the rule of a policy (`link.ts`,
 * `docs/CONTRACTS.md`). The merge tests only the pairs of reports that share a block. So the
 * cost grows with the size of the blocks, not with the square of the count of reports.
 */
export interface LinkRule {
  /** The blocks of a report, for example its family of kind and its day. A report with no block links to no report. */
  blocks(report: Report): readonly string[];
  /** True when two reports tell of one real event. It is symmetric, and it reads only the two reports. */
  matches(a: Report, b: Report): boolean;
}

/** The options of `incidents`. */
export interface IncidentOptions {
  /** The link rule of merge rule 3. When it is absent, the merge uses rules 1 and 2 only. */
  readonly link?: LinkRule;
}

/**
 * This function gives the incidents of a merge state at a time, in the order of their anchors.
 * The groups of reports do not use the time. Only the field `live` reads it.
 *
 * Two reports of one status are in one incident when one of these rules matches:
 *
 * 1. One report references the key of the other in the same source.
 * 2. The two reports share a correlation key.
 * 3. The link rule matches.
 *
 * A head of an incident is a report that no reference ends as a whole, and that no later report of
 * its origin replaces (the rule of the copies, `docs/CONTRACTS.md`). The areas of the incident are
 * the areas of its heads with no code that has a later statement.
 */
export function incidents(state: MergeState, at: Instant, options: IncidentOptions = {}): Incident[] {
  const reports = state.reports;
  const edges: number[][] = reports.map(() => []);
  const connect = (a: number, b: number): void => {
    edges[a]!.push(b);
    edges[b]!.push(a);
  };
  // Each report connects to the first report with the same key, so the reports of one key are connected.
  const firstOf = new Map<string, number>();
  const share = (key: string, index: number): void => {
    const first = firstOf.get(key);
    if (first === undefined) firstOf.set(key, index);
    else connect(first, index);
  };
  reports.forEach((report, index) => {
    share(JSON.stringify(["key", report.status, report.source, report.key]), index);
    for (const reference of report.references) share(JSON.stringify(["key", report.status, report.source, reference]), index);
    for (const key of report.correlation) share(JSON.stringify(["correlation", report.status, key.system, key.id]), index);
  });
  const link = options.link;
  if (link !== undefined) {
    const blocks = new Map<string, number[]>();
    reports.forEach((report, index) => {
      for (const block of new Set(link.blocks(report))) {
        const key = JSON.stringify([report.status, block]);
        const members = blocks.get(key);
        if (members === undefined) blocks.set(key, [index]);
        else members.push(index);
      }
    });
    for (const members of blocks.values()) {
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          if (link.matches(reports[members[i]!]!, reports[members[j]!]!)) connect(members[i]!, members[j]!);
        }
      }
    }
  }
  // The edges go in the two directions, so the strong components are the connected components.
  // The nodes of a component keep the order of the reports: the order of their ids.
  const components = stronglyConnectedComponents(reports.keys(), (index) => edges[index]!);
  const ended = endedReports(state, at);
  return components
    .map((component) => incidentOf(component.map((index) => reports[index]!), at, ended))
    .sort((a, b) => compareCodeUnits(a.anchor, b.anchor));
}

/**
 * This function gives the reports that ended at a time: each report whose latest end mark at or before
 * the time has `ended` true. A mark after the time changes nothing, so a replay of a past time gives
 * the past value.
 */
export function endedReports(state: MergeState, at: Instant): ReadonlySet<ReportId> {
  const latest = new Map<ReportId, EndMark>();
  for (const mark of state.ends) {
    if (mark.at > at) continue;
    const held = latest.get(mark.report);
    // At one time, the mark with `ended` false wins. Thus the order of the marks changes nothing.
    if (held === undefined || mark.at > held.at || (mark.at === held.at && !mark.ended)) latest.set(mark.report, mark);
  }
  return new Set([...latest.values()].filter((mark) => mark.ended).map((mark) => mark.report));
}

/**
 * This function gives the highest level that a person got for an incident. It reads each
 * delivery to the person that points to a report of the incident. The value only grows, so a
 * merge of two incidents does not send a level again.
 */
export function sentLevel(state: MergeState, incident: Incident, person: PersonId): Level | undefined {
  const reports = new Set<string>(incident.reports);
  return highest(state.deliveries.filter((d) => d.person === person && reports.has(d.incident)));
}

/**
 * This function gives the highest level that a person acknowledged for an incident. An
 * acknowledgment of a level also covers each lower level.
 */
export function acknowledgedLevel(state: MergeState, incident: Incident, person: PersonId): Level | undefined {
  const reports = new Set<string>(incident.reports);
  return highest(state.acks.filter((a) => a.person === person && reports.has(a.incident)));
}

// The orders of the CAP values, from the lowest. `unknown` is the lowest, so it does not hide a known value.
const SEVERITY: readonly Severity[] = ["unknown", "minor", "moderate", "severe", "extreme"];
const URGENCY: readonly Urgency[] = ["unknown", "past", "future", "expected", "immediate"];
const CERTAINTY: readonly Certainty[] = ["unknown", "unlikely", "possible", "likely", "observed"];

// The first item with the highest value. The reports come in the order of their ids, so a tie goes to the smallest id.
function top<T>(items: readonly T[], rank: (item: T) => number): T {
  return items.reduce((best, item) => (rank(item) > rank(best) ? item : best));
}

function incidentOf(group: readonly Report[], at: Instant, ended: ReadonlySet<ReportId>): Incident {
  const events = eventsOf(group);
  const { superseded, later, replaced } = statementsOf(group, events);
  let heads = group.filter((report) => !superseded.has(report.id) && !replaced.has(report.id));
  // A cycle of references leaves no head. Then each report counts as a head.
  if (heads.length === 0) heads = [...group];
  const liveHeads = heads.filter((report) => report.op !== "cancel" && !(report.expires !== undefined && report.expires <= at) && !ended.has(report.id));
  const basis = liveHeads.length > 0 ? liveHeads : heads;
  const stated = basis.map((report) => ({ report, ...knownValues(report, events) }));
  const lines = stated.map(
    ({ report, severity, urgency, certainty }): IncidentLine => ({
      report: report.id,
      kind: report.kind,
      severity,
      urgency,
      certainty,
      ...(report.onset === undefined ? {} : { onset: report.onset }),
      areas: liveAreas(report, later.get(report.id)),
    }),
  );
  const first = group[0]!;
  const worst = top(stated, (values) => SEVERITY.indexOf(values.severity));
  const onsets = basis.flatMap((report) => (report.onset === undefined ? [] : [report.onset]));
  const expiries = basis.flatMap((report) => (report.expires === undefined ? [] : [report.expires]));
  const incident: Incident = {
    anchor: first.id,
    reports: group.map((report) => report.id),
    status: first.status,
    kind: worst.report.kind,
    severity: worst.severity,
    urgency: top(stated, (values) => URGENCY.indexOf(values.urgency)).urgency,
    certainty: top(stated, (values) => CERTAINTY.indexOf(values.certainty)).certainty,
    areas: uniqueByText(lines.flatMap((line) => line.areas)),
    about: uniqueByText(basis.flatMap((report) => report.about)),
    live: liveHeads.length > 0,
    corroboration: new Set(group.map((report) => report.origin)).size,
    // The lines are present only when their values differ. Else each place gets the values of the incident.
    ...(new Set(lines.map(lineValues)).size > 1 ? { lines } : {}),
  };
  return {
    ...incident,
    ...(onsets.length > 0 ? { onset: onsets.reduce((a, b) => Math.min(a, b)) } : {}),
    // A head with no end makes the incident open.
    ...(expiries.length === basis.length && expiries.length > 0 ? { expires: expiries.reduce((a, b) => Math.max(a, b)) } : {}),
  };
}

// The values of a line with no areas, as one key for a set.
const lineValues = (line: IncidentLine): string => canonical([line.kind, line.severity, line.urgency, line.certainty, line.onset ?? null]);

// The text of a region code, as one key for a set.
const codeText = (area: Extract<Area, { type: "code" }>): string => JSON.stringify([area.system, area.code]);

function codesOf(report: Report): ReadonlySet<string> {
  return new Set(report.areas.flatMap((area) => (area.type === "code" ? [codeText(area)] : [])));
}

/** The later statements of the codes of the reports of a group. */
interface Statements {
  /** The reports that a reference ends as a whole. */
  readonly superseded: ReadonlySet<ReportId>;
  /** For each report, the codes of it that a later statement names. */
  readonly later: ReadonlyMap<ReportId, ReadonlySet<string>>;
  /** The reports with one or more codes, each of which has a later statement (the rule of the copies). */
  readonly replaced: ReadonlySet<ReportId>;
}

/**
 * This function gives the later statements of the codes of each report of a group. Two rules give a statement.
 *
 * - The rule of the copies. Two reports of one origin with a shared correlation key tell of one event. A report
 *   of the event with a later sent time states each code that it names. A tie of the sent time states nothing.
 * - The rule of a part. A cancel that names a proper subset of the codes of a report that it references states
 *   only those codes. The NWS ends a part of a warning so: one cancel for the part, one update for the rest.
 *
 * Each other reference ends the whole report, as CAP tells. A report is replaced when each of its codes has a
 * later statement. Thus a cancel of the NWS also ends the copy of that alert from IPAWS. The rows of IEM, one
 * for each county, end the NWS message of two counties.
 *
 * For each code, the latest reports that name it stay, so no later statement of a code is lost. A code with no
 * later statement keeps its report live, and a report with no code is not replaced. When the update of the rest
 * is lost, the rest stays live until it expires. Each error is on the safe side. The rule reads only the group,
 * so it keeps the laws of the merge.
 */
function statementsOf(group: readonly Report[], byEvent: Events): Statements {
  const codes = new Map(group.map((report) => [report.id, codesOf(report)]));
  const later = new Map<ReportId, Set<string>>();
  const state = (report: Report, named: Iterable<string>): void => {
    let set = later.get(report.id);
    if (set === undefined) later.set(report.id, (set = new Set()));
    for (const code of named) set.add(code);
  };
  for (const reports of byEvent.values()) {
    // From the latest sent time to the earliest. `seen` holds the codes of the reports after the current time.
    const ordered = [...reports].sort((a, b) => b.sent - a.sent);
    const seen = new Set<string>();
    for (let start = 0, end = 0; start < ordered.length; start = end) {
      while (end < ordered.length && ordered[end]!.sent === ordered[start]!.sent) end += 1;
      const tied = ordered.slice(start, end);
      if (seen.size > 0) for (const report of tied) state(report, seen);
      for (const report of tied) for (const code of codes.get(report.id)!) seen.add(code);
    }
  }
  const byKey = new Map<string, Report[]>();
  for (const report of group) {
    const key = JSON.stringify([report.source, report.key]);
    const reports = byKey.get(key);
    if (reports === undefined) byKey.set(key, [report]);
    else reports.push(report);
  }
  const superseded = new Set<ReportId>();
  for (const report of group) {
    const named = codes.get(report.id)!;
    for (const reference of report.references) {
      for (const target of byKey.get(JSON.stringify([report.source, reference])) ?? []) {
        const own = codes.get(target.id)!;
        const part = report.op === "cancel" && named.size > 0 && named.size < own.size && [...named].every((code) => own.has(code));
        if (part) state(target, named);
        else superseded.add(target.id);
      }
    }
  }
  const replaced = new Set<ReportId>();
  for (const report of group) {
    const own = codes.get(report.id)!;
    const stated = later.get(report.id);
    if (own.size > 0 && stated !== undefined && [...own].every((code) => stated.has(code))) replaced.add(report.id);
  }
  return { superseded, later, replaced };
}

/**
 * This function gives the areas of a report with no code that has a later statement. A block with such a code also
 * loses its shapes, because a code cannot cut a shape. The block then decides by its other codes. A block with no
 * shape covers each place in its codes, so the error is on the safe side.
 */
function liveAreas(report: Report, later: ReadonlySet<string> | undefined): Area[] {
  const areas = blockAreas(report);
  if (later === undefined) return areas;
  const stated = (area: Area): boolean => area.type === "code" && later.has(codeText(area));
  const cut = new Set(areas.flatMap((area) => (area.type !== "place" && area.block !== undefined && stated(area) ? [area.block] : [])));
  const inCut = (area: Area): boolean => area.type !== "place" && area.type !== "code" && area.block !== undefined && cut.has(area.block);
  return areas.filter((area) => !stated(area) && !inCut(area));
}

// The reports of each event of a group: one origin and one correlation key.
type Events = ReadonlyMap<string, readonly Report[]>;

const eventKey = (report: Report, key: Report["correlation"][number]): string => JSON.stringify([report.origin, key.system, key.id]);

function eventsOf(group: readonly Report[]): Events {
  const byEvent = new Map<string, Report[]>();
  for (const report of group) {
    for (const key of report.correlation) {
      const event = eventKey(report, key);
      const reports = byEvent.get(event);
      if (reports === undefined) byEvent.set(event, [report]);
      else reports.push(report);
    }
  }
  return byEvent;
}

type Stated = Pick<Report, "severity" | "urgency" | "certainty">;

/**
 * The severity, the urgency and the certainty of a report, with each `unknown` value filled from its
 * events. A copy with no value, as a row of IEM, then keeps the values of the message of the authority.
 */
function knownValues(report: Report, events: Events): Stated {
  return {
    severity: knownValue(report, "severity", SEVERITY, events),
    urgency: knownValue(report, "urgency", URGENCY, events),
    certainty: knownValue(report, "certainty", CERTAINTY, events),
  };
}

/**
 * The value of one field. An `unknown` value takes the value of the latest report of an event of the
 * report with a known value. That report is not later than the report and is not a cancel, because
 * a cancel of the NWS gives the values of an end. A tie of time takes the highest value.
 */
function knownValue<F extends keyof Stated>(report: Report, field: F, order: readonly Report[F][], events: Events): Report[F] {
  let value = report[field];
  if (value !== "unknown") return value;
  let sent = -Infinity;
  for (const key of report.correlation) {
    for (const other of events.get(eventKey(report, key)) ?? []) {
      const found = other[field];
      if (other.op === "cancel" || found === "unknown" || other.sent > report.sent) continue;
      if (other.sent > sent || (other.sent === sent && order.indexOf(found) > order.indexOf(value))) {
        value = found;
        sent = other.sent;
      }
    }
  }
  return value;
}

function highest(parts: readonly { readonly level: Level }[]): Level | undefined {
  const index = parts.reduce((best, part) => Math.max(best, LEVELS.indexOf(part.level)), -1);
  return index < 0 ? undefined : LEVELS[index];
}

// The canonical JSON of each object, kept for the life of the object.
const texts = new WeakMap<object, string>();
function canonical(value: object): string {
  let text = texts.get(value);
  if (text === undefined) {
    text = canonicalJson(value, { form: "json" });
    texts.set(value, text);
  }
  return text;
}

function uniqueByText<T extends object>(items: readonly T[]): T[] {
  const byText = new Map<string, T>();
  for (const item of items) {
    const text = canonical(item);
    if (!byText.has(text)) byText.set(text, item);
  }
  return [...byText.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, item]) => item);
}

/**
 * The areas of a report, with the report id before each block key. Thus the blocks of two reports stay
 * apart, also when the NWS and IPAWS copies of one warning give the same keys.
 */
function blockAreas(report: Report): Area[] {
  return report.areas.map((area) => (area.type === "place" || area.block === undefined ? area : { ...area, block: `${report.id}/${area.block}` }));
}
