/**
 * The reports of the system itself. Each source that is down or late becomes a line of reports with the
 * status `system`. Each gap of the coverage and each stage of the quota of a channel also becomes such a
 * line. So the merge, the assessment and the escalation carry them as they carry the reports of a source.
 *
 * The function is a fold over snapshots of the health and the coverage. A condition that starts
 * gives an alert. A change of its facts gives an update that references the last key of the line.
 * The end of the condition gives a cancel. The fold reads no clock.
 */
import { canonicalJson } from "@mark1russell7/rigor-generators";
import { BALANCE_KIND, COVERAGE_KIND, hasKind, HEALTH_KIND, matchPlaces, QUOTA_KIND } from "./assess.ts";
import type {
  Area,
  BalanceStage,
  ChannelQuota,
  Coverage,
  HealthState,
  Incident,
  Instant,
  Kind,
  Observation,
  Operation,
  PlaceId,
  ProviderBalance,
  QuotaStage,
  Report,
  ResponseType,
  Severity,
  Significance,
  SourceDescriptor,
  SourceHealth,
  SourceId,
  Subject,
  Urgency,
  WatchedPlace,
} from "./contracts.ts";
import { coverageShort } from "./coverage.ts";
import { observationId, reportId } from "./ids.ts";
import type { Lateness } from "./lateness.ts";
import { kindLabel } from "./taxonomy.ts";

/** The source of each report of the core. No adapter has this id. */
export const SYSTEM_SOURCE = "system" as SourceId;

/** The system of the subjects of the health reports. The id of a subject is the id of a source. */
export const SOURCE_SUBJECT = "alerts.source";

/** The system of the subjects of the quota reports. The id of a subject is the id of a channel. */
export const CHANNEL_SUBJECT = "alerts.channel";

/** The stages of a quota, from the first to the last. */
export const QUOTA_STAGES: readonly QuotaStage[] = ["low", "reserve", "spent"];

/** The stages of a balance. `empty` holds `low`. `unread` comes from the time of the last read. */
export const BALANCE_STAGES: readonly BalanceStage[] = ["low", "empty", "unread"];

/** The health states that start a line of health reports. */
export const DOWN_STATES: readonly HealthState[] = ["failing", "silent", "changed"];

/** The stages of an incident that make a gap of the coverage more dangerous. An incident with no stage also counts. */
export const THREAT_STAGES: readonly Significance[] = ["warning", "watch"];

/** An open line of reports. The fold keeps it until the condition ends. */
export interface SystemLine {
  /** The key of the last report of the line. The next report references it. */
  readonly key: string;
  /** The canonical JSON of the facts of the last report. Only a change of the facts gives an update. */
  readonly facts: string;
  readonly kind: Kind;
  readonly areas: readonly Area[];
  readonly about: readonly Subject[];
}

/** The state of the fold. It is data, so the runtime can keep it in its log. */
export interface SystemLines {
  /** The count of the reports of the fold. Each key has it, so each key is new. */
  readonly count: number;
  /** The open lines, by the name of the condition. */
  readonly open: Readonly<Record<string, SystemLine>>;
}

/** The state of the fold before the first snapshot. */
export const NO_SYSTEM_LINES: SystemLines = { count: 0, open: {} };

/** A place and a kind with a live watch or warning. */
export interface Threat {
  readonly place: PlaceId;
  /** The taxonomy code of the incident. */
  readonly kind: string;
}

/** One snapshot of the system. */
export interface SystemSnapshot {
  /** The descriptors of the sources. The reports take their titles. */
  readonly sources: readonly SourceDescriptor[];
  readonly health: readonly SourceHealth[];
  readonly coverage: readonly Coverage[];
  /** The places and the kinds with a live watch or warning. The function `threats` gives them. */
  readonly threats: readonly Threat[];
  /** The lateness of the sources that carry the reports of other sources. Each `late` entry is a condition. */
  readonly lateness?: readonly Lateness[];
  /**
   * The quotas of the channels. Each stage that `quotaStages` gives is a condition. With no quotas, each
   * open line of a quota stays open: a failed read of a count ends no line.
   */
  readonly quotas?: readonly ChannelQuota[];
  /**
   * The balances of the provider accounts. Each stage that `balanceStages` gives is a condition. With no
   * balances, each open line of a balance stays open.
   */
  readonly balances?: readonly ProviderBalance[];
}

/** The result of one step of the fold. */
export interface SystemStep {
  readonly lines: SystemLines;
  /** The new reports, in the order of the names of their conditions. */
  readonly reports: readonly Report[];
  /** The observation of each new report. The log keeps them, as it keeps the observations of the sources. */
  readonly observations: readonly Observation[];
}

