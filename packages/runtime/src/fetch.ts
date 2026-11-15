/**
 * This module makes the events of one fetch. It is pure: the runtime gives the outcome, the times and
 * the ids that the log has. The runtime applies the map of a source to each observation of the fetch.
 * The fatal problems of the last passed fetch give the health. The log keeps only the new observations and
 * their reports, thus a read that repeats does not make the file larger.
 */
import type { CanaryResult, FetchOutcome, FetchRecord, Instant, MapProblem, MapResult, Observation, ObservationId, Report, SourceId, SourceProcedures } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { envelope, type FetchEvent, type ObservationEvent } from "./events.ts";

/** The input of `fetchEvents`. */
export interface FetchInput {
  readonly source: SourceId;
  /** The map and the canary check of the source. */
  readonly procedures: Pick<SourceProcedures, "map" | "check">;
  /** The start and the end of the fetch. */
  readonly started: Instant;
  readonly ended: Instant;
  readonly outcome: FetchOutcome;
  /** This function tells if the log has an observation. */
  readonly known: (id: ObservationId) => boolean;
}

/** This function gives the events of one fetch: one event for each new observation, then the fetch event. */
export function fetchEvents(input: FetchInput): (ObservationEvent | FetchEvent)[] {
  const { source, started, ended, outcome } = input;
  const took = Math.max(0, ended - started);
  const id = `fetch:${source}:${started}`;
  if (!outcome.ok) {
    const record: FetchRecord = { source, at: started, took, failure: outcome.failure, fresh: 0, fatal: 0 };
    return [{ ...envelope("fetch", id, ended), record, reports: [], problems: [] }];
  }
  // A fetch can give an observation twice. Each id counts once.
  const unique = [...new Map(outcome.observations.map((observation) => [observation.id, observation])).values()];
  const fresh = unique.filter((observation) => !input.known(observation.id));
  const isFresh = new Set(fresh.map((observation) => observation.id));
  let fatal = 0;
  const reports: Report[] = [];
  const problems: MapProblem[] = [];
  for (const observation of unique) {
    const result = mapSafely(input.procedures, observation);
    fatal += result.problems.filter((problem) => problem.fatal).length;
    if (!isFresh.has(observation.id)) continue;
    reports.push(...result.reports);
    problems.push(...result.problems);
  }
  const canary = checkSafely(input.procedures, outcome.observations);
  const record: FetchRecord = { source, at: started, took, fresh: fresh.length, fatal, ...(canary === undefined ? {} : { canary }) };
  const observed = fresh.map((observation): ObservationEvent => ({ ...envelope("observation", observation.id, ended), observation }));
  return [...observed, { ...envelope("fetch", id, ended), record, ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }), reports, problems }];
}

// A map that throws is a fault of the adapter. It is a fatal problem of its observation, thus the health
// goes to `changed`, and the loop continues for the other observations and the other sources.
function mapSafely(procedures: FetchInput["procedures"], observation: Observation): MapResult {
  try {
    return procedures.map({ observation });
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `The map threw: ${errorMessage(error)}`, fatal: true }] };
  }
}

// A canary check that throws is a failed canary.
function checkSafely(procedures: FetchInput["procedures"], observations: readonly Observation[]): CanaryResult | undefined {
  if (procedures.check === undefined) return undefined;
  try {
    return procedures.check({ observations });
  } catch (error) {
    return { pass: false, reason: `The canary check threw: ${errorMessage(error)}` };
  }
}
