/**
 * This module holds the view of the system at one time: a pure function of the state, the
 * configuration and the time. It applies each fold of the core at the time that the runtime gives. It
 * reads no clock. The view tells the next time when a timer of a fold ends, and the runtime makes the
 * view again at that time.
 */
import {
  advanceHealth,
  carriages,
  coverage,
  incidents,
  lateLimits,
  lateness,
  lateSources,
  startHealth,
  systemReports,
  threats,
  type Coverage,
  type CoveragePolicy,
  type DelayLimitOptions,
  type Expectation,
  type Incident,
  type Instant,
  type Lateness,
  type SourceDescriptor,
  type SourceHealth,
  type SystemStep,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { envelope, type SystemEvent } from "./events.ts";
import type { FoldContext, RuntimeState } from "./state.ts";

/** The configuration of the views. The private configuration gives the places. */
export interface ViewConfig extends FoldContext {
  readonly places: readonly WatchedPlace[];
  /** The taxonomy codes or prefixes of the coverage at each place. */
  readonly kinds: readonly string[];
  /** The sources that carry the reports of other sources. */
  readonly expectations: readonly Expectation[];
  /** The quantile and the level of the two limits of each expectation: the delay and the count of misses. They come from the log. */
  readonly delay: DelayLimitOptions;
  readonly coverage?: CoveragePolicy;
}

/** The view of the system at one time. */
export interface SystemView {
  readonly at: Instant;
  readonly health: readonly SourceHealth[];
  readonly incidents: readonly Incident[];
  readonly lateness: readonly Lateness[];
  readonly coverage: readonly Coverage[];
  /** The step of the system reports. Its reports are new when the state of the system changed. */
  readonly step: SystemStep;
  /** The next time when a timer of the health, of the lateness or of an incident ends. */
  readonly wakeAt?: Instant;
}

/** This function gives the view of the system at the time `at`. */
export function systemView(state: RuntimeState, config: ViewConfig, at: Instant): SystemView {
  const steps = config.sources.map((source) => advanceHealth(state.health[source.id] ?? startHealth(source.id, state.start ?? at), at, source, config.health));
  const health = steps.map((step) => step.health);
  const found = incidents(state.merge, at);
  const checks = carriages(state.merge, found, config.expectations);
  const limits = lateLimits(checks, config.expectations, at, config.delay);
  const late = lateness(checks, config.expectations, limits, at);
  const covered = coverage({ sources: config.sources, health, late: lateSources(late), places: config.places, kinds: config.kinds }, config.coverage);
  const step = systemReports(state.lines, { sources: config.sources, health, coverage: covered, threats: threats(found, config.places), lateness: late }, at);
  // An incident that expires changes the threats, thus its end is a timer too.
  const ends = found.flatMap((incident) => (incident.live && incident.expires !== undefined && incident.expires > at ? [incident.expires] : []));
  const wakeAt = earliest([...steps.map((entry) => entry.wakeAt), ...late.map((entry) => entry.wakeAt), ...ends]);
  return { at, health, incidents: found, lateness: late, coverage: covered, step, ...(wakeAt === undefined ? {} : { wakeAt }) };
}

/** This function gives the event of the step of a view, or `undefined` when the step has no report. */
export function systemEvent(view: SystemView): SystemEvent | undefined {
  const { reports, observations } = view.step;
  const first = reports[0];
  if (first === undefined) return undefined;
  return { ...envelope("system", `system:${first.key}`, view.at), reports, observations };
}

/** This function gives the time of the next fetch of a source: one interval after the start of its last fetch. A source with no fetch is due at once. */
export function nextFetch(state: RuntimeState, source: SourceDescriptor): Instant {
  const last = state.fetched[source.id];
  return last === undefined ? Number.NEGATIVE_INFINITY : last + source.interval;
}

/** This function gives the earliest time of a list, or `undefined` for a list with no time. */
export function earliest(times: readonly (Instant | undefined)[]): Instant | undefined {
  let found: Instant | undefined;
  for (const time of times) if (time !== undefined && (found === undefined || time < found)) found = time;
  return found;
}
