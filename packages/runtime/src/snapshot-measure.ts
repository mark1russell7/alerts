/**
 * This module measures the lists of a snapshot source. A measure is a series of fetches of the source,
 * with the keys of each complete list. A flap is a false end: a key that ends and comes back. The rate of
 * the flaps gives the count of misses that ends a report (`SNAPSHOT_MISSES`).
 *
 * The module counts like `snapshotStep`, for each count of misses:
 *
 * - A failed fetch or a part of a list counts nothing, so a run of misses continues over it.
 * - A key that is newer than a list counts no miss in the list, and keeps its count. The time of the data of
 *   the list (`asOf`) and the sent time of the key tell this.
 * - A key in a list before its end starts its count again, also in an old list.
 * - An ended key comes back only in a list that is newer than the list that ended it.
 * - A list or a key with no time counts as current. Thus the records of a measure with no times count as before.
 *
 * A measure ends at a time, and a key that ended at that time can come back later. So an end and its trials
 * count only when a horizon of complete lists follows the start of its misses. Without the horizon, the count of
 * flaps is low, and a low count is on the unsafe side.
 *
 * The function `missesDecision` gives the count of misses from the bounds of the measure.
 */
import type { Instant } from "@mark1russell7/alerts";

/** One fetch of a measure. */
export interface ListFetch {
  /** The end of the fetch. */
  readonly at: Instant;
  /** The keys of a complete list. Absent: the fetch failed or gave a part of the list. */
  readonly keys?: readonly string[];
  /** The time of the data of a complete list (`asOf` of the fetch). Absent: the list counts as current. */
  readonly asOf?: Instant;
  /** The sent time of each key of the list. A key with no time counts a miss in each complete list with no key. */
  readonly sents?: Readonly<Record<string, Instant>>;
}

/** One end of a key at one count of misses, as `snapshotStep` gives it. */
export interface End {
  readonly key: string;
  /** The time of the last complete list with the key before its misses. */
  readonly last: Instant;
  /** The time of the first list that counts a miss of the key: the start of the end. */
  readonly left: Instant;
  /** The time of the list of the last miss: the list that ends the key. */
  readonly ended: Instant;
  /** The time of the list that brings the key back. Absent: the key did not come back in the measure. */
  readonly back?: Instant;
}

/** The ends of a measure at one count of misses. */
export interface LimitRuns {
  /** The count of misses that ends a key. */
  readonly misses: number;
  /** The ends whose misses start at an observed list, in the order of their start, then of their key. */
  readonly ends: readonly End[];
  /** The count of runs of misses that start in the horizon at the end of the measure. They do not count. */
  readonly censored: number;
}

/** The runs of misses of a measure. */
export interface ListRuns {
  /** The count of complete lists. */
  readonly lists: number;
  /** The count of complete lists that follow the start of a run of misses before it counts. */
  readonly horizon: number;
  /** The count of observed lists: each complete list after the first, with the horizon after it. */
  readonly observed: number;
  /** The count of trials: each key of a complete list, at the next complete list if it is observed. */
  readonly trials: number;
  /** The count of complete lists with a time before the time of an earlier list: the old copies. */
  readonly old: number;
  /** The count of trials of a key that is not in the list and counts no miss, because the key is newer than the list. */
  readonly held: number;
  /** The ends at each count of misses, from 1 to the largest count. */
  readonly limits: readonly LimitRuns[];
}

/**
 * This function gives the runs of misses of a measure, for each count of misses from 1 to `most`. The fetches can
 * come in any order. A list is observed when `horizon` complete lists follow it. Only the trials of an observed list
 * and the ends whose misses start at an observed list count. A horizon of 0 observes each list.
 */
