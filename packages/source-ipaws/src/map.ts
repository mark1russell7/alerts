/**
 * The map function of the IPAWS source: one observation (one CAP alert of the public feed of FEMA
 * IPAWS) to its reports in the one format of the system. The function is pure and total. The map of the
 * message is `capReports` of format-cap: one report for each info block in the chosen language.
 */

import type { MapProblem, MapResult, Observation, SourceId } from "@mark1russell7/alerts";
import { Problems } from "@mark1russell7/alerts";
import { capReports, DEFAULT_LANGUAGES, readCap } from "@mark1russell7/alerts-format-cap";
import { NWS_ORIGIN } from "@mark1russell7/alerts-format-nws";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "ipaws" as SourceId;

/**
 * The authorities of the messages of IPAWS. The NWS sends its messages for Wireless Emergency
 * Alerts (WEA) to IPAWS. Each other message comes from an alerting authority of IPAWS: a state, a
 * county, a city or a federal agency. The descriptor lists both in `origins`.
 */
export const ORIGINS: { readonly nws: typeof NWS_ORIGIN; readonly authority: "ipaws-authority" } = { nws: NWS_ORIGIN, authority: "ipaws-authority" };

/** The sender of each message of the NWS in IPAWS. */
export const NWS_SENDER = "w-nws.webmaster@noaa.gov";

/** This function gives the authority of a message from its sender. */
export function originOf(sender: string): string {
  return sender.trim().toLowerCase() === NWS_SENDER ? ORIGINS.nws : ORIGINS.authority;
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation, languages: readonly string[]): MapResult {
  const read = readCap(observation.body);
  if (!read.ok) return { reports: [], problems: [{ path: "", message: `the body is not a CAP message: ${read.reason}`, fatal: true }] };
  const problems = new Problems();
  const origin = originOf(read.alert.sender);
  // A message of the NWS has keyed areas: the shapes of an area element decide for it.
  const reports = capReports(read.alert, observation, { source: SOURCE_ID, origin, keyed: origin === ORIGINS.nws, languages }, problems);
  const all: MapProblem[] = [...read.problems, ...problems.list];
  return { reports, problems: all };
}

/**
 * This function maps one observation of IPAWS to reports. The body is one CAP alert. Each report has
 * the fields of one info block in the first language of `languages` that the message has. The function
 * does not throw: an error is a fatal problem. It does not read the transport of the observation.
 */
export function mapObservation(observation: Observation, languages: readonly string[] = DEFAULT_LANGUAGES): MapResult {
  try {
    return mapOrThrow(observation, languages);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