/**
 * This function gives the places and the kinds with a live threat. A threat is an incident with the
 * status `actual`, a stage in `THREAT_STAGES` or no stage, and an area that covers a watched place.
 */
export function threats(incidents: readonly Incident[], places: readonly WatchedPlace[]): Threat[] {
  return incidents.flatMap((incident) => {
    const stage = incident.kind.significance;
    if (!incident.live || incident.status !== "actual" || (stage !== undefined && !THREAT_STAGES.includes(stage))) return [];
    return matchPlaces(incident, places).map((match) => ({ place: match.place, kind: incident.kind.code }));
  });
}

/**
 * This function gives the stages that a quota reached, in the order of `QUOTA_STAGES`. Each later stage
 * holds the earlier stages. Thus each stage is one line, and the line of the entry into the reserve is
 * one alert in a window.
 */
export function quotaStages(quota: ChannelQuota): QuotaStage[] {
  const left = quota.limit - quota.used;
  const spent = quota.blockedUntil !== undefined || left <= 0;
  const reached: Readonly<Record<QuotaStage, boolean>> = { low: spent || left <= 2 * quota.reserve, reserve: spent || left <= quota.reserve, spent };
  return QUOTA_STAGES.filter((stage) => reached[stage]);
}

/**
 * This function gives the stages of a balance at the time `at`, in the order of `BALANCE_STAGES`.
 *
 * - `low` and `empty` come from the last read that passed, also when the read is old.
 * - `unread` starts at `balanceUnreadAt`. A read that passes ends it.
 */
export function balanceStages(balance: ProviderBalance, at: Instant): BalanceStage[] {
  const read = balance.read;
  const empty = read !== undefined && read.balance <= 0;
  const reached: Readonly<Record<BalanceStage, boolean>> = {
    low: empty || (read !== undefined && read.balance < balance.floor),
    empty,
    unread: at >= balanceUnreadAt(balance),
  };
  return BALANCE_STAGES.filter((stage) => reached[stage]);
}

/** This function gives the time when a balance reaches `unread`: the maximum age after the last read, or after the start with no read. */
export function balanceUnreadAt(balance: ProviderBalance): Instant {
  return (balance.read?.at ?? balance.since) + balance.maxAge;
}

/**
 * This function gives the CAP severity and urgency of a gap of the coverage. The assessment policy
 * gives the level from them:
 *
 * - No independent source during a threat of the kind: `extreme` and `immediate`.
 * - Fewer independent sources than the policy needs: `severe` and `expected`.
 * - A count that the search did not prove: `moderate` and `expected`.
 */
export function gapGrade(entry: Coverage, threatened: boolean): { readonly severity: Severity; readonly urgency: Urgency } {
  if (entry.independent === 0 && threatened) return { severity: "extreme", urgency: "immediate" };
  if (entry.independent < entry.required) return { severity: "severe", urgency: "expected" };
  return { severity: "moderate", urgency: "expected" };
}

/**
 * This function adds one snapshot to the fold at the time `at`. Each of these is a condition:
 *
 * - Each source in `DOWN_STATES`, each late expectation and each coverage that is short.
 * - Each stage of a quota and each stage of a balance.
 *
 * An open line with no condition in the snapshot ends with a cancel. Equal snapshots give no new report.
 */
