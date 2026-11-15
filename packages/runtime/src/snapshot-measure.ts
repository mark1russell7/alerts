/**
 * This module measures the lists of a snapshot source. A measure is a series of fetches of the source,
 * with the keys of each complete list. A flap is a key that leaves the list and comes back. The rate of
 * the flaps gives the count of misses that ends a report (`SNAPSHOT_MISSES`).
 *
 * The module counts like `snapshotStep`. A failed fetch or a part of a list counts nothing, so an
 * absence continues over it.
 *
 * A measure ends at a time, and an absence that is open at that time can come back later. So an absence
 * and its trials count only when a horizon of complete lists follows the start of the absence. Without
 * the horizon, the count of flaps is low, and a low count is on the unsafe side.
 */
import type { Instant } from "@mark1russell7/alerts";

/** One fetch of a measure. */
export interface ListFetch {
  /** The end of the fetch. */
  readonly at: Instant;
  /** The keys of a complete list. Absent: the fetch failed or gave a part of the list. */
  readonly keys?: readonly string[];
}

/** One absence of a key from the complete lists of a measure. */
export interface Absence {
  readonly key: string;
  /** The time of the last complete list with the key. */
  readonly last: Instant;
  /** The time of the first complete list with no key. */
  readonly left: Instant;
  /** The count of complete lists in a row with no key. */
  readonly lists: number;
  /** The time of the complete list with the key again. Absent: the key did not come back in the measure. */
  readonly back?: Instant;
}

/** The runs of absences of a measure. */
export interface ListRuns {
  /** The count of complete lists. */
  readonly lists: number;
  /** The count of complete lists that follow the start of an absence before it counts. */
  readonly horizon: number;
  /** The count of observed lists: each complete list after the first, with the horizon after it. */
  readonly observed: number;
  /** The count of trials: each key of a complete list, at the next complete list if it is observed. */
  readonly trials: number;
  /** The absences that start at an observed list, in the order of their start, then of their key. */
  readonly absences: readonly Absence[];
  /** The count of absences that start in the horizon at the end of the measure. They do not count. */
  readonly censored: number;
}

/**
 * This function gives the runs of absences of a measure. The fetches can come in any order. A list is
 * observed when `horizon` complete lists follow it. Only the trials and the absences of an observed list
 * count. An absence of an observed list that did not come back is a true end: its key was absent for
 * more than `horizon` lists. A horizon of 0 observes each list.
 */
export function listRuns(fetches: readonly ListFetch[], horizon: number): ListRuns {
  if (!Number.isInteger(horizon) || horizon < 0) throw new RangeError(`The horizon is ${String(horizon)}, not an integer of 0 or more.`);
  const complete = fetches.filter((fetch) => fetch.keys !== undefined).sort((a, b) => a.at - b.at);
  const absences: Absence[] = [];
  const open = new Map<string, { last: Instant; left: Instant; lists: number }>();
  let previous: { readonly at: Instant; readonly keys: ReadonlySet<string> } | undefined;
  let trials = 0;
  let observed = 0;
  let censored = 0;
  for (const [index, fetch] of complete.entries()) {
    const keys = new Set(fetch.keys);
    const counts = index + horizon <= complete.length - 1;
    for (const [key, absence] of [...open]) {
      if (keys.has(key)) {
        absences.push({ key, ...absence, back: fetch.at });
        open.delete(key);
      } else open.set(key, { ...absence, lists: absence.lists + 1 });
    }
    if (previous !== undefined) {
      const left = [...previous.keys].filter((key) => !keys.has(key)).sort();
      if (counts) {
        observed += 1;
        trials += previous.keys.size;
        for (const key of left) open.set(key, { last: previous.at, left: fetch.at, lists: 1 });
      } else censored += left.length;
    }
    previous = { at: fetch.at, keys };
  }
  for (const [key, absence] of open) absences.push({ key, ...absence });
  absences.sort((a, b) => a.left - b.left || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { lists: complete.length, horizon, observed, trials, absences, censored };
}

/** The flaps of a measure for one count of misses. */
export interface FlapCount {
  /** The count of misses that ends a report. */
  readonly misses: number;
  /** The count of absences of this length or longer that came back: each one is a false end. */
  readonly flaps: number;
  /** The count of trials of the measure. */
  readonly trials: number;
  /** The count of observed lists where one or more of these false ends start. One bad list can end many keys. */
  readonly starts: number;
  /** The count of observed lists of the measure. */
  readonly lists: number;
  /** The largest count of these false ends that start at one list. */
  readonly largest: number;
}

/**
 * This function gives the false ends of a measure for each count of misses from 1 to `most`. A key that
 * came back after `n` lists with no key gives a false end for each count of `n` or less.
 */
export function flapCounts(runs: ListRuns, most: number): FlapCount[] {
  const counts: FlapCount[] = [];
  for (let misses = 1; misses <= most; misses += 1) {
    const byStart = new Map<Instant, number>();
    for (const absence of runs.absences) if (absence.back !== undefined && absence.lists >= misses) byStart.set(absence.left, (byStart.get(absence.left) ?? 0) + 1);
    const flaps = [...byStart.values()].reduce((sum, count) => sum + count, 0);
    counts.push({ misses, flaps, trials: runs.trials, starts: byStart.size, lists: runs.observed, largest: Math.max(0, ...byStart.values()) });
  }
  return counts;
}
