/**
 * The retention of the merge state (AL-47). An incident that ended long ago leaves the merge state as a whole. The
 * event log keeps each of its reports. Thus the cost of a pass follows the recent incidents, not the age of the instance.
 *
 * - `retirements` gives the reports of each whole incident that is not live and has no change in the horizon.
 * - `retire` gives them tombstones. A tombstone keeps a late copy of a report out of the state.
 *   An example is a copy from the log of another copy of the system.
 * - `pruneTombstones` drops each tombstone after its time `until`, thus the tombstones also have a bound.
 *
 * A retirement removes whole incidents. The groups of reports are the connected components of the links, thus the
 * removal of a whole group changes no other group. The test of this module holds it.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { Duration, Incident, Instant, MergeState, ReportId } from "./contracts.ts";
import { add } from "./merge.ts";

const DAY = 86_400_000;

/** The default horizon: an incident leaves the merge state 7 days after its last change. */
export const RETENTION_HORIZON: Duration = 7 * DAY;

/**
 * The default life of a tombstone: 30 days. A feed lists a report for approximately 30 days at most, for example the
 * feed of the earthquakes of the last 30 days. A new copy of the system that fetches the report gives it while the
 * tombstone is there, thus the report stays out.
 */
export const TOMBSTONE_LIFE: Duration = 30 * DAY;

/**
 * This function gives the reports to retire at a time, in the order of their ids. `found` is the incidents of `state`
 * at `at`. An incident retires as a whole when it is not live and its last change is at or before `at - horizon`.
 *
 * The last change of an incident is the latest time of its parts. These are the sent, received and expiry times of its
 * reports, and the times of their end marks, deliveries and acknowledgments. Thus an expiry in the future keeps a
 * cancelled report. Each error is on the safe side: an incident stays longer, not shorter.
 */
export function retirements(state: MergeState, found: readonly Incident[], at: Instant, horizon: Duration = RETENTION_HORIZON): ReportId[] {
  const changed = new Map<ReportId, Instant>();
  const touch = (report: ReportId, time: Instant): void => {
    const held = changed.get(report);
    if (held === undefined || time > held) changed.set(report, time);
  };
  for (const report of state.reports) touch(report.id, Math.max(report.sent, report.received, report.expires ?? -Infinity));
  for (const mark of state.ends) touch(mark.report, mark.at);
  for (const delivery of state.deliveries) touch(delivery.incident, delivery.at);
  for (const ack of state.acks) touch(ack.incident, ack.at);
  const limit = at - Math.max(0, horizon);
  return found
    .filter((incident) => !incident.live && incident.reports.every((report) => (changed.get(report) ?? Infinity) <= limit))
    .flatMap((incident) => incident.reports)
    .sort(compareCodeUnits);
}

/** This function gives the state with a tombstone for each report, until the time `until`. It removes the parts of the reports. */
export function retire(state: MergeState, reports: readonly ReportId[], until: Instant): MergeState {
  return add(state, { retired: reports.map((report) => ({ report, until })) });
}

/** This function drops each tombstone with its time `until` at or before `at`. It brings back no part. */
export function pruneTombstones(state: MergeState, at: Instant): MergeState {
  const retired = state.retired.filter((tombstone) => tombstone.until > at);
  return retired.length === state.retired.length ? state : { ...state, retired };
}

