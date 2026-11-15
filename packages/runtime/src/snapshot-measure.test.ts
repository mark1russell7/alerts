import { describe, expect, it } from "vitest";
import { flapCounts, listRuns, missesDecision, type FlapBound, type ListFetch } from "./snapshot-measure.ts";

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

describe("missesDecision", () => {
  // The bounds use exact binary fractions, so each product is exact. The bound of the false ends is highByList * lists * largest.
  const bound = (misses: number, highByList: number, largest = 0): FlapBound => ({ misses, highByList, lists: 64, largest });
  // At 1 miss: 0.5 * 64 * 4 = 128. At 2 misses: 0.125 * 64 * 2 = 16. At 3 and more: 0.03125 * 64 = 2.
  const BOUNDS = [bound(1, 0.5, 4), bound(2, 0.125, 2), bound(3, 0.03125), bound(4, 0.03125)];

  it("gives the smallest count of misses whose false ends are the share or less of the true ends", () => {
    expect(missesDecision(BOUNDS, 64, 0.0625)).toEqual({ decided: true, misses: 3, share: 2 / 64 });
    expect(missesDecision(BOUNDS, 256, 0.0625)).toEqual({ decided: true, misses: 2, share: 16 / 256 });
    expect(missesDecision(BOUNDS, 2048, 0.0625)).toEqual({ decided: true, misses: 1, share: 128 / 2048 });
  });

  it("gives the same decision for the bounds in any order", () => {
    expect(missesDecision([...BOUNDS].reverse(), 64, 0.0625)).toEqual(missesDecision(BOUNDS, 64, 0.0625));
  });

  it("counts a list with no false end as one false end, because a future list can have one", () => {
    expect(missesDecision([bound(1, 0.03125)], 32, 0.0625)).toEqual({ decided: true, misses: 1, share: 2 / 32 });
    expect(missesDecision([bound(1, 0.03125)], 31, 0.0625).decided).toBe(false);
  });

  it("gives no decision with too few true ends, and tells the count that a decision needs", () => {
    const decision = missesDecision(BOUNDS, 16, 0.0625);
    expect(decision.decided).toBe(false);
    expect(decision.decided ? "" : decision.reason).toBe("At 3 misses, the bound of the false ends is 2.0, more than 0.0625 of 16 true ends. A decision needs about 32 true ends with no new false end.");
  });

  it("gives no decision with no true end and with no bound", () => {
    expect(missesDecision(BOUNDS, 0, 0.0625)).toEqual({ decided: false, reason: "The measure has no true end. A decision needs about 32 true ends with no new false end." });
    expect(missesDecision([], 100, 0.0625)).toEqual({ decided: false, reason: "The measure has no count of misses." });
  });

  it("refuses a share outside 0 and 1, and a count of ends that is not a count", () => {
    for (const share of [0, 1, -0.5, Number.NaN]) expect(() => missesDecision(BOUNDS, 64, share)).toThrow(RangeError);
    for (const ends of [-1, 1.5, Number.NaN]) expect(() => missesDecision(BOUNDS, ends, 0.0625)).toThrow(RangeError);
  });
});
