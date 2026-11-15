/**
 * The lateness of a source that carries the messages of another source. FEMA IPAWS carries each NWS
 * warning for Wireless Emergency Alerts. Its feed can be quiet for hours in normal work, so the quiet
 * timer of the health cannot show that it stopped. An expectation tells which reports of one source
 * the other source carries. When the copy of such a report does not come in time, the second source
 * is late.
 *
 * The functions are pure folds over the merge state and the time. They read no clock. The limit of
 * the delay comes from the measured delays as the upper bound of a quantile (`delayLimit`). The count
 * of misses that makes a source late comes from the measured rate of the misses (`missLimit`). No
 * person sets a time or a count.
 */
import { clopperPearson, quantileInterval } from "@mark1russell7/rigor-statistics";
import { hasKind } from "./assess.ts";
import type { Duration, Incident, Instant, MergeState, Operation, Report, ReportId, SourceId, Status } from "./contracts.ts";

/** The reports of a source that start an expectation. Each field that is present must hold. */
export interface ReportFilter {
  readonly statuses?: readonly Status[];
  readonly ops?: readonly Operation[];
  /** The prefixes of the taxonomy codes. */
  readonly kinds?: readonly string[];
  /** The names of the parameters that the report must have, each with one value or more. */
  readonly parameters?: readonly string[];
}

/**
 * A source that carries a copy of some reports of another source. The two copies must be in one
 * incident, so the second source must give a correlation key of the first, for example the VTEC key.
 */
export interface Expectation {
  readonly id: string;
  /** The source of the first copy. */
  readonly from: SourceId;
  /** The source that carries the second copy. */
  readonly to: SourceId;
  readonly when: ReportFilter;
}

/** One check of an expectation in one incident. */
export interface Carriage {
  readonly expectation: string;
  /** The first report of the source `from` in the incident that passes the filter. Its id is the key of the check. */
  readonly report: ReportId;
  /** The time when that report came. */
  readonly started: Instant;
  /** The time when the first report of the source `to` in the incident came. It is absent when no copy came. */
  readonly arrived?: Instant;
}

/** The quantile and the level of the limits of an expectation. The policy of the runtime gives them. */
export interface DelayLimitOptions {
  /** The quantile of the delays, for example `0.99`. In normal work, a smaller part than `1 - quantile` of the copies comes after the limit. */
  readonly quantile: number;
  /**
   * The level of confidence of the upper bounds, for example `0.95`. In normal work, a run of misses
   * that makes the source late comes with a chance of `1 - level` or less.
   */
  readonly level: number;
}

/** The limits of one expectation. */
export interface LatenessLimit {
  /** The limit of the delay of a copy, in milliseconds. A check passes its limit at `started + delay`. */
  readonly delay: Duration;
  /** The count of misses after the last check that came that makes the source late. It is 1 or more. */
  readonly misses: number;
}

/**
 * The misses of the past of one expectation. A trial is a check that passed its limit, after a check
 * that met its limit. The first check is also a trial. A miss is a trial with no copy by its limit.
 */
export interface MissRecord {
  readonly trials: number;
  readonly misses: number;
}

/**
 * The state of an expectation at one time.
 *
 * - `no-limit`: the expectation has no limits yet. The check only measures.
 * - `no-data`: no check came, and the misses are fewer than the limit.
 * - `met`: a check came, and the misses after the last check that came are fewer than the limit.
 * - `late`: the count of misses after the last check that came is at the limit or more.
 */
export type LatenessState = "no-limit" | "no-data" | "met" | "late";

/** The lateness of the source `to` against the source `from` for one expectation. */
export interface Lateness {
  readonly expectation: string;
  readonly from: SourceId;
  readonly to: SourceId;
  readonly state: LatenessState;
  readonly limit?: LatenessLimit;
  /** The checks that passed their limit with no copy, after the last check that came, from the earliest. */
  readonly missed: readonly ReportId[];
  /** The time when the miss that made the source late passed its limit. */
  readonly since?: Instant;
  /** The next time when a check passes its limit. The runtime starts `lateness` again at that time. */
  readonly wakeAt?: Instant;
}

