/**
 * The merge of the alert system: the join of two merge states, and the incidents of a state.
 *
 * The join is the union of three grow-only sets, so it is idempotent, commutative and
 * associative. The incidents are a function of the state and a time. So each copy of the system
 * that gets the same reports gets the same incidents, in any order of arrival.
 */
import { stronglyConnectedComponents } from "@mark1russell7/collections/graph";
import { canonicalJson } from "@mark1russell7/rigor-generators";
import type {
  Acknowledgment,
  Certainty,
  Delivery,
  Incident,
  Instant,
  Level,
  MergeState,
  PersonId,
  Report,
  ReportId,
  Severity,
  Urgency,
} from "./contracts.ts";
import { LEVELS } from "./contracts.ts";

/** The merge state with no part. */
export const EMPTY_STATE: MergeState = { reports: [], deliveries: [], acks: [] };

/** The parts of a merge state, in any order and with duplicates. */
export interface MergeParts {
  readonly reports?: readonly Report[];
  readonly deliveries?: readonly Delivery[];
  readonly acks?: readonly Acknowledgment[];
}

/**
 * This function gives the one form of a merge state. It keeps one report for each id: for two
 * contents of one id, the content with the smaller canonical JSON. It keeps each delivery and each
 * acknowledgment one time.
 */
export function normalize(parts: MergeParts): MergeState {
  const reports = new Map<ReportId, { readonly report: Report; readonly text: string }>();
  for (const report of parts.reports ?? []) {
    const text = canonical(report);
    const held = reports.get(report.id);
    if (held === undefined || text < held.text) reports.set(report.id, { report, text });
  }
  return {
    reports: [...reports.entries()].sort(([a], [b]) => compare(a, b)).map(([, held]) => held.report),
    deliveries: uniqueByText(parts.deliveries ?? []),
    acks: uniqueByText(parts.acks ?? []),
  };
}

/** This function gives the join of two merge states: the union of their parts. */
export function join(a: MergeState, b: MergeState): MergeState {
  return normalize({
    reports: [...a.reports, ...b.reports],
    deliveries: [...a.deliveries, ...b.deliveries],
    acks: [...a.acks, ...b.acks],
  });
}

/** This function adds parts to a merge state. A part that the state has already changes nothing. */
export function add(state: MergeState, parts: MergeParts): MergeState {
  return normalize({
    reports: [...state.reports, ...(parts.reports ?? [])],
    deliveries: [...state.deliveries, ...(parts.deliveries ?? [])],
    acks: [...state.acks, ...(parts.acks ?? [])],
  });
}

/**
 * The link rule of merge rule 3. The rule of each family of kind is an open point
 * (`docs/CONTRACTS.md`). The merge tests only the pairs of reports that share a block. So the
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
 * A head of an incident is a report that no report of its source references, and that no later
 * report of its origin replaces (the rule of the copies, `docs/CONTRACTS.md`).
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
  return components
    .map((component) => incidentOf(component.map((index) => reports[index]!), at))
    .sort((a, b) => compare(a.anchor, b.anchor));
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

function incidentOf(group: readonly Report[], at: Instant): Incident {
  const superseded = new Set<string>();
  for (const report of group) {
    for (const reference of report.references) superseded.add(JSON.stringify([report.source, reference]));
  }
  const events = eventsOf(group);
  const replaced = replacedCopies(events);
  let heads = group.filter((report) => !superseded.has(JSON.stringify([report.source, report.key])) && !replaced.has(report.id));
  // A cycle of references leaves no head. Then each report counts as a head.
  if (heads.length === 0) heads = [...group];
  const liveHeads = heads.filter((report) => report.op !== "cancel" && !(report.expires !== undefined && report.expires <= at));
  const basis = liveHeads.length > 0 ? liveHeads : heads;
  const stated = basis.map((report) => ({ report, ...knownValues(report, events) }));
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
    areas: uniqueByText(basis.flatMap((report) => report.areas)),
    about: uniqueByText(basis.flatMap((report) => report.about)),
    live: liveHeads.length > 0,
    corroboration: new Set(group.map((report) => report.origin)).size,
  };
  return {
    ...incident,
    ...(onsets.length > 0 ? { onset: onsets.reduce((a, b) => Math.min(a, b)) } : {}),
    // A head with no end makes the incident open.
    ...(expiries.length === basis.length && expiries.length > 0 ? { expires: expiries.reduce((a, b) => Math.max(a, b)) } : {}),
  };
}

/**
 * The rule of the copies. Two reports of one origin with a shared correlation key tell of one event.
 * The later reports of the event replace an earlier report, from any source, when together they name
 * each region code of the earlier report. Thus a cancel of the NWS also ends the copy of that alert
 * from IPAWS. The rows of IEM, one for each county, end the NWS message of two counties.
 *
 * For each code, the latest reports that name it stay, so no later statement of a code is lost. A
 * code that no later report names keeps its report live, and a report with no code is not replaced.
 * Then the error is on the safe side. The rule reads only the group, so it keeps the laws of the merge.
 */
function replacedCopies(byEvent: Events): Set<ReportId> {
  const codes = new Map<ReportId, ReadonlySet<string>>();
  const codesOf = (report: Report): ReadonlySet<string> => {
    let set = codes.get(report.id);
    if (set === undefined) {
      set = new Set(report.areas.flatMap((area) => (area.type === "code" ? [JSON.stringify([area.system, area.code])] : [])));
      codes.set(report.id, set);
    }
    return set;
  };
  const replaced = new Set<ReportId>();
  for (const reports of byEvent.values()) {
    // From the latest sent time to the earliest. `later` holds the codes of the reports after the current time.
    const ordered = [...reports].sort((a, b) => b.sent - a.sent);
    const later = new Set<string>();
    for (let start = 0, end = 0; start < ordered.length; start = end) {
      while (end < ordered.length && ordered[end]!.sent === ordered[start]!.sent) end += 1;
      const tied = ordered.slice(start, end);
      for (const report of tied) {
        const named = codesOf(report);
        if (named.size > 0 && [...named].every((code) => later.has(code))) replaced.add(report.id);
      }
      for (const report of tied) for (const code of codesOf(report)) later.add(code);
    }
  }
  return replaced;
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
  return [...byText.entries()].sort(([a], [b]) => compare(a, b)).map(([, item]) => item);
}

// The order of the code units, the same in each copy and each locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
