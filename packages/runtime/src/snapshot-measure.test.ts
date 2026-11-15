import { normalize, reportId, type EndMark, type FetchOutcome, type Observation, type ObservationId, type Report, type ReportId, type SourceId } from "@mark1russell7/alerts";
import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { snapshotStep } from "./snapshot.ts";
import { flapCounts, listRuns, missesDecision, type FlapBound, type ListFetch, type ListRuns } from "./snapshot-measure.ts";

const MINUTE = 60_000;
const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const at = (index: number): number => index * 2 * MINUTE;
const list = (index: number, ...keys: string[]): ListFetch => ({ at: at(index), keys });
const cut = (index: number): ListFetch => ({ at: at(index) });
/** A complete list with the time of its data and the sent time of each of its keys. */
const timed = (index: number, asOf: number, sents: Readonly<Record<string, number>>): ListFetch => ({ at: at(index), keys: Object.keys(sents), asOf, sents });
const endsAt = (runs: ListRuns, misses: number) => runs.limits[misses - 1]!.ends;

describe("listRuns", () => {
  it("gives the ends of a key that came back and of a key that did not at each count of misses, as snapshotStep counts them", () => {
    const fetches = [list(0, "a", "b", "c"), list(1, "a", "c"), cut(2), list(3, "a"), list(4, "a", "b"), list(5, "a", "b")];
    expect(listRuns(fetches, 0, 3)).toEqual({
      lists: 5,
      horizon: 0,
      observed: 4,
      // Each key of a complete list, at the next complete list: 3 + 2 + 1 + 2.
      trials: 8,
      old: 0,
      held: 0,
      limits: [
        {
          misses: 1,
          ends: [
            { key: "b", last: at(0), left: at(1), ended: at(1), back: at(4) },
            { key: "c", last: at(1), left: at(3), ended: at(3) },
          ],
          censored: 0,
        },
        {
          misses: 2,
          ends: [
            { key: "b", last: at(0), left: at(1), ended: at(3), back: at(4) },
            { key: "c", last: at(1), left: at(3), ended: at(4) },
          ],
          censored: 0,
        },
        // b comes back after 2 misses, so it does not end at 3 misses.
        { misses: 3, ends: [{ key: "c", last: at(1), left: at(3), ended: at(5) }], censored: 0 },
      ],
    });
  });

  it("counts nothing for a failed fetch or a part of a list", () => {
    const steady = [list(0, "a"), list(1, "a"), list(2, "a")];
    expect(listRuns([...steady, cut(3), cut(4)], 0, 2)).toEqual(listRuns(steady, 0, 2));
    expect(listRuns([...steady, cut(3), cut(4)], 1, 2)).toEqual(listRuns(steady, 1, 2));
  });

  it("gives the same runs in each order of the fetches", () => {
    const fetches = [list(0, "a", "b"), list(1, "b"), list(2), list(3, "a"), cut(4), list(5, "a", "b")];
    for (const horizon of [0, 1, 2]) expect(listRuns([...fetches].reverse(), horizon, 3)).toEqual(listRuns(fetches, horizon, 3));
  });

  it("gives no trial and no end for one list or none", () => {
    const none = { misses: 1, ends: [], censored: 0 };
    expect(listRuns([], 0, 1)).toEqual({ lists: 0, horizon: 0, observed: 0, trials: 0, old: 0, held: 0, limits: [none] });
    expect(listRuns([list(0, "a")], 0, 1)).toEqual({ lists: 1, horizon: 0, observed: 0, trials: 0, old: 0, held: 0, limits: [none] });
  });

  it("gives two ends for a key that leaves two times, and starts the count again when the key comes back before its end", () => {
    const runs = listRuns([list(0, "a"), list(1), list(2, "a"), list(3), list(4), list(5, "a")], 0, 2);
    expect(endsAt(runs, 1).map(({ left, back }) => [left, back])).toEqual([
      [at(1), at(2)],
      [at(3), at(5)],
    ]);
    expect(endsAt(runs, 2).map(({ left, ended, back }) => [left, ended, back])).toEqual([[at(3), at(4), at(5)]]);
  });

  it("does not count an end or a trial in the horizon at the end of the measure", () => {
    const fetches = [list(0, "a", "b"), list(1, "a"), list(2, "a", "b"), list(3, "a"), list(4, "a")];
    // With no horizon, the last end of b looks like a true end.
    expect(flapCounts(listRuns(fetches, 0, 1))[0]!.ends).toBe(1);
    // With a horizon of 2 lists, only the lists 1 and 2 are observed: 2 trials of list 0 and 1 trial of list 1.
    expect(listRuns(fetches, 2, 1)).toEqual({
      lists: 5,
      horizon: 2,
      observed: 2,
      trials: 3,
      old: 0,
      held: 0,
      limits: [{ misses: 1, ends: [{ key: "b", last: at(0), left: at(1), ended: at(1), back: at(2) }], censored: 1 }],
    });
  });

  it("gives a true end for a run of misses that is longer than the horizon", () => {
    const runs = listRuns([list(0, "a", "b"), list(1, "a"), list(2, "a"), list(3, "a")], 2, 1);
    expect(endsAt(runs, 1)).toEqual([{ key: "b", last: at(0), left: at(1), ended: at(1) }]);
    expect(runs.trials).toBe(2);
  });

  it("refuses a horizon or a largest count of misses that is not an integer in its range", () => {
    expect(() => listRuns([], -1, 1)).toThrow(RangeError);
    expect(() => listRuns([], 1.5, 1)).toThrow(RangeError);
    expect(() => listRuns([], 0, 0)).toThrow(RangeError);
    expect(() => listRuns([], 0, 1.5)).toThrow(RangeError);
  });
});