/** This function tells if a report passes a filter. */
export function reportPasses(filter: ReportFilter, report: Report): boolean {
  return (
    (filter.statuses === undefined || filter.statuses.includes(report.status)) &&
    (filter.ops === undefined || filter.ops.includes(report.op)) &&
    (filter.kinds === undefined || hasKind(filter.kinds, report.kind.code)) &&
    (filter.parameters ?? []).every((name) => (report.parameters[name]?.length ?? 0) > 0)
  );
}

/**
 * This function gives one check for each expectation and each incident with a report of `from` that
 * passes the filter. The result is a function of the set of reports, so the order of the reports does
 * not change it. A copy that came first gives a check with `arrived` before `started`.
 */
export function carriages(state: MergeState, found: readonly Incident[], expectations: readonly Expectation[]): Carriage[] {
  const byId = new Map(state.reports.map((report) => [report.id, report]));
  const checks: Carriage[] = [];
  for (const incident of found) {
    const reports = incident.reports.flatMap((id) => byId.get(id) ?? []);
    for (const expectation of expectations) {
      const first = firstOf(reports.filter((report) => report.source === expectation.from && reportPasses(expectation.when, report)));
      if (first === undefined) continue;
      const copy = firstOf(reports.filter((report) => report.source === expectation.to));
      checks.push({ expectation: expectation.id, report: first.id, started: first.received, ...(copy === undefined ? {} : { arrived: copy.received }) });
    }
  }
  return checks.sort((a, b) => compare(a.expectation, b.expectation) || a.started - b.started || compare(a.report, b.report));
}

/**
 * This function gives the delays of the copies that came for one expectation, in milliseconds. A copy
 * that came first gives a negative delay. With `at`, a copy that came after `at` does not count.
 */
export function delaysOf(checks: readonly Carriage[], expectation: string, at?: Instant): Duration[] {
  return checks.flatMap((check) =>
    check.expectation === expectation && check.arrived !== undefined && (at === undefined || check.arrived <= at) ? [check.arrived - check.started] : [],
  );
}

/**
 * This function gives the limit of the delay: the distribution-free upper bound of the quantile of
 * the measured delays, from `quantileInterval` of `@mark1russell7/rigor-statistics`. A sample that is
 * too small has no upper bound, and the function gives `undefined`. Then `lateness` only measures.
 *
 * A copy that did not come is not a measure, because its delay is not known. So a sample from a time
 * when the source was down gives a lower limit. A lower limit gives more late states, which is the
 * safe side. The limit is not less than 0.
 */
export function delayLimit(delays: readonly Duration[], options: DelayLimitOptions): Duration | undefined {
  if (delays.length === 0) return undefined;
  const { high } = quantileInterval(delays, options.quantile, options.level);
  return Number.isFinite(high) ? Math.max(0, high) : undefined;
}

/**
 * This function gives the misses of the past of one expectation at the time `at`, for the limit of
 * the delay `delay`. Only a check after a met check is a trial. So a long stop of the source counts
 * as one miss, and does not raise the normal rate of the misses. A copy after its limit is a miss.
 */
export function missRecord(checks: readonly Carriage[], expectation: string, delay: Duration, at: Instant): MissRecord {
  const passed = checks
    .filter((check) => check.expectation === expectation && check.started + delay <= at)
    .sort((a, b) => a.started - b.started || compare(a.report, b.report));
  let trials = 0;
  let misses = 0;
  let afterMet = true;
  for (const check of passed) {
    const met = check.arrived !== undefined && check.arrived <= check.started + delay;
    if (afterMet) {
      trials += 1;
      if (!met) misses += 1;
    }
    afterMet = met;
  }
  return { trials, misses };
}

/**
 * This function gives the count of misses in a row that makes the source late. The count is the
 * smallest k with `high ** k <= 1 - level`. `high` is the upper bound of the rate of the misses, from
 * `clopperPearson` of `@mark1russell7/rigor-statistics`.
 *
 * Thus in normal work, k misses in a row come with a chance of `1 - level` or less. A source that
 * stops misses each check, so it is late after k checks. The function gives `undefined` when the
 * bound is 1, for example with no trials. Then `lateness` only measures.
 */
