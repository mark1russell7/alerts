/**
 * The map function of the tsunami source: one observation (the latest CAP message of one center) to its reports in
 * the one format of the system. The function is pure and total. The map of the message is `capReports` of format-cap.
 * A bulletin puts a warning, an advisory and a watch in the info blocks of one message, so it gives one report for each
 * block.
 */

import type { MapProblem, MapResult, Observation } from "@mark1russell7/alerts";
import { Problems } from "@mark1russell7/alerts";
import { capReports, DEFAULT_LANGUAGES, readCap } from "@mark1russell7/alerts-format-cap";
import { NWS_ORIGIN } from "@mark1russell7/alerts-format-nws";
import { errorMessage } from "@mark1russell7/text";

import type { TsunamiCenter } from "./centers.ts";

/** The kind of each message of the centers. */
export const TSUNAMI_KIND = "geo.tsunami";

/** The sender of each message of the two centers. */
export const TSUNAMI_SENDER = "ntwc@noaa.gov";

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation, center: TsunamiCenter, languages: readonly string[]): MapResult {
  const read = readCap(observation.body);
  if (!read.ok) return { reports: [], problems: [{ path: "", message: `the body is not a CAP message: ${read.reason}`, fatal: true }] };
  const problems = new Problems();
  // The areas are not keyed. The area element of a bulletin has the zones of the coast and a circle of radius 0 at
  // the epicenter. A keyed area gives the decision to the circle, and the circle holds no place.
  const reports = capReports(read.alert, observation, { source: center.id, origin: NWS_ORIGIN, keyed: false, languages }, problems);
  const all: MapProblem[] = [...read.problems, ...problems.list];
  return { reports, problems: all };
}

/**
 * This function maps one observation of a center to reports. The body is one CAP message. Each report has the source
 * of the center and the origin of the NWS. Rule 2 of the merge joins it to a report of the same event from a different
 * path of the NWS, by its VTEC. The function does not throw: an error is a fatal problem.
 */
export function mapObservation(observation: Observation, center: TsunamiCenter, languages: readonly string[] = DEFAULT_LANGUAGES): MapResult {
  try {
    return mapOrThrow(observation, center, languages);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