export function systemReports(lines: SystemLines, snapshot: SystemSnapshot, at: Instant): SystemStep {
  const conditions = new Map<string, Condition>();
  const titles = new Map(snapshot.sources.map((source) => [source.id, source.title]));
  for (const health of snapshot.health) {
    if (DOWN_STATES.includes(health.state)) conditions.set(healthName(health.source), healthCondition(health, titles.get(health.source) ?? health.source));
  }
  for (const entry of snapshot.lateness ?? []) {
    if (entry.state === "late") conditions.set(lateName(entry.expectation), lateCondition(entry, titles));
  }
  for (const entry of snapshot.coverage) {
    if (!coverageShort(entry)) continue;
    const threatened = snapshot.threats.some((threat) => threat.place === entry.place && hasKind([entry.kind], threat.kind));
    conditions.set(coverageName(entry.place, entry.kind), coverageCondition(entry, threatened));
  }
  for (const quota of snapshot.quotas ?? []) {
    for (const stage of quotaStages(quota)) conditions.set(quotaName(quota.channel, stage), quotaCondition(quota, stage));
  }
  for (const balance of snapshot.balances ?? []) {
    for (const stage of balanceStages(balance, at)) conditions.set(balanceName(balance.provider, stage), balanceCondition(balance, stage, at));
  }
  const names = [...new Set([...Object.keys(lines.open), ...conditions.keys()])].sort(compare);
  let count = lines.count;
  const open = new Map(Object.entries(lines.open));
  const reports: Report[] = [];
  const observations: Observation[] = [];
  for (const name of names) {
    const line = lines.open[name];
    const condition = conditions.get(name);
    if (condition === undefined && snapshot.quotas === undefined && name.startsWith(QUOTA_LINE)) continue;
    if (condition === undefined && snapshot.balances === undefined && name.startsWith(BALANCE_LINE)) continue;
    const draft = condition === undefined ? (line === undefined ? undefined : cancelOf(line)) : condition;
    if (draft === undefined) continue;
    const facts = canonicalJson(draft.facts, { form: "json" });
    if (line !== undefined && condition !== undefined && line.facts === facts) continue;
    const op: Operation = condition === undefined ? "cancel" : line === undefined ? "alert" : "update";
    count += 1;
    const key = `${name}#${count}`;
    const observation = observationOf(name, op, draft.facts, at);
    observations.push(observation);
    reports.push(reportOf(draft, { key, op, references: line === undefined ? [] : [line.key], at, observation: observation.id }));
    if (op === "cancel") open.delete(name);
    else open.set(name, { key, facts, kind: draft.kind, areas: draft.areas, about: draft.about });
  }
  const sorted = [...open.entries()].sort(([a], [b]) => compare(a, b));
  return { lines: { count, open: Object.fromEntries(sorted) }, reports, observations };
}

/**
 * This function adds the reports of the fold to the lines, in their order. It gives the lines that
 * `systemReports` gave with these reports. Thus the runtime rebuilds the lines from its log, and the
 * log holds no copy of the state. A report of another source changes nothing.
 *
 * The observation of each report gives the facts of its line. The function throws when an observation
 * is not in `observations`, because then the log is not complete.
 */
export function addSystemReports(lines: SystemLines, reports: readonly Report[], observations: readonly Observation[]): SystemLines {
  const bodies = new Map(observations.map((observation) => [observation.id, observation.body]));
  let count = lines.count;
  const open = new Map(Object.entries(lines.open));
  for (const report of reports) {
    if (report.source !== SYSTEM_SOURCE) continue;
    const mark = report.key.lastIndexOf("#");
    const name = report.key.slice(0, mark);
    const body = bodies.get(report.observation);
    if (mark < 0 || body === undefined) throw new Error(`The system report ${report.key} has no observation ${report.observation}.`);
    const { facts } = JSON.parse(body) as { readonly facts: Condition["facts"] };
    count = Math.max(count, Number(report.key.slice(mark + 1)));
    if (report.op === "cancel") open.delete(name);
    else open.set(name, { key: report.key, facts: canonicalJson(facts, { form: "json" }), kind: report.kind, areas: report.areas, about: report.about });
  }
  const sorted = [...open.entries()].sort(([a], [b]) => compare(a, b));
  return { count, open: Object.fromEntries(sorted) };
}

// The parts of a report that a condition gives. The fold adds the key, the references, the times and the observation.
interface Condition {
  readonly facts: Readonly<Record<string, unknown>>;
  readonly kind: Kind;
  readonly severity: Severity;
  readonly urgency: Urgency;
  readonly response: readonly ResponseType[];
  readonly onset?: Instant;
  readonly areas: readonly Area[];
  readonly about: readonly Subject[];
  readonly headline: string;
  readonly description?: string;
  readonly instruction?: string;
  readonly parameters: Readonly<Record<string, readonly string[]>>;
}

const HEADLINES: Readonly<Record<string, string>> = {
  failing: "the fetches fail",
  silent: "the source gives no new data",
  changed: "the format of the source changed",
};

function healthName(source: SourceId): string {
  return `health/${encodeURIComponent(source)}`;
}

function lateName(expectation: string): string {
  return `late/${encodeURIComponent(expectation)}`;
}

// The start of the name of each line of a quota.
const QUOTA_LINE = "quota/";

function quotaName(channel: string, stage: QuotaStage): string {
  return `${QUOTA_LINE}${encodeURIComponent(channel)}/${stage}`;
}

// The start of the name of each line of a balance.
const BALANCE_LINE = "balance/";

function balanceName(provider: string, stage: BalanceStage): string {
  return `${BALANCE_LINE}${encodeURIComponent(provider)}/${stage}`;
}

