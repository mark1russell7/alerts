/**
 * The map function of the source of a CAP feed: one observation (one CAP message of the feed) to its reports in the
 * one format of the system. The function is pure and total. The map of the message is `capReports` of format-cap.
 */

import type { MapProblem, MapResult, Observation } from "@mark1russell7/alerts";
import { Problems } from "@mark1russell7/alerts";
import { capReports, DEFAULT_LANGUAGES, readCap } from "@mark1russell7/alerts-format-cap";
import { errorMessage } from "@mark1russell7/text";

import type { CapFeed } from "./feed.ts";

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation, feed: CapFeed): MapResult {
  const read = readCap(observation.body);
  if (!read.ok) return { reports: [], problems: [{ path: "", message: `the body is not a CAP message: ${read.reason}`, fatal: true }] };
  const problems = new Problems();
  const options = { source: feed.id, origin: feed.origin, keyed: feed.keyed ?? false, languages: feed.languages ?? DEFAULT_LANGUAGES };
  const reports = capReports(read.alert, observation, options, problems);
  const all: MapProblem[] = [...read.problems, ...problems.list];
  return { reports, problems: all };
}

/**
 * This function maps one observation of a feed to reports: one report for each info block in the chosen language.
 * Each report has the source and the origin of the feed. The function does not throw: an error is a fatal problem.
 */
export function mapObservation(observation: Observation, feed: CapFeed): MapResult {
  try {
    return mapOrThrow(observation, feed);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
