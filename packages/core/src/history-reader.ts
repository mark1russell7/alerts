/**
 * This module is the reader of the history route. A reader keeps the history of each incident by its anchor, and it
 * adds each answer of the route to them. A time scrubber of a page reads the times of the changes from them. The
 * module is a pure calculation with no clock and no request.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { Instant, RegionCode, ReportId } from "./contracts.ts";
import type { HistoryChange, HistoryIncident, HistoryPayload, HistoryRegion } from "./history.ts";
import { compareMapIncidents, compareRegionCodes, regionCodeKey, type MapIncident, type MapPlace, type MapView } from "./map.ts";
import { distinctShapes } from "./shapes.ts";

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

/**
 * This function tells if a change of an incident is on the map at a time. The change is on the map from its time to
 * the next change of the incident, while the incident is live. A live change with an expiry leaves the map at the
 * expiry, as a report is not live at its expiry.
 */
function shownAt(change: HistoryChange, next: HistoryChange | undefined, at: Instant): boolean {
  return change.live && change.at <= at && (next === undefined || at < next.at) && (change.expires === undefined || at < change.expires);
}

/**
 * This function gives the times at which the map of the histories changes, one time each, from the oldest. These are
 * the time of each change, and the expiry of a live change that comes before the next change of its incident. A
 * scrubber shows a tick at each time. An expiry can be after the time of the histories.
 */
export function historyTimes(kept: Histories): readonly Instant[] {
  const times = new Set<Instant>();
  for (const incident of kept.incidents) {
    incident.changes.forEach((change, index) => {
      times.add(change.at);
      const next = incident.changes[index + 1];
      if (change.live && change.expires !== undefined && change.expires > change.at && (next === undefined || change.expires < next.at)) times.add(change.expires);
    });
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * This function gives the change of an incident that is on the map at a time, or `undefined` when the incident is not
 * on the map: before its first change, after its end and after its expiry.
 */
export function historyChangeAt(incident: HistoryIncident, at: Instant): HistoryChange | undefined {
  const index = incident.changes.findLastIndex((change) => change.at <= at);
  const change = incident.changes[index];
  return change !== undefined && shownAt(change, incident.changes[index + 1], at) ? change : undefined;
}

/**
 * This function gives the view of the map at a time of the histories. The view has each incident that is on the map at
 * that time, with the level, the severity and the areas of its change. A page draws this view with the renderer of the
 * live map. The order of the incidents is the order of the live view.
 *
 * A change of the history names no place. Thus each place of the result keeps its label, its position and its shapes
 * from `places`, with the level `none`, no incident and no gap. The places of the live view give `places`.
 */
export function historyView(kept: Histories, at: Instant, places: readonly MapPlace[]): MapView {
  const shapes = new Map(kept.regions.map((region) => [regionCodeKey(region.code), region.shapes]));
  const unshaped = new Map<string, RegionCode>();
  const incidents = kept.incidents
    .flatMap((incident): MapIncident[] => {
      const change = historyChangeAt(incident, at);
      if (change === undefined) return [];
      for (const code of change.unshaped) unshaped.set(regionCodeKey(code), code);
      return [
        {
          anchor: incident.anchor,
          status: incident.status,
          kind: incident.kind,
          level: change.level,
          severity: change.severity,
          ...(change.onset === undefined ? {} : { onset: change.onset }),
          ...(change.expires === undefined ? {} : { expires: change.expires }),
          shapes: distinctShapes([...change.shapes, ...change.codes.flatMap((code) => shapes.get(regionCodeKey(code)) ?? [])]),
          unshaped: change.unshaped,
          places: [],
        },
      ];
    })
    .sort(compareMapIncidents);
  return {
    incidents,
    places: places.map(({ id, label, at: position, shapes: own }) => ({ id, label, ...(position === undefined ? {} : { at: position }), shapes: own, level: "none", incidents: [], gaps: [] })),
    unshaped: [...unshaped.values()].sort(compareRegionCodes),
  };
}
