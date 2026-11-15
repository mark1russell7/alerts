/**
 * This module measures the lists of a snapshot source. A measure is a series of fetches of the source,
 * with the keys of each complete list. A flap is a key that leaves the list and comes back. The rate of
 * the flaps gives the count of misses that ends a report (`SNAPSHOT_MISSES`).
 *
 * The module counts like `snapshotStep`. A failed fetch or a part of a list counts nothing, so an
 * absence continues over it.
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
  /** The count of trials: each key of a complete list, at the next complete list. */
  readonly trials: number;
  /** The absences in the order of their start, then of their key. */
  readonly absences: readonly Absence[];
}

/** This function gives the runs of absences of a measure. The fetches can come in any order. */
export function listRuns(fetches: readonly ListFetch[]): ListRuns {
  const complete = fetches.filter((fetch) => fetch.keys !== undefined).sort((a, b) => a.at - b.at);
  const absences: Absence[] = [];
  const open = new Map<string, { last: Instant; left: Instant; lists: number }>();
  let previous: { readonly at: Instant; readonly keys: ReadonlySet<string> } | undefined;
  let trials = 0;
  for (const fetch of complete) {
    const keys = new Set(fetch.keys);
    for (const [key, absence] of [...open]) {
      if (keys.has(key)) {
        absences.push({ key, ...absence, back: fetch.at });
        open.delete(key);
      } else open.set(key, { ...absence, lists: absence.lists + 1 });
    }
    if (previous !== undefined) {
      trials += previous.keys.size;
      for (const key of [...previous.keys].sort()) if (!keys.has(key)) open.set(key, { last: previous.at, left: fetch.at, lists: 1 });
    }
    previous = { at: fetch.at, keys };
  }
  for (const [key, absence] of open) absences.push({ key, ...absence });
  absences.sort((a, b) => a.left - b.left || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { lists: complete.length, trials, absences };
}

/** The flaps of a measure for one count of misses. */
export interface FlapCount {
  /** The count of misses that ends a report. */
  readonly misses: number;
  /** The count of absences of this length or longer that came back: each one is a false end. */
  readonly flaps: number;
  /** The count of trials of the measure. */
  readonly trials: number;
}

/**
 * This function gives the false ends of a measure for each count of misses from 1 to `most`. A key that
 * came back after `n` lists with no key gives a false end for each count of `n` or less.
 */
export function flapCounts(runs: ListRuns, most: number): FlapCount[] {
  const counts: FlapCount[] = [];
  for (let misses = 1; misses <= most; misses += 1) {
    const flaps = runs.absences.filter((absence) => absence.back !== undefined && absence.lists >= misses).length;
    counts.push({ misses, flaps, trials: runs.trials });
  }
  return counts;
}
