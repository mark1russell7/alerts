import { describe, expect, it } from "vitest";
import { flapCounts, listRuns, type ListFetch } from "./snapshot-measure.ts";

const MINUTE = 60_000;
const at = (index: number): number => index * 2 * MINUTE;
const list = (index: number, ...keys: string[]): ListFetch => ({ at: at(index), keys });
const cut = (index: number): ListFetch => ({ at: at(index) });

describe("listRuns", () => {
  it("gives the absences of a key that came back and of a key that did not, as snapshotStep counts them", () => {
    const fetches = [list(0, "a", "b", "c"), list(1, "a", "c"), cut(2), list(3, "a"), list(4, "a", "b"), list(5, "a", "b")];
    expect(listRuns(fetches, 0)).toEqual({
      lists: 5,
      horizon: 0,
      observed: 4,
      // Each key of a complete list, at the next complete list: 3 + 2 + 1 + 2.
      trials: 8,
      absences: [
        { key: "b", last: at(0), left: at(1), lists: 2, back: at(4) },
        { key: "c", last: at(1), left: at(3), lists: 3 },
      ],
      censored: 0,
    });
  });

  it("counts nothing for a failed fetch or a part of a list", () => {
    const steady = [list(0, "a"), list(1, "a"), list(2, "a")];
    expect(listRuns([...steady, cut(3), cut(4)], 0)).toEqual(listRuns(steady, 0));
    expect(listRuns([...steady, cut(3), cut(4)], 1)).toEqual(listRuns(steady, 1));
  });

  it("gives the same runs in each order of the fetches", () => {
    const fetches = [list(0, "a", "b"), list(1, "b"), list(2), list(3, "a"), cut(4), list(5, "a", "b")];
    for (const horizon of [0, 1, 2]) expect(listRuns([...fetches].reverse(), horizon)).toEqual(listRuns(fetches, horizon));
  });

  it("gives no trial and no absence for one list or none", () => {
    expect(listRuns([], 0)).toEqual({ lists: 0, horizon: 0, observed: 0, trials: 0, absences: [], censored: 0 });
    expect(listRuns([list(0, "a")], 0)).toEqual({ lists: 1, horizon: 0, observed: 0, trials: 0, absences: [], censored: 0 });
  });

  it("gives two absences for a key that leaves two times", () => {
    const runs = listRuns([list(0, "a"), list(1), list(2, "a"), list(3), list(4), list(5, "a")], 0);
    expect(runs.absences.map(({ lists, back }) => [lists, back])).toEqual([
      [1, at(2)],
      [2, at(5)],
    ]);
  });

  it("does not count an absence or a trial in the horizon at the end of the measure", () => {
    const fetches = [list(0, "a", "b"), list(1, "a"), list(2, "a", "b"), list(3, "a"), list(4, "a")];
    // With no horizon, the last absence of b looks like a true end.
    expect(listRuns(fetches, 0).absences.filter((absence) => absence.back === undefined)).toHaveLength(1);
    // With a horizon of 2 lists, only the lists 1 and 2 are observed: 2 trials of list 0 and 1 trial of list 1.
    expect(listRuns(fetches, 2)).toEqual({
      lists: 5,
      horizon: 2,
      observed: 2,
      trials: 3,
      absences: [{ key: "b", last: at(0), left: at(1), lists: 1, back: at(2) }],
      censored: 1,
    });
  });

  it("gives a true end for an absence that is longer than the horizon", () => {
    const runs = listRuns([list(0, "a", "b"), list(1, "a"), list(2, "a"), list(3, "a")], 2);
    expect(runs.absences).toEqual([{ key: "b", last: at(0), left: at(1), lists: 3 }]);
    expect(runs.trials).toBe(2);
  });

  it("refuses a horizon that is not an integer of 0 or more", () => {
    expect(() => listRuns([], -1)).toThrow(RangeError);
    expect(() => listRuns([], 1.5)).toThrow(RangeError);
  });
});

describe("flapCounts", () => {
  it("counts a false end for each count of misses up to the length of a return, and none for a key that did not come back", () => {
    const runs = listRuns([list(0, "a", "b", "c"), list(1, "c"), list(2, "a"), list(3), list(4), list(5, "a", "b")], 0);
    // a: back after 1 list, then after 2 lists. b: back after 4 lists. c: did not come back.
    // a and b leave at list 1, so list 1 is one start of 2 false ends for 1 miss.
    expect(flapCounts(runs, 5)).toEqual([
      { misses: 1, flaps: 3, trials: runs.trials, starts: 2, lists: 5, largest: 2 },
      { misses: 2, flaps: 2, trials: runs.trials, starts: 2, lists: 5, largest: 1 },
      { misses: 3, flaps: 1, trials: runs.trials, starts: 1, lists: 5, largest: 1 },
      { misses: 4, flaps: 1, trials: runs.trials, starts: 1, lists: 5, largest: 1 },
      { misses: 5, flaps: 0, trials: runs.trials, starts: 0, lists: 5, largest: 0 },
    ]);
  });

  it("gives one start for a bad list that ends many keys at once", () => {
    const keys = Array.from({ length: 50 }, (_, index) => `k${String(index)}`);
    const runs = listRuns([list(0, ...keys), list(1), list(2, ...keys), list(3, ...keys)], 0);
    expect(flapCounts(runs, 1)).toEqual([{ misses: 1, flaps: 50, trials: 100, starts: 1, lists: 3, largest: 50 }]);
  });
});
