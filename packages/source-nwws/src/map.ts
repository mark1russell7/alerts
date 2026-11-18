/**
 * The map function of the NWWS-OI source: one observation (one CAP message of the NWS from the stream of NWWS-OI) to
 * its reports in the one format of the system. The function is pure and total. The map of the message is
 * `capReports` of format-cap: one report for each info block in the chosen language.
 */

import type { MapProblem, MapResult, Observation, SourceId } from "@mark1russell7/alerts";
import { Problems } from "@mark1russell7/alerts";
import { capReports, DEFAULT_LANGUAGES, readCap } from "@mark1russell7/alerts-format-cap";
import { NWS_ORIGIN } from "@mark1russell7/alerts-format-nws";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "nwws" as SourceId;

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation, languages: readonly string[]): MapResult {
  const read = readCap(observation.body);
  if (!read.ok) return { reports: [], problems: [{ path: "", message: `the body is not a CAP message: ${read.reason}`, fatal: true }] };
  const problems = new Problems();
  // Each message of the stream comes from the NWS. A message of the NWS has keyed areas: the shapes of an area element decide for it.
  const reports = capReports(read.alert, observation, { source: SOURCE_ID, origin: NWS_ORIGIN, keyed: true, languages }, problems);
  const all: MapProblem[] = [...read.problems, ...problems.list];
  return { reports, problems: all };
}

/**
 * This function maps one observation of NWWS-OI to reports. The body is one CAP alert of the NWS. Each report has the
 * fields of one info block in the first language of `languages` that the message has. The function does not throw: an
 * error is a fatal problem.
 */
export function mapObservation(observation: Observation, languages: readonly string[] = DEFAULT_LANGUAGES): MapResult {
  try {
    return mapOrThrow(observation, languages);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