function coverageName(place: PlaceId, kind: string): string {
  return `coverage/${encodeURIComponent(place)}/${encodeURIComponent(kind)}`;
}

function healthCondition(health: SourceHealth, title: string): Condition {
  return {
    // The reason of the health has counts and times, so it is not a fact: a new count gives no update.
    facts: { source: health.source, state: health.state },
    kind: { code: `${HEALTH_KIND}.${health.state}`, label: `Source ${health.state}` },
    severity: "moderate",
    urgency: "expected",
    response: ["assess"],
    onset: health.since,
    areas: [],
    about: [{ system: SOURCE_SUBJECT, id: health.source, label: title }],
    headline: `${title}: ${HEADLINES[health.state] ?? health.state}.`,
    ...(health.reason === "" ? {} : { description: health.reason }),
    parameters: { state: [health.state] },
  };
}

function lateCondition(entry: Lateness, titles: ReadonlyMap<SourceId, string>): Condition {
  const to = titles.get(entry.to) ?? entry.to;
  const from = titles.get(entry.from) ?? entry.from;
  const delay = entry.limit?.delay ?? 0;
  const misses = entry.limit?.misses ?? 1;
  return {
    // Each new miss is a new fact, so it gives an update.
    facts: { expectation: entry.expectation, from: entry.from, to: entry.to, missed: entry.missed },
    kind: { code: `${HEALTH_KIND}.late`, label: "Source late" },
    severity: "moderate",
    urgency: "expected",
    response: ["assess"],
    ...(entry.since === undefined ? {} : { onset: entry.since }),
    areas: [],
    about: [{ system: SOURCE_SUBJECT, id: entry.to, label: to }],
    headline: `${to} is late: it did not carry the reports of ${from} in time.`,
    description: `Reports with no copy: ${entry.missed.length}. The limit of the delay is ${Math.round(delay / 1000)} seconds, and the limit of the misses is ${misses}, from the measured delays and misses.`,
    parameters: { expectation: [entry.expectation], missed: entry.missed, delay: [String(delay)], misses: [String(misses)] },
  };
}

function coverageCondition(entry: Coverage, threatened: boolean): Condition {
  const grade = gapGrade(entry, threatened);
  const lines = [
    entry.independent === 0
      ? `No source that is up covers ${entry.kind} at this place.`
      : `A fault of ${entry.faults.join(", ")} stops each source that covers ${entry.kind} at this place.`,
    ...(entry.proven ? [] : ["The search did not prove the count, so the true count can be smaller."]),
    ...(entry.commonResources.length === 0 ? [] : [`Each of these sources uses the ${entry.commonResources.join(", ")} of this place.`]),
  ];
  return {
    facts: { place: entry.place, kind: entry.kind, ...grade, independent: entry.independent, required: entry.required, proven: entry.proven, faults: entry.faults },
    kind: { code: `${COVERAGE_KIND}.${entry.kind}`, label: `Coverage of ${entry.kind}` },
    ...grade,
    response: entry.independent === 0 ? ["monitor"] : ["assess"],
    areas: [{ type: "place", place: entry.place }],
    about: [],
    headline: `Coverage of ${entry.kind}: ${entry.independent} of ${entry.required} independent sources.`,
    description: lines.join(" "),
    ...(entry.independent === 0 ? { instruction: "Use another source of warnings, for example a weather radio." } : {}),
    parameters: {
      independent: [String(entry.independent)],
      required: [String(entry.required)],
      proven: [String(entry.proven)],
      faults: entry.faults,
      sources: entry.sources,
    },
  };
}

function quotaCondition(quota: ChannelQuota, stage: QuotaStage): Condition {
  const { channel, limit, reserve, used } = quota;
  const unit = quota.unit ?? "units";
  const until = stage === "spent" ? (quota.blockedUntil ?? quota.resetAt) : quota.resetAt;
  const end = until === undefined ? "" : ` until ${new Date(until).toISOString()}`;
  const text: Readonly<Record<QuotaStage, { readonly headline: string; readonly description: string }>> = {
    low: {
      headline: `${channel}: ${Math.max(0, limit - used)} of ${limit} ${unit} of the window are left.`,
      description: `At ${reserve} ${unit} left, the channel sends only life-safety messages${end}. The other messages then wait for the reset.`,
    },
    reserve: {
      headline: `${channel} sends only life-safety messages${end}.`,
      description: `The channel keeps its last ${reserve} of ${limit} ${unit} for life-safety. The other messages wait for the reset.`,
    },
    spent: {
      headline: `${channel} sends no message${end}.`,
      description: "The provider refuses each message, also a life-safety message. Only the other channels carry the alerts.",
    },
  };
  const code = `${QUOTA_KIND}.${stage}`;
  return {
    // A new count is not a fact. Thus each stage gives one alert in a window, and no update.
    facts: { channel, stage, ...(until === undefined ? {} : { until }) },
    kind: { code, label: kindLabel(code) },
    severity: stage === "low" ? "moderate" : "severe",
    urgency: stage === "spent" ? "immediate" : "expected",
    response: ["assess"],
    areas: [],
    about: [{ system: CHANNEL_SUBJECT, id: channel, label: channel }],
    ...text[stage],
    parameters: { stage: [stage], used: [String(used)], limit: [String(limit)], reserve: [String(reserve)] },
  };
}

