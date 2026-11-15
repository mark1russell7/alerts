/**
 * This module ends the reports of a snapshot source. Each complete fetch of a snapshot source gives all
 * its messages that are in effect. A message that ends leaves the list, with no cancel. Thus the runtime
 * counts the complete fetches in a row that miss a live report of the source. At the limit, it writes an
 * `ended` event. A report that ended and is in a complete list again gets a `back` event.
 *
 * The counts are in memory only. After a restart they start at 0. Thus a restart makes an end later,
 * not sooner. A failed fetch or a part of a list tells nothing of an absent report, and counts nothing.
 *
 * A cache or a late copy of a database can give an old list that is complete. The time of the data of a list
 * (`asOf` of the fetch) tells its age. A list tells nothing of a report that is newer than the list:
 *
 * - An absent report counts a miss only when its `sent` time is not after the time of the list. A newer report
 *   keeps its count.
 * - An ended report comes back only when the list is newer than the list that ended it. A list with the same time
 *   can be an old copy, so the report stays ended until a newer product comes.
 *
 * A list with no time counts as current. The end mark keeps the time of the list that ended the report, so the rule
 * is the same after a restart.
 */
import { endedReports, type FetchOutcome, type Instant, type MergeState, type ReportId, type SourceId } from "@mark1russell7/alerts";
import { envelope, type BackEvent, type EndedEvent } from "./events.ts";

/**
 * The count of complete fetches in a row that miss a report before its end. The value 2 is a shortcut
 * with no measure. It ends when `missesDecision` of the measure of the IEM list gives the count (AL-8).
 */
export const SNAPSHOT_MISSES = 2;

/** The input of `snapshotStep`. */
export interface SnapshotInput {
  readonly source: SourceId;
  /** The start and the end of the fetch. The events have the time of the end. */
  readonly started: Instant;
  readonly ended: Instant;
  readonly outcome: FetchOutcome;
  /** The merge state after the events of the fetch. */
  readonly merge: MergeState;
  /** The count of misses of each report of the source before this fetch. */
  readonly misses: ReadonlyMap<ReportId, number>;
  /** The count of misses that ends a report. It is 1 or more. */
  readonly limit: number;
}

/** The result of `snapshotStep`: the events to write, and the counts after the fetch. */
export interface SnapshotStep {
  readonly events: readonly (EndedEvent | BackEvent)[];
  readonly misses: ReadonlyMap<ReportId, number>;
}

/**
 * This function gives the end events of one fetch of a snapshot source. It is pure. A report counts a
 * miss when its observation is not in the complete fetch. A report that is cancelled, expired or ended
 * at the end of the fetch counts no miss. A report that is newer than the list keeps its count.
 */
export function snapshotStep(input: SnapshotInput): SnapshotStep {
  const { source, outcome, merge, ended: at } = input;
  if (!outcome.ok || !outcome.complete) return { events: [], misses: input.misses };
  const listed = new Set<string>(outcome.observations.map((observation) => observation.id));
  const asOf = outcome.asOf;
  const ended = endedReports(merge, at);
  const endedBy = endingLists(merge, ended, at);
  const misses = new Map<ReportId, number>();
  const gone: ReportId[] = [];
  const back: ReportId[] = [];
  // The reports are in the order of their ids, thus the lists of the events are too.
  for (const report of merge.reports) {
    if (report.source !== source) continue;
    if (listed.has(report.observation)) {
      if (ended.has(report.id) && newer(asOf, endedBy.get(report.id))) back.push(report.id);
      continue;
    }
    if (ended.has(report.id) || report.op === "cancel" || (report.expires !== undefined && report.expires <= at)) continue;
    const held = input.misses.get(report.id);
    if (asOf !== undefined && report.sent > asOf) {
      if (held !== undefined) misses.set(report.id, held);
      continue;
    }
    const count = (held ?? 0) + 1;
    if (count >= input.limit) gone.push(report.id);
    else misses.set(report.id, count);
  }
  const events: (EndedEvent | BackEvent)[] = [];
  if (gone.length > 0) events.push({ ...envelope("ended", `ended:${source}:${input.started}`, at), source, reports: gone, ...(asOf === undefined ? {} : { asOf }) });
  if (back.length > 0) events.push({ ...envelope("back", `back:${source}:${input.started}`, at), source, reports: back });
  return { events, misses };
}

/** This function gives the time of the list that ended each ended report: the `asOf` of its latest end mark at `at` or before. */
function endingLists(merge: MergeState, ended: ReadonlySet<ReportId>, at: Instant): ReadonlyMap<ReportId, Instant | undefined> {
  const latest = new Map<ReportId, { readonly at: Instant; readonly asOf: Instant | undefined }>();
  for (const mark of merge.ends) {
    if (!mark.ended || mark.at > at || !ended.has(mark.report)) continue;
    const held = latest.get(mark.report);
    if (held === undefined || mark.at > held.at) latest.set(mark.report, { at: mark.at, asOf: mark.asOf });
  }
  return new Map([...latest].map(([report, mark]) => [report, mark.asOf]));
}

/** This function tells if a list is newer than the list that ended a report. A list or an end with no time counts as newer. */
function newer(list: Instant | undefined, end: Instant | undefined): boolean {
  return list === undefined || end === undefined || list > end;
}
