/**
 * The replay of the demo. Each step sends its message through the real code of the alert system.
 * The functions are `mapObservation` of the NWS source, `add` and `incidents` of the core, and
 * `assess` with the first policy. The core reads no clock: the time of each step goes to `incidents` as `at`.
 *
 * Each step also watches the sources. The fetch log goes through the health fold, from
 * `startHealth` with `observeFetch` and `advanceHealth`. Then `coverage`, `threats` and
 * `systemReports` give the system reports, and the same merge and assessment carry them.
 */

import {
  add,
  advanceHealth,
  assess,
  ASSESSED_LEVELS,
  coverage,
  coverageShort,
  DEFAULT_ASSESS_POLICY,
  DEFAULT_COVERAGE_POLICY,
  EMPTY_STATE,
  higherLevel,
  incidents,
  NO_SYSTEM_LINES,
  observationId,
  observeFetch,
  startHealth,
  systemReports,
  threats,
  type AssessedLevel,
  type Assessment,
  type Coverage,
  type FetchRecord,
  type HealthStep,
  type HealthTrack,
  type Incident,
  type Instant,
  type MapProblem,
  type MergeState,
  type Observation,
  type PersonWatch,
  type Report,
  type SourceDescriptor,
  type SourceHealth,
  type SystemLines,
  type Threat,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { mapObservation, SOURCE_ID } from "@mark1russell7/alerts-source-nws-api";
import type { Step } from "./demo.ts";

/** One coverage of the core, with the result of `coverageShort` for it. */
export type CoverageRow = Coverage & { readonly short: boolean };

/** The sources at one step: their health, the coverage and the system reports. */
export interface SourcesFrame {
  /** The health of each source at the time of the step, in the order of the sources. */
  readonly health: readonly SourceHealth[];
  /** The changes of the health states after the last step and by this step, in the order of time. */
  readonly transitions: HealthStep["transitions"];
  /** The coverage of each kind at each home, in the order of the places and then of the kinds. */
  readonly coverage: readonly CoverageRow[];
  /** The places and the kinds with a live watch or warning. */
  readonly threats: readonly Threat[];
  /** The system reports that this step makes. */
  readonly reports: readonly Report[];
  /** The incidents of the system reports, in the order of their first report. */
  readonly incidents: readonly Incident[];
  /** The assessment of each system incident for each person. */
  readonly assessments: readonly Assessment[];
}

/** The state of the system after one step. */
export interface Frame {
  readonly step: Step;
  /** The observation of the message of the step, as an adapter makes it. */
  readonly observation?: Observation;
  /** The reports that the map function made from the message of the step. */
  readonly reports: readonly Report[];
  /** The problems that the map function found. The demo expects none. */
  readonly problems: readonly MapProblem[];
  /** The merge state. It holds the reports of the source and the system reports. */
  readonly state: MergeState;
  /** The incidents of the messages of the source at the time of the step, in the order of their first report. */
  readonly incidents: readonly Incident[];
  /** The assessment of each incident for each person. */
  readonly assessments: readonly Assessment[];
  readonly sources: SourcesFrame;
}

/** The sources of the replay. */
export interface SourceWorld {
  readonly sources: readonly SourceDescriptor[];
  /** The fetch log of the sources. */
  readonly fetches: readonly FetchRecord[];
  /** The time at which the health of each source starts. */
  readonly start: Instant;
  /** The kinds that the coverage examines at each place. */
  readonly kinds: readonly string[];
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

const end = (record: FetchRecord): number => record.at + record.took;

/** This function does the steps in order, and gives the frame after each step. */
export function replay(steps: readonly Step[], people: readonly PersonWatch[], places: readonly WatchedPlace[], world: SourceWorld): Frame[] {
  let state: MergeState = EMPTY_STATE;
  let lines: SystemLines = NO_SYSTEM_LINES;
  let tracks: HealthTrack[] = world.sources.map((source) => startHealth(source.id, world.start));
  let previous = world.start;
  return steps.map((step) => {
    const observation = step.message === undefined ? undefined : observe(step.message.body, step.at);
    const mapped = observation === undefined ? { reports: [], problems: [] } : mapObservation(observation);
    state = add(state, { reports: mapped.reports });

    // The health: each fetch that ends after the last step and by this step, then the time of this step.
    const transitions: HealthStep["transitions"][number][] = [];
    const health: SourceHealth[] = [];
    tracks = tracks.map((track, index) => {
      const source = world.sources[index]!;
      const records = world.fetches.filter((record) => record.source === source.id && end(record) > previous && end(record) <= step.at);
      let next = track;
      for (const record of records.sort((a, b) => end(a) - end(b))) {
        const fetched = observeFetch(next, record, source);
        transitions.push(...fetched.transitions);
        next = fetched.track;
      }
      const moved = advanceHealth(next, step.at, source);
      transitions.push(...moved.transitions);
      health.push(moved.health);
      return moved.track;
    });
    previous = step.at;

    // The coverage and the threats come from the health and the incidents before the system reports of this step.
    const threatened = threats(incidents(state, step.at), places);
    const covered = coverage({ sources: world.sources, health, places, kinds: world.kinds }, DEFAULT_COVERAGE_POLICY);
    const system = systemReports(lines, { sources: world.sources, health, coverage: covered, threats: threatened }, step.at);
    lines = system.lines;
    state = add(state, { reports: system.reports });

    const byId = new Map<string, Report>(state.reports.map((report) => [report.id, report]));
    const head = (incident: Incident): Report =>
      incident.reports.map((id) => byId.get(id)!).reduce((best, report) => (report.sent < best.sent || (report.sent === best.sent && report.key < best.key) ? report : best));
    const order = (a: Incident, b: Incident): number => head(a).sent - head(b).sent || compare(head(a).key, head(b).key) || compare(a.anchor, b.anchor);
    const now = incidents(state, step.at).sort(order);
    const judge = (list: readonly Incident[]): Assessment[] => list.flatMap((incident) => people.map((person) => assess(incident, person, places, DEFAULT_ASSESS_POLICY)));
    const own = now.filter((incident) => incident.status !== "system");
    const reported = now.filter((incident) => incident.status === "system");
    return {
      step,
      ...(observation === undefined ? {} : { observation }),
      reports: mapped.reports,
      problems: mapped.problems,
      state,
      incidents: own,
      assessments: judge(own),
      sources: {
        health,
        transitions: transitions.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
        coverage: covered.map((entry) => ({ ...entry, short: coverageShort(entry) })),
        threats: threatened,
        reports: system.reports,
        incidents: reported,
        assessments: judge(reported),
      },
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