export function missLimit(record: MissRecord, level: number): number | undefined {
  const { high } = clopperPearson(record.misses, record.trials, level);
  if (!(high < 1)) return undefined;
  const alpha = 1 - level;
  if (high <= alpha) return 1;
  // The logarithms give the count, and the loop corrects an error of rounding at a whole number.
  let k = Math.max(1, Math.ceil(Math.log(alpha) / Math.log(high)));
  while (k > 1 && high ** (k - 1) <= alpha) k -= 1;
  while (high ** k > alpha) k += 1;
  return k;
}

/**
 * This function gives the limits of each expectation at the time `at`, by its id. The delay is
 * `delayLimit` of the delays of the copies that came by `at`. The misses are `missLimit` of the
 * record for that delay. An expectation with no delay or no count gets `undefined`.
 */
export function lateLimits(checks: readonly Carriage[], expectations: readonly Expectation[], at: Instant, options: DelayLimitOptions): Record<string, LatenessLimit | undefined> {
  const limits: Record<string, LatenessLimit | undefined> = {};
  for (const expectation of expectations) {
    const delay = delayLimit(delaysOf(checks, expectation.id, at), options);
    const misses = delay === undefined ? undefined : missLimit(missRecord(checks, expectation.id, delay, at), options.level);
    limits[expectation.id] = delay === undefined || misses === undefined ? undefined : { delay, misses };
  }
  return limits;
}

/**
 * This function gives the state of each expectation at the time `at`. `limits` gives the limits of
 * each expectation by its id, from `lateLimits`. A copy that came after `at` does not count. A check
 * that came after a miss ends the misses, because it shows that the source carries the reports again.
 */
export function lateness(checks: readonly Carriage[], expectations: readonly Expectation[], limits: Readonly<Record<string, LatenessLimit | undefined>>, at: Instant): Lateness[] {
  return expectations.map((expectation) => {
    const base = { expectation: expectation.id, from: expectation.from, to: expectation.to };
    const limit = limits[expectation.id];
    if (limit === undefined) return { ...base, state: "no-limit", missed: [] };
    const { delay } = limit;
    const own = checks.filter((check) => check.expectation === expectation.id);
    const came = (check: Carriage): boolean => check.arrived !== undefined && check.arrived <= at;
    const lastCame = Math.max(Number.NEGATIVE_INFINITY, ...own.filter(came).map((check) => check.started));
    const missed = own
      .filter((check) => !came(check) && check.started + delay <= at && check.started > lastCame)
      .sort((a, b) => a.started - b.started || compare(a.report, b.report));
    const pending = own.filter((check) => !came(check) && check.started + delay > at);
    // A count below 1 is not valid, and 1 is the safe side: the first miss makes the source late.
    const needed = Math.max(1, Math.ceil(limit.misses));
    const late = missed.length >= needed;
    const state: LatenessState = late ? "late" : lastCame > Number.NEGATIVE_INFINITY ? "met" : "no-data";
    return {
      ...base,
      state,
      limit,
      missed: missed.map((check) => check.report),
      ...(late ? { since: missed[needed - 1]!.started + delay } : {}),
      ...(pending.length === 0 ? {} : { wakeAt: Math.min(...pending.map((check) => check.started + delay)) }),
    };
  });
}

/** This function gives the sources that are late, sorted. The coverage does not count them. */
export function lateSources(states: readonly Lateness[]): SourceId[] {
  return [...new Set(states.filter((entry) => entry.state === "late").map((entry) => entry.to))].sort(compare);
}

// The first report: the earlier time first, then the smaller id.
function firstOf(reports: readonly Report[]): Report | undefined {
  let first: Report | undefined;
  for (const report of reports) {
    if (first === undefined || report.received < first.received || (report.received === first.received && compare(report.id, first.id) < 0)) first = report;
  }
  return first;
}

// The order of the code units, the same in each copy and each locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