function balanceCondition(balance: ProviderBalance, stage: BalanceStage, at: Instant): Condition {
  const { provider, title, floor, read } = balance;
  const amount = read === undefined ? "" : `${read.balance.toFixed(2)} ${read.currency}`;
  const last = read === undefined ? `the start of the watch at ${new Date(balance.since).toISOString()}` : new Date(read.at).toISOString();
  const text: Readonly<Record<BalanceStage, { readonly headline: string; readonly description: string }>> = {
    low: {
      headline: `${title}: the balance is ${amount}, below the floor of ${floor.toFixed(2)}.`,
      description: "Add money to the account. At 0, the provider refuses each paid message, also a life-safety message.",
    },
    empty: {
      headline: `${title} refuses each paid message: the balance is ${amount}.`,
      description: "Add money to the account. Until then, only the other channels carry the alerts.",
    },
    unread: {
      headline: `The balance of ${title} has no read since ${last}.`,
      description: "The watch cannot see a low balance. Examine the key of the account and the network.",
    },
  };
  const code = `${BALANCE_KIND}.${stage}`;
  return {
    // A new balance is not a fact. Thus each stage gives one alert, and no update.
    facts: { provider, stage },
    kind: { code, label: kindLabel(code) },
    severity: stage === "empty" ? "severe" : "moderate",
    urgency: stage === "empty" ? "immediate" : "expected",
    response: ["assess"],
    areas: [],
    about: balance.channels.map((channel) => ({ system: CHANNEL_SUBJECT, id: channel, label: channel })),
    ...text[stage],
    parameters: {
      stage: [stage],
      floor: [String(floor)],
      ...(read === undefined ? {} : { balance: [String(read.balance)], currency: [read.currency] }),
      age: [String(at - (read?.at ?? balance.since))],
    },
  };
}

// The cancel of a line: an all clear of the same kind, areas and subjects.
function cancelOf(line: SystemLine): Condition {
  return {
    facts: { cancel: line.key },
    kind: line.kind,
    severity: "minor",
    urgency: "past",
    response: ["allclear"],
    areas: line.areas,
    about: line.about,
    headline: `${line.kind.label}: the condition ended.`,
    parameters: {},
  };
}

function observationOf(name: string, op: Operation, facts: Condition["facts"], at: Instant): Observation {
  const contentType = "application/json";
  const body = canonicalJson({ name, op, facts }, { form: "json" });
  return { id: observationId({ source: SYSTEM_SOURCE, contentType, body }), source: SYSTEM_SOURCE, fetched: at, contentType, body, transport: { latency: 0 } };
}

interface Envelope {
  readonly key: string;
  readonly op: Operation;
  readonly references: readonly string[];
  readonly at: Instant;
  readonly observation: Observation["id"];
}

function reportOf(draft: Condition, envelope: Envelope): Report {
  const { key, op, references, at, observation } = envelope;
  return {
    id: reportId({ source: SYSTEM_SOURCE, key, sent: at }),
    source: SYSTEM_SOURCE,
    origin: SYSTEM_SOURCE,
    key,
    references,
    correlation: [],
    status: "system",
    op,
    kind: draft.kind,
    categories: ["system"],
    severity: draft.severity,
    urgency: draft.urgency,
    certainty: "observed",
    response: draft.response,
    sent: at,
    received: at,
    ...(draft.onset === undefined ? {} : { onset: draft.onset }),
    areas: draft.areas,
    about: draft.about,
    sender: "alerts",
    headline: draft.headline,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    ...(draft.instruction === undefined ? {} : { instruction: draft.instruction }),
    observation,
    parameters: draft.parameters,
  };
}

// The order of the code units, the same in each copy and each locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
