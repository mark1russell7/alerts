/**
 * The drills of the live paths (AL-43). The fakes and the fault cases of CI test the code. Only a drill tests the live
 * path: the provider, the phone and the person. A drill is data: a path, the least time between two starts, a window of
 * the starts and the time of the acknowledgment. A drill with no acknowledgment in its time fails.
 *
 * The functions are pure. They read no clock. The runs of each copy come in as data, and two runs of one start join
 * into one run. Thus the order of the runs has no effect.
 */
import { inWindow, nextBoundary, windowProblems, type TimeWindow } from "@mark1russell7/algebra/clock";
import type { ChannelDescriptor, ChannelId, Duration, Instant, PersonId, QuietWindow } from "./contracts.ts";
import { inQuietWindow } from "./escalation.ts";

/**
 * The path of a drill: one channel of the escalation of the person. A drill goes as a system report of the level
 * `life-safety`, with the subject `DRILL_SUBJECT`. Thus it goes through the route and the escalation policy of a
 * life-safety warning. Only an acknowledgment of a delivery on this channel counts for the drill.
 */
export interface DrillPath {
  readonly kind: "channel";
  readonly channel: ChannelId;
}

/** One drill of the configuration. */
export interface DrillConfig {
  /** The id of the drill: 1 to 32 lowercase letters, digits and hyphens. */
  readonly id: string;
  /** The person who acknowledges the drill. */
  readonly person: PersonId;
  readonly path: DrillPath;
  /**
   * The least time from the start of one drill to the start of the next. For a drill on one day of each week, give
   * 6 days and a window on that day.
   */
  readonly every: Duration;
  /** The window of the starts. A drill starts only in this window, and not in the quiet window of the person. */
  readonly window: TimeWindow;
  /** The time from the start to the acknowledgment. With no acknowledgment in this time, the drill fails. */
  readonly ackWithin: Duration;
  /**
   * The ids of the copies that start the drill. Each of them starts its own runs. Without the list, only the copy of
   * rank 0 starts the drill. Thus two copies do not send one drill at once.
   */
  readonly copies?: readonly string[];
}

/** One run of a drill: its start, and the first acknowledgment of a delivery on the channel of the path. */
export interface DrillRun {
  /** The id of the drill. */
  readonly drill: string;
  /** The start of the run. */
  readonly at: Instant;
  /** The time of the acknowledgment. */
  readonly acked?: Instant;
}

/**
 * The verdict of a run at a time.
 *
 * - `pending`: the run has no acknowledgment, and its time continues until `until`.
 * - `passed`: the acknowledgment came in its time, `after` the start.
 * - `failed`: no acknowledgment came in the time (`no-ack`), or it came late (`late-ack`).
 */
export type DrillVerdict =
  | { readonly state: "pending"; readonly until: Instant }
  | { readonly state: "passed"; readonly after: Duration }
  | { readonly state: "failed"; readonly why: "no-ack" | "late-ack" };

// The most changes of the windows that the search of the next start reads. Each change is one boundary of the window of
// the drill or of the quiet window. Thus a drill with a window in the quiet window gives no start, and the search stops.
const SEARCH_LIMIT = 64;

/**
 * This function joins two runs of one start into one run: the earlier acknowledgment counts. The join is idempotent,
 * commutative and associative.
 */
export function joinRuns(a: DrillRun, b: DrillRun): DrillRun {
  const acked = a.acked === undefined ? b.acked : b.acked === undefined ? a.acked : Math.min(a.acked, b.acked);
  return acked === undefined ? { drill: a.drill, at: a.at } : { drill: a.drill, at: a.at, acked };
}

/** This function gives the last run of the drill `id`: the run with the latest start, joined with each run of that start. */
export function lastRun(runs: readonly DrillRun[], id: string): DrillRun | undefined {
  let last: DrillRun | undefined;
  for (const run of runs) {
    if (run.drill !== id || !Number.isFinite(run.at)) continue;
    if (last === undefined || run.at > last.at) last = run;
    else if (run.at === last.at) last = joinRuns(last, run);
  }
  return last;
}

/** This function gives the verdict of the run of a drill at the time `at`. */
export function drillVerdict(drill: DrillConfig, run: DrillRun, at: Instant): DrillVerdict {
  const until = run.at + drill.ackWithin;
  if (run.acked !== undefined) return run.acked <= until ? { state: "passed", after: Math.max(0, run.acked - run.at) } : { state: "failed", why: "late-ack" };
  return at < until ? { state: "pending", until } : { state: "failed", why: "no-ack" };
}