describe("listRuns with the times of the lists", () => {
  it("counts no miss for a key that is newer than an old list", () => {
    // List 1 is an old copy: its newest product is older than the key a.
    const fetches = [timed(0, 100, { a: 100, b: 50 }), timed(1, 60, { b: 50 }), timed(2, 110, { a: 100, b: 50 })];
    const runs = listRuns(fetches, 0, 2);
    expect(runs.limits.map((limit) => limit.ends)).toEqual([[], []]);
    expect([runs.old, runs.held]).toEqual([1, 1]);
    // With no times, the old copy gives a false end of a.
    const untimed = fetches.map(({ at: time, keys }) => ({ at: time, ...(keys === undefined ? {} : { keys }) }));
    expect(flapCounts(listRuns(untimed, 0, 1))[0]!.flaps).toBe(1);
  });

  it("keeps the count of a key over an old list", () => {
    const fetches = [timed(0, 100, { a: 100, b: 50 }), timed(1, 120, { b: 50 }), timed(2, 60, { b: 50 }), timed(3, 130, { b: 50 })];
    expect(endsAt(listRuns(fetches, 0, 2), 2)).toEqual([{ key: "a", last: at(0), left: at(1), ended: at(3) }]);
  });

  it("brings an ended key back only in a list that is newer than the list that ended it", () => {
    const fetches = [
      timed(0, 100, { a: 90, b: 100 }),
      // The list with the time 120 ends a.
      timed(1, 120, { b: 100 }),
      // An old copy, and a list with the same time as the end: each can be an old copy.
      timed(2, 100, { a: 90, b: 100 }),
      timed(3, 120, { a: 90, b: 100 }),
      timed(4, 130, { b: 100 }),
      timed(5, 140, { a: 90, b: 100 }),
    ];
    expect(endsAt(listRuns(fetches, 0, 1), 1)).toEqual([{ key: "a", last: at(0), left: at(1), ended: at(1), back: at(5) }]);
  });

  it("starts the count again for a key in an old list before its end, as snapshotStep does", () => {
    const fetches = [timed(0, 1, { a: 1 }), timed(1, 3, {}), timed(2, 2, { a: 1 }), timed(3, 4, {}), timed(4, 5, {}), timed(5, 6, { a: 1 })];
    const runs = listRuns(fetches, 0, 3);
    // At 1 miss, list 1 ends a, and the old list 2 does not bring it back. At 2 misses, the old list 2 starts the count again.
    expect(endsAt(runs, 1)).toEqual([{ key: "a", last: at(0), left: at(1), ended: at(1), back: at(5) }]);
    expect(endsAt(runs, 2)).toEqual([{ key: "a", last: at(2), left: at(3), ended: at(4), back: at(5) }]);
    expect(endsAt(runs, 3)).toEqual([]);
    expect(runs.old).toBe(1);
  });

  it("counts a miss of a key with a time in a list with no time", () => {
    const runs = listRuns([timed(0, 100, { a: 100 }), list(1), timed(2, 110, { a: 100 })], 0, 1);
    expect(endsAt(runs, 1)).toEqual([{ key: "a", last: at(0), left: at(1), ended: at(1), back: at(2) }]);
  });
});

