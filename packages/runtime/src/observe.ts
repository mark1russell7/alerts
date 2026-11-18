/**
 * This module holds the observe mode of the sources in the runtime (AL-73). The core has the cut, the verdict and the
 * conditions (`observe.ts` of the core). This module keeps the mode of each source in the log. It gives the parts of one
 * pass: the mode events, the verdicts, the cut of the delivery step and the status.
 *
 * The mode of a source is a fold of its mode events (`ModeEvent`). Thus a restart keeps each mode, and the time of a mode
 * does not change after its first event.
 */
import {
  contextSource,
  observeCut,
  observeVerdict,
  type AssessPolicy,
  type Incident,
  type Instant,
  type MergeState,
  type ObserveCut,
  type ObserveVerdict,
  type PersonWatch,
  type ReportId,
  type SendLimits,
  type SourceDescriptor,
  type SourceId,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { envelope, type ModeEvent, type SourceMode } from "./events.ts";
import type { RuntimeState } from "./state.ts";

/** The reason of each mode event of the first start with modes. */
export const SEED_REASON = "seed";

/** This function gives the mode event of a source at `at`. Its id has no time: the log keeps the first event of each mode. */
export function modeEvent(source: SourceId, mode: SourceMode, reason: string, at: Instant): ModeEvent {
  return { ...envelope("mode", `mode:${source}:${mode}`, at), source, mode, reason };
}

/**
 * This function gives the mode events of the sources of the configuration at `at`.
 *
 * - At the first start with modes, the state has no mode. Each source of the configuration operated before this build, thus it
 *   goes live with the reason `seed`. A source of context only (`contextSource`) starts in the observe mode.
 * - After that, each source with no mode is new, and it starts in the observe mode.
 *
 * A copy with no source at its first start writes no mode. Thus its first sources get the seed later. The state keeps no
 * other mark of the seed.
 */
export function modeEvents(state: Pick<RuntimeState, "modes">, sources: readonly SourceDescriptor[], at: Instant): ModeEvent[] {
  const seed = Object.keys(state.modes).length === 0;
  return sources.flatMap((source) => {
    if (state.modes[source.id] !== undefined) return [];
    const mode: SourceMode = seed && !contextSource(source) ? "live" : "observe";
    return [modeEvent(source.id, mode, seed ? SEED_REASON : "new source", at)];
  });
}

/** This function gives the start of the observe mode of each source that observes: a source with a start and no live time. */
export function observingSources(state: Pick<RuntimeState, "modes">): Map<SourceId, Instant> {
  const observing = new Map<SourceId, Instant>();
  for (const [source, track] of Object.entries(state.modes)) {
    if (track.since !== undefined && track.live === undefined) observing.set(source as SourceId, track.since);
  }
  return observing;
}

/** The parts of a pass that the observe mode reads. */
export interface ObserveParts {
  readonly people: readonly PersonWatch[];
  readonly places: readonly WatchedPlace[];
  readonly assess?: AssessPolicy | undefined;
  /** The send limit of each person. The default is the default of the core. */
  readonly limits?: SendLimits | undefined;
  /** The share of the send limit for this copy at a time. Without it, the share is 1. */
  readonly share?: ((at: Instant) => number) | undefined;
}

/** The result of `observeStep`. */
export interface ObserveStep {
  /** The verdict of each source that observes, in the order of the sources. */
  readonly verdicts: readonly ObserveVerdict[];
  /** The event `live` of each verdict that passes. */
  readonly events: readonly ModeEvent[];
}

/** This function gives the verdict of each source that observes at `at`, and the event `live` of each verdict that passes. */
export function observeStep(state: Pick<RuntimeState, "modes" | "merge">, incidents: readonly Incident[], parts: ObserveParts, at: Instant): ObserveStep {
  const observing = [...observingSources(state)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const share = parts.share?.(at);
  const verdicts = observing.map(([source, since]) =>
    observeVerdict({
      source,
      since,
      at,
      state: state.merge,
      incidents,
      people: parts.people,
      places: parts.places,
      ...(parts.assess === undefined ? {} : { assess: parts.assess }),
      ...(parts.limits === undefined ? {} : { limits: parts.limits }),
      ...(share === undefined ? {} : { share }),
    }),
  );
  const events = verdicts.filter((verdict) => verdict.pass).map((verdict) => modeEvent(verdict.source, "live", verdict.reason, at));
  return { verdicts, events };
}

/**
 * This function gives the cut of the incidents of a delivery step (`observeCut` of the core). It takes the sources that
 * observe, and the escalation starts and the holds, from the state.
 */
export function cutIncidents(state: Pick<RuntimeState, "modes" | "starts" | "holds">, merge: MergeState, found: readonly Incident[], parts: ObserveParts, at: Instant): ObserveCut {
  const observing = new Set(observingSources(state).keys());
  if (observing.size === 0) return { sent: found, held: [], lifeSafety: [] };
  return observeCut({
    incidents: found,
    state: merge,
    observing,
    started: new Set<ReportId>([...state.starts, ...state.holds].map((entry) => entry.incident)),
    people: parts.people,
    places: parts.places,
    ...(parts.assess === undefined ? {} : { assess: parts.assess }),
    at,
  });
}

/** The mode of one source in `GET /status`. It has no person, no place and no incident. */
export interface ModeStatus {
  readonly source: SourceId;
  readonly mode: SourceMode;
  /** The start of the observe mode, when the source had one. */
  readonly since?: Instant;
  /** The time that the source went live. */
  readonly live?: Instant;
  /** The observed time in hours. Only a source that observes has it. */
  readonly hours?: number;
  /** The incidents of the source in each hour of the counted time of its verdict. */
  readonly perHour?: number;
  /** The highest share of the incidents of the source that reach one person, from 0 to 1. */
  readonly share?: number;
  /** The reason of the verdict. */
  readonly reason?: string;
}

/** This function gives the mode of each source with a mode, in the order of the sources, with the verdicts of a pass. */
export function modeStatus(state: Pick<RuntimeState, "modes">, verdicts: readonly ObserveVerdict[]): ModeStatus[] {
  const bySource = new Map(verdicts.map((verdict) => [verdict.source as string, verdict]));
  return Object.keys(state.modes)
    .sort()
    .map((source): ModeStatus => {
      const track = state.modes[source]!;
      const times = { ...(track.since === undefined ? {} : { since: track.since }), ...(track.live === undefined ? {} : { live: track.live }) };
      const verdict = bySource.get(source);
      if (track.live !== undefined || verdict === undefined) return { source: source as SourceId, mode: track.live === undefined ? "observe" : "live", ...times };
      const share = Math.max(0, ...verdict.people.map((person) => person.share));
      return { source: source as SourceId, mode: "observe", ...times, hours: verdict.hours, perHour: verdict.perHour, share, reason: verdict.reason };
    });
}