export function listRuns(fetches: readonly ListFetch[], horizon: number, most: number): ListRuns {
  if (!Number.isInteger(horizon) || horizon < 0) throw new RangeError(`The horizon is ${String(horizon)}, not an integer of 0 or more.`);
  if (!Number.isInteger(most) || most < 1) throw new RangeError(`The largest count of misses is ${String(most)}, not an integer of 1 or more.`);
  const complete = fetches.filter((fetch) => fetch.keys !== undefined).sort((a, b) => a.at - b.at);
  const observed = (index: number): boolean => index + horizon <= complete.length - 1;
  const sents = new Map<string, Instant>();
  let previous: ReadonlySet<string> | undefined;
  let lists = 0;
  let trials = 0;
  let old = 0;
  let held = 0;
  let newest: Instant | undefined;
  for (const [index, fetch] of complete.entries()) {
    const keys = new Set(fetch.keys);
    if (fetch.asOf !== undefined) {
      if (newest !== undefined && fetch.asOf < newest) old += 1;
      else newest = fetch.asOf;
    }
    if (previous !== undefined && observed(index)) {
      lists += 1;
      trials += previous.size;
      for (const key of previous) if (!keys.has(key) && newerThan(sents.get(key), fetch.asOf)) held += 1;
    }
    keepSents(sents, fetch);
    previous = keys;
  }
  const limits = Array.from({ length: most }, (_, index) => limitRuns(complete, index + 1, observed));
  return { lists: complete.length, horizon, observed: lists, trials, old, held, limits };
}

/** An end in the results, with its return to come. */
type OpenEnd = { -readonly [Field in keyof End]: End[Field] };

/** The state of one key at one count of misses. */
interface KeyState {
  readonly last: Instant;
  count: number;
  /** The first miss of the run: its time and the index of its list. */
  start?: { readonly at: Instant; readonly index: number };
  /** The end of the key: the time of the list that ended it, and the end in the results if it counts. */
  end?: { readonly asOf: Instant | undefined; readonly counted?: OpenEnd };
}