describe("listRuns against snapshotStep", () => {
  const SOURCE = "list" as SourceId;
  const KEYS = ["a", "b", "c", "d"];
  const row = (key: string, fetched: number): Observation => ({
    id: `${SOURCE}:${key}` as ObservationId,
    source: SOURCE,
    fetched,
    contentType: "application/json",
    body: JSON.stringify({ key }),
    transport: { latency: 0 },
  });
  // A live report of a public test event in Kansas.
  const report = (key: string, sent: number, observation: Observation): Report => ({
    id: reportId({ source: SOURCE, key, sent }),
    source: SOURCE,
    origin: "nws",
    key,
    references: [],
    correlation: [{ system: "vtec", id: `KTOP.TO.W.${key}` }],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent,
    received: observation.fetched,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "KTOP",
    headline: "Tornado Warning",
    observation: observation.id,
    parameters: {},
  });

  /** This function gives the ends of `snapshotStep` for each complete list, as `[key, end, back or undefined]`. */
  function stepEnds(fetches: readonly ListFetch[], limit: number): [string, number, number | undefined][] {
    const reports = new Map<string, Report>();
    const marks: EndMark[] = [];
    const keyOf = new Map<ReportId, string>();
    const found: [string, number, number | undefined][] = [];
    let misses: ReadonlyMap<ReportId, number> = new Map();
    for (const fetch of fetches) {
      if (fetch.keys === undefined) continue;
      for (const key of fetch.keys) {
        if (reports.has(key)) continue;
        const made = report(key, fetch.sents?.[key] ?? 0, row(key, fetch.at));
        reports.set(key, made);
        keyOf.set(made.id, key);
      }
      const outcome: FetchOutcome = { ok: true, complete: true, observations: fetch.keys.map((key) => row(key, fetch.at)), ...(fetch.asOf === undefined ? {} : { asOf: fetch.asOf }) };
      const merge = normalize({ reports: [...reports.values()], ends: marks });
      const step = snapshotStep({ source: SOURCE, started: fetch.at - 1, ended: fetch.at, outcome, merge, misses, limit });
      for (const event of step.events) {
        for (const id of event.reports) {
          const key = keyOf.get(id)!;
          if (event.type === "ended") found.push([key, fetch.at, undefined]);
          else found.findLast((end) => end[0] === key && end[2] === undefined)![2] = fetch.at;
          marks.push({ report: id, at: fetch.at, ended: event.type === "ended", ...(event.type === "ended" && event.asOf !== undefined ? { asOf: event.asOf } : {}) });
        }
      }
      misses = step.misses;
    }
    return found.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  }

  it.each(SEEDS)("gives the ends and the returns of snapshotStep at each count of misses, with old lists and parts of lists (seed %s)", (seed) => {
    const r = random(seed).fork("lists");
    // Each key has one product time. A list has the keys of its time or older, and a time that goes back now and then.
    const sent = new Map(KEYS.map((key) => [key, r.int(0, 20)]));
    let newest = 0;
    const fetches: ListFetch[] = Array.from({ length: 30 }, (_, index) => {
      if (r.below(10) === 0) return cut(index);
      newest += r.int(0, 2);
      const asOf = r.below(4) === 0 ? newest - r.int(0, 6) : newest;
      const keys = KEYS.filter((key) => sent.get(key)! <= asOf && r.below(3) !== 0);
      return timed(index, asOf, Object.fromEntries(keys.map((key) => [key, sent.get(key)!])));
    });
    const runs = listRuns(fetches, 0, 4);
    for (const limit of runs.limits) {
      const ends = limit.ends.map((end): [string, number, number | undefined] => [end.key, end.ended, end.back]).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
      expect(ends, `seed ${String(seed)}, ${String(limit.misses)} misses`).toEqual(stepEnds(fetches, limit.misses));
    }
    expect(runs.limits.some((limit) => limit.ends.length > 0), `seed ${String(seed)}: the lists end no key`).toBe(true);
  });
});

describe("flapCounts", () => {
  it("counts a false end for each count of misses up to the length of a return, and a true end for a key that did not come back", () => {
    const runs = listRuns([list(0, "a", "b", "c"), list(1, "c"), list(2, "a"), list(3), list(4), list(5, "a", "b")], 0, 5);
    // a: back after 1 list, then after 2 lists. b: back after 4 lists. c: did not come back, after 4 lists with no c.
    // a and b leave at list 1, so list 1 is one start of 2 false ends for 1 miss.
    const counts = { trials: runs.trials, lists: 5, censored: 0 };
    expect(flapCounts(runs)).toEqual([
      { misses: 1, flaps: 3, ends: 1, starts: 2, largest: 2, ...counts },
      { misses: 2, flaps: 2, ends: 1, starts: 2, largest: 1, ...counts },
      { misses: 3, flaps: 1, ends: 1, starts: 1, largest: 1, ...counts },
      { misses: 4, flaps: 1, ends: 1, starts: 1, largest: 1, ...counts },
      { misses: 5, flaps: 0, ends: 0, starts: 0, largest: 0, ...counts },
    ]);
  });

  it("gives one start for a bad list that ends many keys at once", () => {
    const keys = Array.from({ length: 50 }, (_, index) => `k${String(index)}`);
    const runs = listRuns([list(0, ...keys), list(1), list(2, ...keys), list(3, ...keys)], 0, 1);
    expect(flapCounts(runs)).toEqual([{ misses: 1, flaps: 50, ends: 0, trials: 100, starts: 1, lists: 3, largest: 50, censored: 0 }]);
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
