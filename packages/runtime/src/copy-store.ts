/**
 * The measure of the copies of each expectation over the log of a runtime (AL-8). The log holds the reports of each
 * source as the runtime saw them, with the times of their receipt. Thus the measure gives the rate of the copies and
 * their delays for an expectation before the runtime uses it.
 *
 * The functions are pure. The script `scripts/measure-copies.ts` reads the log, replays it and prints the result.
 */

import { copyMeasure, type Duration, type Expectation, type Instant, type LinkRule, type Report, type SentClass, type SentCounts } from "@mark1russell7/alerts";
import { quantileSorted } from "@mark1russell7/rigor-statistics";

/** One expectation of the measure, with the key of its copy. */
export interface CopyCandidate {
  readonly expectation: Expectation;
  /** This function gives the key of the copy from the key of the message. The default gives the same key. */
  readonly copyKey?: (key: string) => string;
}

/** The delays of the copies of the class `same`, in milliseconds. A copy that came first gives a value below 0. */
export interface DelaySummary {
  readonly count: number;
  readonly min: Duration;
  readonly median: Duration;
  readonly p90: Duration;
  readonly max: Duration;
}

/** The result of the measure of one expectation. */
export interface CopySummary {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /**
   * The start of the measure: the `since` of the expectation, or else the first receipt of a report of the source `to`.
   * It is absent when the log has no report of `to`. Then the counts are 0.
   */
  readonly since?: Instant;
  readonly counts: SentCounts;
  /** The delays of the copies. It is absent when no copy came. */
  readonly delays?: DelaySummary;
  /** The count of the checks of each event, for each class that is not `same`. */
  readonly events: Readonly<Partial<Record<SentClass, Readonly<Record<string, number>>>>>;
}

/** The options of `copySummaries`. */
export interface CopySummaryOptions {
  /** A message with a sent time less than this time before the end of the data, and with no copy, is censored. */
  readonly censor: Duration;
  /** This function gives the event of a message. The default is the code of the kind of the report. */
  readonly eventOf?: (report: Report) => string;
  /** The link rule of the incidents, as in the runtime. */
  readonly link?: LinkRule;
}

const NO_COUNTS: SentCounts = { messages: 0, same: 0, shifted: 0, lost: 0, apart: 0, none: 0, censored: 0 };

/**
 * This function measures the copies of each candidate over the reports of a log, with `copyMeasure` of the core.
 * The time `end` is the end of the data, for example the time of the replayed state.
 *
 * - A check before the start of the measure is not in the counts. Before the first report of the source `to`, the runtime did not read that source.
 * - The censor time is `end` minus `censor`.
 */
export function copySummaries(reports: readonly Report[], end: Instant, candidates: readonly CopyCandidate[], options: CopySummaryOptions): CopySummary[] {
  return candidates.map(({ expectation, copyKey }) => {
    const base = { id: expectation.id, from: expectation.from, to: expectation.to };
    const since = expectation.since ?? firstReceipt(reports, expectation.to);
    if (since === undefined) return { ...base, counts: NO_COUNTS, events: {} };
    const measure = copyMeasure(reports, { ...expectation, since }, {
      censorAfter: end - options.censor,
      ...(copyKey === undefined ? {} : { copyKey }),
      ...(options.eventOf === undefined ? {} : { eventOf: options.eventOf }),
      ...(options.link === undefined ? {} : { link: options.link }),
    });
    const events: Partial<Record<SentClass, Record<string, number>>> = {};
    for (const check of measure.checks) {
      if (check.class === "same") continue;
      const counts = (events[check.class] ??= {});
      counts[check.event] = (counts[check.event] ?? 0) + 1;
    }
    const delays = delaySummary(measure.checks.flatMap((check) => (check.delay === undefined ? [] : [check.delay])));
    return { ...base, since, counts: measure.counts, ...(delays === undefined ? {} : { delays }), events };
  });
}

// The first receipt of a report of a source, or undefined when no report of the source is there.
function firstReceipt(reports: readonly Report[], source: string): Instant | undefined {
  let first: Instant | undefined;
  for (const report of reports) if (report.source === source && (first === undefined || report.received < first)) first = report.received;
  return first;
}

// The quantiles of the delays, with the linear method of rigor-statistics. An empty list gives undefined.
function delaySummary(delays: readonly Duration[]): DelaySummary | undefined {
  if (delays.length === 0) return undefined;
  const sorted = [...delays].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0]!,
    median: quantileSorted(sorted, 0.5),
    p90: quantileSorted(sorted, 0.9),
    max: sorted[sorted.length - 1]!,
  };
}