/** This function gives the ends of the complete lists of a measure at one count of misses, with the rules of `snapshotStep`. */
function limitRuns(complete: readonly ListFetch[], misses: number, observed: (index: number) => boolean): LimitRuns {
  const states = new Map<string, KeyState>();
  const sents = new Map<string, Instant>();
  const ends: OpenEnd[] = [];
  let censored = 0;
  for (const [index, fetch] of complete.entries()) {
    const keys = new Set(fetch.keys);
    for (const key of keys) {
      const end = states.get(key)?.end;
      if (end !== undefined) {
        if (!newerList(fetch.asOf, end.asOf)) continue;
        if (end.counted !== undefined) end.counted.back = fetch.at;
      }
      states.set(key, { last: fetch.at, count: 0 });
    }
    for (const [key, state] of states) {
      if (keys.has(key) || state.end !== undefined || newerThan(sents.get(key), fetch.asOf)) continue;
      state.count += 1;
      if (state.start === undefined) {
        state.start = { at: fetch.at, index };
        if (!observed(index)) censored += 1;
      }
      if (state.count < misses) continue;
      const counted: OpenEnd | undefined = observed(state.start.index) ? { key, last: state.last, left: state.start.at, ended: fetch.at } : undefined;
      if (counted !== undefined) ends.push(counted);
      state.end = { asOf: fetch.asOf, ...(counted === undefined ? {} : { counted }) };
    }
    keepSents(sents, fetch);
  }
  ends.sort((a, b) => a.left - b.left || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { misses, ends, censored };
}

/** This function keeps the newest sent time of each key of a list. */
function keepSents(sents: Map<string, Instant>, fetch: ListFetch): void {
  for (const [key, sent] of Object.entries(fetch.sents ?? {})) {
    const known = sents.get(key);
    if (known === undefined || sent > known) sents.set(key, sent);
  }
}

/** This function tells if a key is newer than a list. A key or a list with no time is not newer. */
function newerThan(sent: Instant | undefined, asOf: Instant | undefined): boolean {
  return sent !== undefined && asOf !== undefined && sent > asOf;
}

/** This function tells if a list is newer than the list that ended a key. A list or an end with no time counts as newer. */
function newerList(list: Instant | undefined, end: Instant | undefined): boolean {
  return list === undefined || end === undefined || list > end;
}

/** The flaps of a measure for one count of misses. */
export interface FlapCount {
  /** The count of misses that ends a report. */
  readonly misses: number;
  /** The count of ends that came back: each one is a false end. */
  readonly flaps: number;
  /** The count of ends that did not come back in the measure: the true ends. */
  readonly ends: number;
  /** The count of trials of the measure. */
  readonly trials: number;
  /** The count of observed lists where one or more of these false ends start. One bad list can end many keys. */
  readonly starts: number;
  /** The count of observed lists of the measure. */
  readonly lists: number;
  /** The largest count of these false ends that start at one list. */
  readonly largest: number;
  /** The count of runs of misses that start in the horizon at the end of the measure. They do not count. */
  readonly censored: number;
}

/** This function gives the false ends and the true ends of a measure for each count of misses of its runs. */
export function flapCounts(runs: ListRuns): FlapCount[] {
  return runs.limits.map((limit) => {
    const byStart = new Map<Instant, number>();
    for (const end of limit.ends) if (end.back !== undefined) byStart.set(end.left, (byStart.get(end.left) ?? 0) + 1);
    const flaps = [...byStart.values()].reduce((sum, count) => sum + count, 0);
    return {
      misses: limit.misses,
      flaps,
      ends: limit.ends.length - flaps,
      trials: runs.trials,
      starts: byStart.size,
      lists: runs.observed,
      largest: Math.max(0, ...byStart.values()),
      censored: limit.censored,
    };
  });
}

/** The false ends at one count of misses, summed over the windows of a measure. */
export interface FlapBound {
  /** The count of misses that ends a report. */
  readonly misses: number;
  /** The upper bound of the rate of the observed lists where false ends start. */
  readonly highByList: number;
  /** The count of observed lists. */
  readonly lists: number;
  /** The largest count of false ends that start at one list. */
  readonly largest: number;
}

/** The decision of the count of misses. */
export type MissesDecision =
  | {
      readonly decided: true;
      readonly misses: number;
      /** The upper bound of the false ends, as a share of the true ends. */
      readonly share: number;
    }
  | {
      readonly decided: false;
      /** The cause, and the count of true ends that a decision needs. */
      readonly reason: string;
    };

/**
 * This function gives the smallest count of misses whose false ends are `share` or less of the true ends. The true ends
 * are the absences of observed lists that did not come back.
 *
 * - The bound of the false ends is the bound of the lists with a start, times the lists, times the largest start.
 * - The bound reads the lists, not the keys, because one bad list can end many keys.
 * - With no true end, or with no count of misses under the share, the function gives no decision.
 */
export function missesDecision(bounds: readonly FlapBound[], ends: number, share: number): MissesDecision {
  if (!(share > 0 && share < 1)) throw new RangeError(`The share is ${String(share)}, not a number above 0 and below 1.`);
  if (!Number.isInteger(ends) || ends < 0) throw new RangeError(`The count of true ends is ${String(ends)}, not an integer of 0 or more.`);
  if (bounds.length === 0) return { decided: false, reason: "The measure has no count of misses." };
  const falseEnds = (bound: FlapBound): number => bound.highByList * bound.lists * Math.max(1, bound.largest);
  const ordered = [...bounds].sort((a, b) => a.misses - b.misses);
  const best = ordered.reduce((low, bound) => (falseEnds(bound) < falseEnds(low) ? bound : low));
  const needed = Math.ceil(falseEnds(best) / share);
  if (ends === 0) return { decided: false, reason: `The measure has no true end. A decision needs about ${String(needed)} true ends with no new false end.` };
  const found = ordered.find((bound) => falseEnds(bound) / ends <= share);
  if (found !== undefined) return { decided: true, misses: found.misses, share: falseEnds(found) / ends };
  return {
    decided: false,
    reason: `At ${String(best.misses)} misses, the bound of the false ends is ${falseEnds(best).toFixed(1)}, more than ${String(share)} of ${String(ends)} true ends. A decision needs about ${String(needed)} true ends with no new false end.`,
  };
}
