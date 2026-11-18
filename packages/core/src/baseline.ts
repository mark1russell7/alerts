/**
 * The baseline and the read of an indicator series. The read tells how far the latest value of a series is from the
 * normal level of the series.
 *
 * - With the baseline `none`, the normal level comes from the history of the series. The history holds the values at the same time of the week or of the day.
 * - With the baseline `expected`, the read compares the residual of the latest value with the residuals of the history. A residual is the value minus its expected value.
 * - With the baseline `flag`, the flag of the source is the signal.
 * - The score is the robust z-score of Iglewicz and Hoaglin, from `modifiedZ` of `@mark1russell7/rigor-statistics`.
 *
 * A series with too few values, or with no recent value, has no read. A missing value is not a normal value at any time.
 */
import { median, modifiedZ, MODIFIED_Z_CUT } from "@mark1russell7/rigor-statistics";
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { Duration, Instant, MeasureDeclaration, Move, Reading } from "./contracts.ts";
import { seriesKey } from "./indicators.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** The season of the normal level: the same time of the week, the same time of the day, or each time. */
export type Season = "week" | "day" | "none";

/** The settings of the baseline of a series. `DEFAULT_BASELINE` gives a value for each one. */
export interface BaselinePolicy {
  /** The history that the baseline reads, before the time of the latest value. */
  readonly window: Duration;
  readonly season: Season;
  /**
   * The half width of the slot of the season. With 1 h and the season `day`, the slot of 08:00 holds the values from
   * 07:00 to 09:00 of each earlier day. A slot holds no value of the period of the latest value.
   */
  readonly slack: Duration;
  /** The fewest values of the history in the slot that give a read. */
  readonly samples: number;
  /** The cut of the absolute score that is a signal. */
  readonly cut: number;
  /** The count of cadences with no new value that makes a series stale. The delay of the measure adds to this time. */
  readonly staleCadences: number;
  /** The time with no new value that makes a series stale when its cadence is not known. */
  readonly staleAfter: Duration;
}

/**
 * The default baseline: the same time of the week, within 1 h, in the 28 days before the latest value. The cut is the
 * cut of Iglewicz and Hoaglin, 3.5.
 */
export const DEFAULT_BASELINE: BaselinePolicy = {
  window: 28 * DAY,
  season: "week",
  slack: HOUR,
  samples: 8,
  cut: MODIFIED_Z_CUT,
  staleCadences: 3,
  staleAfter: 6 * HOUR,
};

/** The cause of a series with no read. */
export type NoReadCause =
  /** The series has no reading at the time of the read. */
  | "no-reading"
  /** The latest reading is older than the stale time of the series. */
  | "stale"
  /** The history has fewer values in the slot than the policy needs. */
  | "few-samples";

/** The read of one series at one time. */
export type SeriesRead =
  /** The robust score of the latest value. `center` is the normal level of the value, in the unit of the measure. */
  | { readonly kind: "score"; readonly at: Instant; readonly score: number; readonly signal: boolean; readonly center: number; readonly samples: number }
  /** The flag of the source on the latest value. */
  | { readonly kind: "flag"; readonly at: Instant; readonly signal: boolean }
  | { readonly kind: "no-read"; readonly cause: NoReadCause };

/** This function tells if a score is a signal for the direction of a measure. */
export function isSignal(score: number, moves: Move, cut: number): boolean {
  if (moves === "rise") return score >= cut;
  if (moves === "drop") return score <= -cut;
  return Math.abs(score) >= cut;
}

/** This function gives the time with no new value that makes a series stale. The cadence of the reading comes first. */
export function staleTime(latest: Reading, measure: MeasureDeclaration, policy: BaselinePolicy = DEFAULT_BASELINE): Duration {
  const cadence = latest.cadence ?? measure.cadence;
  return cadence === undefined ? policy.staleAfter : policy.staleCadences * cadence + (measure.delay ?? 0);
}

// This function tells if the gap from a value of the history to the latest value is in the slot of the season: within
// the slack of one or more whole periods.
function inSlot(gap: Duration, policy: BaselinePolicy): boolean {
  if (policy.season === "none") return true;
  const period = policy.season === "week" ? WEEK : DAY;
  const periods = Math.max(1, Math.round(gap / period));
  return Math.abs(gap - periods * period) <= policy.slack;
}

// The order of two readings of one time: the smaller observation id first. The order of the input does not change it.
function earlier(a: Reading, b: Reading): number {
  return a.at - b.at || compareCodeUnits(a.observation, b.observation);
}

/**
 * This function reads one series at the time `now`. The readings are of one source, one measure and one series id.
 * They can hold two versions, duplicates and any order.
 *
 * - The latest reading at `now` or before gives the version. The history holds only the readings with its key, so a
 *   baseline does not cross a version.
 * - The history holds one reading for each time: the reading with the smallest observation id.
 * - The score of the latest value is its robust z-score among the values of the history and itself.
 */
export function readSeries(readings: readonly Reading[], measure: MeasureDeclaration, now: Instant, policy: BaselinePolicy = DEFAULT_BASELINE): SeriesRead {
  const live = readings.filter((reading) => reading.at <= now && (measure.baseline !== "expected" || reading.expected !== undefined)).sort(earlier);
  const newest = live.at(-1);
  if (newest === undefined) return { kind: "no-read", cause: "no-reading" };
  const latest = live.find((reading) => reading.at === newest.at) ?? newest;
  if (now - latest.at > staleTime(latest, measure, policy)) return { kind: "no-read", cause: "stale" };
  if (measure.baseline === "flag") return { kind: "flag", at: latest.at, signal: latest.flagged === true };
  const key = seriesKey(latest);
  const valueOf = (reading: Reading): number => reading.value - (measure.baseline === "expected" ? (reading.expected ?? 0) : 0);
  const history: number[] = [];
  let last: Instant | undefined;
  for (const reading of live) {
    if (reading.at === last || reading.at >= latest.at || latest.at - reading.at > policy.window) continue;
    if (seriesKey(reading) !== key || !inSlot(latest.at - reading.at, policy)) continue;
    last = reading.at;
    history.push(valueOf(reading));
  }
  if (history.length < policy.samples) return { kind: "no-read", cause: "few-samples" };
  const scores = modifiedZ([...history, valueOf(latest)]).scores;
  const score = scores[scores.length - 1] ?? 0;
  const center = median(history) + (measure.baseline === "expected" ? (latest.expected ?? 0) : 0);
  return { kind: "score", at: latest.at, score, signal: isSignal(score, measure.moves, policy.cut), center, samples: history.length };
}
