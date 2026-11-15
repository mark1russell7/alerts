/**
 * The replay of the demo. Each step sends its message through the real code of the alert system.
 * The functions are `mapObservation` of the NWS source, `add` and `incidents` of the core, and
 * `assess` with the first policy. The core reads no clock: the time of each step goes to `incidents` as `at`.
 */

import {
  add,
  assess,
  ASSESSED_LEVELS,
  DEFAULT_ASSESS_POLICY,
  EMPTY_STATE,
  higherLevel,
  incidents,
  observationId,
  type AssessedLevel,
  type Assessment,
  type Incident,
  type MapProblem,
  type MergeState,
  type Observation,
  type PersonWatch,
  type Report,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { mapObservation, SOURCE_ID } from "@mark1russell7/alerts-source-nws-api";
import type { Step } from "./demo.ts";

/** The state of the system after one step. */
export interface Frame {
  readonly step: Step;
  /** The observation of the message of the step, as an adapter makes it. */
  readonly observation?: Observation;
  /** The reports that the map function made from the message of the step. */
  readonly reports: readonly Report[];
  /** The problems that the map function found. The demo expects none. */
  readonly problems: readonly MapProblem[];
  readonly state: MergeState;
  /** The incidents at the time of the step, in the order of their first report. */
  readonly incidents: readonly Incident[];
  /** The assessment of each incident for each person. */
  readonly assessments: readonly Assessment[];
}

const CONTENT_TYPE = "application/geo+json";

/** This function makes the observation of one message, as the adapter makes it after a fetch. */
export function observe(body: string, fetched: number): Observation {
  return {
    id: observationId({ source: SOURCE_ID, contentType: CONTENT_TYPE, body }),
    source: SOURCE_ID,
    fetched,
    contentType: CONTENT_TYPE,
    body,
    transport: { latency: 0 },
  };
}

/** This function does the steps in order, and gives the frame after each step. */
export function replay(steps: readonly Step[], people: readonly PersonWatch[], places: readonly WatchedPlace[]): Frame[] {
  let state: MergeState = EMPTY_STATE;
  return steps.map((step) => {
    const observation = step.message === undefined ? undefined : observe(step.message.body, step.at);
    const mapped = observation === undefined ? { reports: [], problems: [] } : mapObservation(observation);
    state = add(state, { reports: mapped.reports });
    const sent = new Map<string, number>(state.reports.map((report) => [report.id, report.sent]));
    const first = (incident: Incident): number => Math.min(...incident.reports.map((id) => sent.get(id) ?? Infinity));
    const now = incidents(state, step.at).sort((a, b) => first(a) - first(b) || compare(a.anchor, b.anchor));
    const assessments = now.flatMap((incident) => people.map((person) => assess(incident, person, places, DEFAULT_ASSESS_POLICY)));
    return {
      step,
      ...(observation === undefined ? {} : { observation }),
      reports: mapped.reports,
      problems: mapped.problems,
      state,
      incidents: now,
      assessments,
    };
  });
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** This function gives the highest level of the assessments, or `none` when the list is empty. */
export function topLevel(assessments: readonly Assessment[]): AssessedLevel {
  return assessments.reduce<AssessedLevel>((level, assessment) => higherLevel(level, assessment.level), "none");
}

/** The levels from the highest to `none`, as the view by level shows them. */
export const LEVELS_DOWN: readonly AssessedLevel[] = [...ASSESSED_LEVELS].reverse();
