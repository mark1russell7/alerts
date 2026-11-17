/**
 * The reports of the system itself. Each source that is down or late becomes a line of reports with the
 * status `system`. Each gap of the coverage and each stage of the quota of a channel also becomes such a line.
 * Each recent step of the wall clock is also a line. So the merge, the assessment and the escalation carry them as they carry the reports of a source.
 *
 * The function is a fold over snapshots of the health and the coverage. A condition that starts
 * gives an alert. A change of its facts gives an update that references the last key of the line.
 * The end of the condition gives a cancel. The fold reads no clock.
 */
import { canonicalJson } from "@mark1russell7/rigor-generators";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { BALANCE_KIND, CLOCK_KIND, COPY_KIND, COVERAGE_KIND, DRILL_KIND, hasKind, HEALTH_KIND, LOG_KIND, matchPlaces, QUOTA_KIND } from "./assess.ts";
import type {
  Area,
  BalanceStage,
  ChannelQuota,
  CopyStage,
  CopyWatch,
  Coverage,
  Duration,
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
import { drillVerdict, type DrillConfig, type DrillRun } from "./drill.ts";
import { observationId, reportId } from "./ids.ts";
import type { Lateness } from "./lateness.ts";
import { kindLabel } from "./taxonomy.ts";

/** The source of each report of the core. No adapter has this id. */
export const SYSTEM_SOURCE = "system" as SourceId;

/** The system of the subjects of the health reports. The id of a subject is the id of a source. */
export const SOURCE_SUBJECT = "alerts.source";

/** The system of the subjects of the quota reports. The id of a subject is the id of a channel. */
export const CHANNEL_SUBJECT = "alerts.channel";

/** The system of the subject of the clock reports. The id of the subject is `wall`: the wall clock of the computer. */
export const CLOCK_SUBJECT = "alerts.clock";

/** The system of the subject of the log reports. The id of the subject is `runtime`: the log file of the runtime. */
export const LOG_SUBJECT = "alerts.log";

/** The subject system of another copy of the system. The id of a subject is the id of the copy. */
export const COPY_SUBJECT = "alerts.copy";

/** The system of the subjects of the drill reports. The id of a subject is the id of a drill. */
export const DRILL_SUBJECT = "alerts.drill";

/** The stages of a quota, from the first to the last. */
export const QUOTA_STAGES: readonly QuotaStage[] = ["low", "reserve", "spent"];

/** The stages of a balance. `empty` holds `low`. `unread` comes from the time of the last read. */
export const BALANCE_STAGES: readonly BalanceStage[] = ["low", "empty", "unread"];

/** The stages of another copy. `skew` and `config` come from the last read that passed. `unread` comes from its time. */
export const COPY_STAGES: readonly CopyStage[] = ["skew", "config", "unread"];

/** The health states that start a line of health reports. */
export const DOWN_STATES: readonly HealthState[] = ["failing", "silent", "changed"];

/** The stages of an incident that make a gap of the coverage more dangerous. An incident with no stage also counts. */
export const THREAT_STAGES: readonly Significance[] = ["warning", "watch"];

/** One step of the wall clock. */
export interface ClockStep {
  /** The time of the step on the wall clock after the step. A later step moves it. */
  readonly at: Instant;
  /** The size of the step in milliseconds: negative for a step back. */
  readonly size: Duration;
}

/**
 * One recovery of the log of the runtime from a broken file. The runtime moved the file into quarantine, and it wrote
 * each event that the salvage read into a new file.
 */
export interface LogRecovery {
  /** The time of the recovery. A later step of the wall clock moves it. */
  readonly at: Instant;
  /** The name of the quarantine folder, in the folder of the log. */
  readonly quarantine: string;
  /** The count of the events that the new file got. */
  readonly kept: number;
  /** The count of the positions of the broken file that the salvage could not read. */
  readonly lost: number;
  /** This value tells if the salvage read each part of the broken file with no problem. Then no event is lost. */
  readonly whole: boolean;
}

/** The time after a recovery of the log during which its system report stays open. Thus the digest of the day shows it. */
export const LOG_RECOVERY_WINDOW: Duration = 24 * 60 * 60 * 1000;

/** The time after a step during which its system report stays open. Thus the digest of the day shows the step. */
export const CLOCK_STEP_WINDOW: Duration = 24 * 60 * 60 * 1000;

/**
 * This function gives the size of a step in a text: whole hours, whole minutes, or else whole seconds. A step of
 * 3600000 ms is `1 h`, a step of 600000 ms is `10 min`, and a step of 90000 ms is `90 s`.
 */
export function stepSizeText(size: Duration): string {
  const ms = Math.abs(size);
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${String(ms / 3_600_000)} h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${String(ms / 60_000)} min`;
  return `${String(Math.round(ms / 1000))} s`;
}

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

/** One drill of one copy in a snapshot. */
export interface DrillSnapshot {
  /** The id of the copy that starts the drill. */
  readonly copy: string;
  readonly drill: DrillConfig;
  /** The last run of the drill in the copy. A drill that is due has a run that starts at the time of the snapshot. */
  readonly run?: DrillRun;
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
  /**
   * The watches of the other copies of the system. Each stage that `copyStages` gives is a condition. With no copies,
   * each open line of a copy stays open.
   */
  readonly copies?: readonly CopyWatch[];
  /** The steps of the wall clock. The latest step in `CLOCK_STEP_WINDOW` before the time of the snapshot is a condition. */
  readonly steps?: readonly ClockStep[];
  /** The recoveries of the log. The latest recovery in `LOG_RECOVERY_WINDOW` before the time of the snapshot is a condition. */
  readonly recoveries?: readonly LogRecovery[];
  /**
   * The drills of the copy. A run that waits for its acknowledgment is a condition, and a failed last run is a condition.
   * With no drills, each open line of a drill stays open.
   */
  readonly drills?: readonly DrillSnapshot[];
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
 * This function gives the stages of another copy at the time `at`, in the order of `COPY_STAGES`.
 *
 * - `skew` and `config` come from the last read that passed, also when the read is old.
 * - `unread` starts at `copyUnreadAt`. A read that passes ends it.
 */
export function copyStages(watch: CopyWatch, at: Instant): CopyStage[] {
  const read = watch.read;
  const reached: Readonly<Record<CopyStage, boolean>> = {
    skew: read !== undefined && Math.abs(read.skew) > watch.skewLimit,
    config: read !== undefined && !read.sameConfig,
    unread: at >= copyUnreadAt(watch),
  };
  return COPY_STAGES.filter((stage) => reached[stage]);
}

/** This function gives the time when a copy reaches `unread`: the maximum age after the last read, or after the start with no read. */
export function copyUnreadAt(watch: CopyWatch): Instant {
  return (watch.read?.at ?? watch.since) + watch.maxAge;
}

/**
 * This function gives the latest item at `at` or before it, in `window` before `at`, or `undefined`. Of two items at
 * the same time, it gives the last in the list.
 */
export function latestIn<T extends { readonly at: Instant }>(items: readonly T[], at: Instant, window: Duration): T | undefined {
  let found: T | undefined;
  for (const item of items) if (item.at <= at && at - item.at < window && (found === undefined || item.at >= found.at)) found = item;
  return found;
}

/** This function gives the latest step at `at` or before it, in `CLOCK_STEP_WINDOW` before `at`, or `undefined`. */
export function recentStep(steps: readonly ClockStep[], at: Instant): ClockStep | undefined {
  return latestIn(steps, at, CLOCK_STEP_WINDOW);
}

/** This function gives the latest recovery of the log at `at` or before it, in `LOG_RECOVERY_WINDOW` before `at`, or `undefined`. */
export function recentRecovery(recoveries: readonly LogRecovery[], at: Instant): LogRecovery | undefined {
  return latestIn(recoveries, at, LOG_RECOVERY_WINDOW);
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
 * - Each stage of a quota, each stage of a balance and each stage of another copy.
 * - The latest step of the wall clock in `CLOCK_STEP_WINDOW` before `at`.
 * - The latest recovery of the log in `LOG_RECOVERY_WINDOW` before `at`.
 * - Each run of a drill that waits for its acknowledgment, and each drill whose last run failed.
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
  for (const watch of snapshot.copies ?? []) {
    for (const stage of copyStages(watch, at)) conditions.set(copyName(watch.copy, stage), copyCondition(watch, stage, at));
  }
  const step = recentStep(snapshot.steps ?? [], at);
  if (step !== undefined) conditions.set(CLOCK_LINE, clockCondition(step));
  const recovery = recentRecovery(snapshot.recoveries ?? [], at);
  if (recovery !== undefined) conditions.set(LOG_LINE, logCondition(recovery));
  for (const entry of snapshot.drills ?? []) {
    const { copy, drill, run } = entry;
    if (run === undefined || run.drill !== drill.id) continue;
    const verdict = drillVerdict(drill, run, at);
    if (verdict.state === "pending") conditions.set(drillName(copy, drill.id), drillRunCondition(copy, drill, run));
    else if (verdict.state === "failed") conditions.set(`${drillName(copy, drill.id)}/failed`, drillFailedCondition(copy, drill, run, verdict.why));
  }
  const names = [...new Set([...Object.keys(lines.open), ...conditions.keys()])].sort(compareCodeUnits);
  let count = lines.count;
  const open = new Map(Object.entries(lines.open));
  const reports: Report[] = [];
  const observations: Observation[] = [];
  for (const name of names) {
    const line = lines.open[name];
    const condition = conditions.get(name);
    if (condition === undefined && snapshot.quotas === undefined && name.startsWith(QUOTA_LINE)) continue;
    if (condition === undefined && snapshot.balances === undefined && name.startsWith(BALANCE_LINE)) continue;
    if (condition === undefined && snapshot.copies === undefined && name.startsWith(COPY_LINE)) continue;
    if (condition === undefined && snapshot.drills === undefined && name.startsWith(DRILL_LINE)) continue;
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
  const sorted = [...open.entries()].sort(([a], [b]) => compareCodeUnits(a, b));
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
  const sorted = [...open.entries()].sort(([a], [b]) => compareCodeUnits(a, b));
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

// The start of the name of each line of another copy.
const COPY_LINE = "copy/";

function copyName(copy: string, stage: CopyStage): string {
  return `${COPY_LINE}${encodeURIComponent(copy)}/${stage}`;
}

// The start of the name of each line of a drill. The id of the copy is in the name, because each copy starts its own runs.
const DRILL_LINE = "drill/";

function drillName(copy: string, drill: string): string {
  return `${DRILL_LINE}${encodeURIComponent(copy)}/${encodeURIComponent(drill)}`;
}

// The name of the line of the steps of the wall clock. A step in the window of an open line gives an update.
const CLOCK_LINE = "clock";

// The name of the line of the recoveries of the log. A second recovery in the window of an open line gives an update.
const LOG_LINE = "log";

function coverageName(place: PlaceId, kind: string): string {
  return `coverage/${encodeURIComponent(place)}/${encodeURIComponent(kind)}`;
}

function drillRunCondition(copy: string, drill: DrillConfig, run: DrillRun): Condition {
  const code = `${DRILL_KIND}.run`;
  return {
    // The start is the only fact. Thus a run gives one alert, and the end of the wait gives its cancel.
    facts: { copy, drill: drill.id, at: run.at },
    kind: { code, label: kindLabel(code) },
    severity: "extreme",
    urgency: "immediate",
    response: ["none"],
    onset: run.at,
    areas: [],
    about: [{ system: DRILL_SUBJECT, id: drill.id, label: `Drill ${drill.id}` }],
    headline: `Drill ${drill.id}: acknowledge this message. This is not a warning.`,
    description: `This message tests the path of the life-safety warnings from the copy ${copy}. An acknowledgment in ${String(Math.round(drill.ackWithin / 60_000))} minutes passes the drill.`,
    instruction: "Acknowledge the message.",
    parameters: { drill: [drill.id], copy: [copy] },
  };
}

function drillFailedCondition(copy: string, drill: DrillConfig, run: DrillRun, why: "no-ack" | "late-ack"): Condition {
  const code = `${DRILL_KIND}.failed`;
  const late = why === "late-ack";
  return {
    // Each run and each reason is a new fact. Thus a late acknowledgment after a failure gives an update.
    facts: { copy, drill: drill.id, at: run.at, why },
    kind: { code, label: kindLabel(code) },
    severity: "moderate",
    urgency: "expected",
    response: ["assess"],
    onset: run.at + drill.ackWithin,
    areas: [],
    about: [{ system: DRILL_SUBJECT, id: drill.id, label: `Drill ${drill.id}` }],
    headline: `The drill ${drill.id} failed: ${late ? "the acknowledgment came late" : "no acknowledgment came"}.`,
    description: `The drill started at ${new Date(run.at).toISOString()} on the channel ${drill.path.channel}, from the copy ${copy}. A real warning on this path can also go without an answer.`,
    instruction: "Examine the channel, the app and the settings of the phone. The next run of the drill tests the path again.",
    parameters: { drill: [drill.id], copy: [copy], why: [why] },
  };
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

function copyCondition(watch: CopyWatch, stage: CopyStage, at: Instant): Condition {
  const { copy, read } = watch;
  const last = read === undefined ? `the start of the watch at ${new Date(watch.since).toISOString()}` : new Date(read.at).toISOString();
  const skew = read === undefined ? "" : `${(Math.abs(read.skew) / 1000).toFixed(1)} s`;
  const text: Readonly<Record<CopyStage, { readonly headline: string; readonly description: string; readonly instruction: string }>> = {
    skew: {
      headline: `The clock of the copy ${copy} differs from the clock of this copy by ${skew}.`,
      description: `The rank wait holds a difference of ${(watch.skewLimit / 1000).toFixed(1)} s or less. A larger difference can let two copies send the same alert.`,
      instruction: "Examine the time settings and the time server of each computer.",
    },
    config: {
      headline: `The copy ${copy} has a different configuration.`,
      description: "The copies can route one alert in two ways. Then a person can get an alert from each copy, or on a different channel.",
      instruction: "Give each copy the same file config.json. Then restart each copy.",
    },
    unread: {
      headline: `No read of the copy ${copy} passed since ${last}.`,
      description: "This copy cannot see the sends of the other copy. Thus the two copies can both send each alert.",
      instruction: "Examine the other computer and the network between the copies.",
    },
  };
  const code = `${COPY_KIND}.${stage}`;
  return {
    // A new difference or a new age is not a fact. Thus each stage gives one alert, and no update.
    facts: { copy, stage },
    kind: { code, label: kindLabel(code) },
    severity: "moderate",
    urgency: "expected",
    response: ["assess"],
    areas: [],
    about: [{ system: COPY_SUBJECT, id: copy, label: `Copy ${copy}` }],
    ...text[stage],
    parameters: {
      stage: [stage],
      ...(read === undefined ? {} : { skew: [String(read.skew)], sameConfig: [String(read.sameConfig)] }),
      age: [String(at - (read?.at ?? watch.since))],
    },
  };
}

function clockCondition(step: ClockStep): Condition {
  const code = `${CLOCK_KIND}.step`;
  return {
    // Each step is a new fact, thus a second step in the window gives an update.
    facts: { at: step.at, size: step.size },
    kind: { code, label: kindLabel(code) },
    severity: "minor",
    urgency: "past",
    response: ["assess"],
    onset: step.at,
    areas: [],
    about: [{ system: CLOCK_SUBJECT, id: "wall", label: "Wall clock" }],
    headline: `The wall clock stepped ${step.size < 0 ? "back" : "forward"} by ${stepSizeText(step.size)}.`,
    description: "The alert system moved its own times by the step, thus each timer keeps its time. The times of the sources and the channels did not move.",
    instruction: "Examine the time settings and the time server of the computer.",
    parameters: { size: [String(step.size)] },
  };
}

// A loss of events can repeat a send or lose an acknowledgment, thus it gets `notice`. A recovery with no loss gets `digest`.
function logCondition(recovery: LogRecovery): Condition {
  const code = `${LOG_KIND}.recovered`;
  const lossy = !recovery.whole || recovery.lost > 0;
  const positions = recovery.lost > 0 ? ` (${String(recovery.lost)} positions)` : "";
  const kept = lossy
    ? `It kept ${String(recovery.kept)} events, and it could not read each part of the file${positions}. A lost event can repeat a send or lose an acknowledgment.`
    : `It kept each of the ${String(recovery.kept)} events.`;
  return {
    facts: { at: recovery.at, quarantine: recovery.quarantine, kept: recovery.kept, lost: recovery.lost, whole: recovery.whole },
    kind: { code, label: kindLabel(code) },
    severity: lossy ? "moderate" : "minor",
    urgency: lossy ? "expected" : "past",
    response: ["assess"],
    onset: recovery.at,
    areas: [],
    about: [{ system: LOG_SUBJECT, id: "runtime", label: "Log of the runtime" }],
    headline: "The log file of the alert system was broken.",
    description: `The alert system moved the broken file into the quarantine folder ${recovery.quarantine}, and it started a new log. ${kept}`,
    instruction: "Examine the disk of the computer. Keep the quarantine folder until you know the cause.",
    parameters: { quarantine: [recovery.quarantine], kept: [String(recovery.kept)], lost: [String(recovery.lost)], whole: [String(recovery.whole)] },
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
