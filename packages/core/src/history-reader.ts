/**
 * This module is the reader of the history route. A reader keeps the history of each incident by its anchor, and it
 * adds each answer of the route to them. A time scrubber of a page reads the times of the changes from them. The
 * module is a pure calculation with no clock and no request.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { Instant, ReportId } from "./contracts.ts";
import type { HistoryIncident, HistoryPayload, HistoryRegion } from "./history.ts";
import { compareRegionCodes, regionCodeKey } from "./map.ts";

/** The histories that a reader of the history route keeps. */
export interface Histories {
  /** The time of the newest answer: the time of the last pass of the runtime, or `null` before the first pass. */
  readonly at: Instant | null;
  /** The query `since` of the next read. The value `null` asks for each incident. */
  readonly since: Instant | null;
  /** The history of each incident, in the order of the anchors. */
  readonly incidents: readonly HistoryIncident[];
  /** The shapes of each region code of the changes, one time each, in the order of the system and the code. */
  readonly regions: readonly HistoryRegion[];
}

/** The histories of a reader before its first read. */
export const NO_HISTORIES: Histories = { at: null, since: null, incidents: [], regions: [] };

/**
 * This function adds one answer of the history route to the histories of a reader. An answer to a read with no `since`
 * has each incident, so it replaces each history. An answer to a read with `since` replaces the history of each of its
 * incidents. It also drops each history whose anchor is a report of an incident of the answer, because these incidents
 * merged. The result keeps only the regions of its changes.
 *
 * The field `since` of the result is the query of the next read. It is `null` when the answer has no newest change, or
 * when that time is below the `since` of the answer. Then a step of the clock moved the times, and the next read asks
 * for each incident again.
 */
export function addHistory(kept: Histories, payload: HistoryPayload): Histories {
  const replaced = new Set<ReportId>(payload.incidents.flatMap((incident) => [incident.anchor, ...incident.reports]));
  const older = payload.since === null ? [] : kept.incidents.filter((incident) => !replaced.has(incident.anchor));
  const incidents = [...older, ...payload.incidents].sort((a, b) => compareCodeUnits(a.anchor, b.anchor));

  // The shapes of a code come from the newest answer that has the code. A code of no change leaves the histories.
  const known = new Map<string, HistoryRegion>();
  for (const region of [...kept.regions, ...payload.regions]) known.set(regionCodeKey(region.code), region);
  const regions = new Map<string, HistoryRegion>();
  for (const code of incidents.flatMap((incident) => incident.changes.flatMap((change) => change.codes))) {
    const key = regionCodeKey(code);
    const region = known.get(key);
    if (region !== undefined) regions.set(key, region);
  }

  const next = payload.next;
  const since = next !== null && (payload.since === null || next >= payload.since) ? next : null;
  return { at: payload.at, since, incidents, regions: [...regions.values()].sort((a, b) => compareRegionCodes(a.code, b.code)) };
}

/** This function gives the time of each change of the histories, one time each, from the oldest. A scrubber shows a tick at each time. */
export function historyTimes(kept: Histories): readonly Instant[] {
  const times = new Set<Instant>(kept.incidents.flatMap((incident) => incident.changes.map((change) => change.at)));
  return [...times].sort((a, b) => a - b);
}