/**
 * This function gives the next start of a drill at the time `at` or later. A timer can wait for it. The start is in the
 * window of the drill, and it is `every` or more after the last start. The time of the acknowledgment from the start
 * ends before the next quiet window of the person. Thus a drill does not wake the person in the quiet window.
 *
 * The function gives `undefined` for a bad window and for a bad quiet window. It also gives `undefined` with no start in
 * the next 64 changes of the two windows. Thus a drill with a window in the quiet window has no start.
 */
export function nextDrillAt(drill: DrillConfig, runs: readonly DrillRun[], at: Instant, quiet?: QuietWindow): Instant | undefined {
  const last = lastRun(runs, drill.id);
  let time = last === undefined ? at : Math.max(at, last.at + drill.every);
  for (let step = 0; step < SEARCH_LIMIT; step += 1) {
    const window = !inWindow(time, drill.window) ? drill.window : quiet !== undefined && inQuietWindow(quiet, time) ? quiet : undefined;
    if (window === undefined) {
      if (!Number.isFinite(time)) return undefined;
      // The next quiet window opens in the time of the acknowledgment: the search goes on from that opening.
      const opening = quiet === undefined ? undefined : nextBoundary(time, quiet);
      if (opening === undefined || opening.at >= time + drill.ackWithin) return time;
      time = opening.at;
      continue;
    }
    const boundary = nextBoundary(time, window);
    if (boundary === undefined) return undefined;
    time = boundary.at;
  }
  return undefined;
}

/** This function tells if the copy `copy` of the rank `rank` starts the drill. */
export function drillInCopy(drill: DrillConfig, copy: string, rank: number): boolean {
  return drill.copies === undefined ? rank === 0 : drill.copies.includes(copy);
}

/** This function tells if a drill starts at the time `at`: the next start of the drill is `at`. */
export function drillDue(drill: DrillConfig, runs: readonly DrillRun[], at: Instant, quiet?: QuietWindow): boolean {
  return nextDrillAt(drill, runs, at, quiet) === at;
}

// The start of the search for a start of each drill in `drillProblems`: Monday 5 January 2026, 00:00 UTC. The windows
// repeat each week in local time. Thus each start of the search gives the same answer, except at a change of an offset.
const PROBE_FROM: Instant = Date.UTC(2026, 0, 5);

/**
 * This function gives the problems of one drill that a schema cannot find. `loadConfig` also checks the person, the
 * subject that the person watches, the policy of the person and the contact on the channel.
 *
 * - The time of the acknowledgment is above 0, and the least time between two starts is above it.
 * - The window has a good time zone and good local times.
 * - The drill has a start out of the quiet window of the person, with the time of the acknowledgment before it.
 * - The instance has the channel of the path, and the channel tells of an acknowledgment.
 */
export function drillProblems(drill: DrillConfig, channels: readonly ChannelDescriptor[], quiet?: QuietWindow): string[] {
  const problems: string[] = [];
  const name = `The drill ${drill.id}`;
  if (!Number.isFinite(drill.ackWithin) || drill.ackWithin <= 0) problems.push(`${name} has the time of the acknowledgment ${String(drill.ackWithin)}. It is a finite number above 0.`);
  // A new start in the time of the last run makes two runs that wait together. The second hides the verdict of the first.
  if (!Number.isFinite(drill.every) || !(drill.every > drill.ackWithin)) problems.push(`${name} has the least time between two starts ${String(drill.every)}. It is above the time of the acknowledgment.`);
  const windowed = windowProblems(drill.window);
  for (const problem of windowed) problems.push(`${name}: the window: ${problem}`);
  const timed = Number.isFinite(drill.ackWithin) && drill.ackWithin > 0;
  if (windowed.length === 0 && timed && nextDrillAt(drill, [], PROBE_FROM, quiet) === undefined) {
    problems.push(`${name} has no start: each time of its window is in the quiet window of the person, or too near to it.`);
  }
  const channel = channels.find((known) => known.id === drill.path.channel);
  if (channel === undefined) problems.push(`${name} uses the channel ${drill.path.channel}, and the instance has no such channel.`);
  else if (channel.ack === "none") problems.push(`${name} uses the channel ${drill.path.channel}, and the channel does not tell of an acknowledgment. The drill cannot pass.`);
  return problems;
}
