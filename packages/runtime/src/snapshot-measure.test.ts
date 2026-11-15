import { describe, expect, it } from "vitest";
import { flapCounts, listRuns, type ListFetch } from "./snapshot-measure.ts";

const MINUTE = 60_000;
const at = (index: number): number => index * 2 * MINUTE;
const list = (index: number, ...keys: string[]): ListFetch => ({ at: at(index), keys });
const cut = (index: number): ListFetch => ({ at: at(index) });

describe("listRuns", () => {
  it("gives the absences of a key that came back and of a key that did not, as snapshotStep counts them", () => {
    const fetches = [list(0, "a", "b", "c"), list(1, "a", "c"), cut(2), list(3, "a"), list(4, "a", "b"), list(5, "a", "b")];
    expect(listRuns(fetches)).toEqual({
      lists: 5,
      // Each key of a complete list, at the next complete list: 3 + 2 + 1 + 2.
      trials: 8,
      absences: [
        { key: "b", last: at(0), left: at(1), lists: 2, back: at(4) },
        { key: "c", last: at(1), left: at(3), lists: 3 },
      ],
    });
  });

  it("counts nothing for a failed fetch or a part of a list", () => {
    const steady = [list(0, "a"), list(1, "a"), list(2, "a")];
    expect(listRuns([...steady, cut(3), cut(4)])).toEqual(listRuns(steady));
  });

  it("gives the same runs in each order of the fetches", () => {
    const fetches = [list(0, "a", "b"), list(1, "b"), list(2), list(3, "a"), cut(4), list(5, "a", "b")];
    expect(listRuns([...fetches].reverse())).toEqual(listRuns(fetches));
  });

  it("gives no trial and no absence for one list or none", () => {
    expect(listRuns([])).toEqual({ lists: 0, trials: 0, absences: [] });
    expect(listRuns([list(0, "a")])).toEqual({ lists: 1, trials: 0, absences: [] });
  });

  it("gives two absences for a key that leaves two times", () => {
    const runs = listRuns([list(0, "a"), list(1), list(2, "a"), list(3), list(4), list(5, "a")]);
    expect(runs.absences.map(({ lists, back }) => [lists, back])).toEqual([
      [1, at(2)],
      [2, at(5)],
    ]);
  });
});

describe("flapCounts", () => {
  it("counts a false end for each count of misses up to the length of a return, and none for a key that did not come back", () => {
    const runs = listRuns([list(0, "a", "b", "c"), list(1, "c"), list(2, "a"), list(3), list(4), list(5, "a", "b")]);
    // a: back after 1 list, then after 2 lists. b: back after 4 lists. c: did not come back.
    expect(flapCounts(runs, 5)).toEqual([
      { misses: 1, flaps: 3, trials: runs.trials },
      { misses: 2, flaps: 2, trials: runs.trials },
      { misses: 3, flaps: 1, trials: runs.trials },
      { misses: 4, flaps: 1, trials: runs.trials },
      { misses: 5, flaps: 0, trials: runs.trials },
    ]);
  });
});
