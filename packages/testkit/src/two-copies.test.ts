import { EXCHANGE_EVERY, EXCHANGE_LIMIT, RANK_FLOOR } from "@mark1russell7/alerts-runtime";
import { faultPlanOf } from "@mark1russell7/rigor-chaos";
import { describe, expect, it } from "vitest";
import {
  APART_LIMIT,
  CASE_13_ID,
  CASE_13_SETTINGS,
  COPIES_ARMS,
  COPIES_GATES,
  type CopiesArm,
  type CopiesRecord,
  copiesFaultOf,
  copiesGatesOf,
  copiesPlanOf,
  copiesSettingsProblems,
  copiesVerdictOf,
  expectedCallsOf,
  seenOf,
} from "./two-copies.ts";

const FAULT_ARMS: readonly CopiesArm[] = ["slow", "reset", "stall"];

/** The record of an arm that passes each gate. The changes of a test go in `extra`. */
const recordOf = (arm: CopiesArm, extra: Partial<CopiesRecord> = {}): CopiesRecord => {
  const expected = expectedCallsOf(arm);
  const seen = seenOf(arm);
  const down = expected.count === 2;
  const firstAt = seen[expected.first];
  const calls = down ? [{ copy: "home" as const, at: 0 }, { copy: "cloud" as const, at: RANK_FLOOR }] : [{ copy: expected.first, at: firstAt }];
  const failedRounds = down ? 9 : 0;
  return {
    arm,
    copies: [
      { copy: "home", seenAt: seen.home, passes: 12, rounds: 18, failedRounds, problemRounds: 0 },
      { copy: "cloud", seenAt: seen.cloud, passes: 12, rounds: 18, failedRounds, problemRounds: 0 },
    ],
    pushes: [{ copy: "cloud", at: 0 }, { copy: "home", at: seen.home }],
    calls,
    faults: FAULT_ARMS.includes(arm) ? 30 : 0,
    connections: 36,
    errors: [],
    ...extra,
  };
};

const allPass = (): Record<string, boolean> => Object.fromEntries(COPIES_GATES.map((gate) => [gate, true]));

describe("case 13: two copies and one phone (AL-15)", () => {
  it("has the id of the suite, and its settings have no problem", () => {
    expect(CASE_13_ID).toBe("al-13-case-13");
    expect(copiesSettingsProblems(CASE_13_SETTINGS)).toEqual([]);
  });

  it("finds each setting that does not let the case read", () => {
    // At the speed 20, the call limit of the case is 20 s. Thus the floor of an instance does not hold.
    expect(copiesSettingsProblems({ ...CASE_13_SETTINGS, speed: 20 })).toHaveLength(1);
    expect(copiesSettingsProblems({ ...CASE_13_SETTINGS, awayMs: RANK_FLOOR })[0]).toContain("home-late");
    expect(copiesSettingsProblems({ ...CASE_13_SETTINGS, slowMs: EXCHANGE_LIMIT })[0]).toContain("slow");
    expect(copiesSettingsProblems({ ...CASE_13_SETTINGS, armMs: 60_000 })[0]).toContain("ends before");
  });

  it("gives the first sight of each copy: late by one exchange in cloud-first and slow, after the call of cloud in home-late", () => {
    expect(seenOf("control")).toEqual({ home: 0, cloud: 0 });
    expect(seenOf("cloud-first")).toEqual({ home: EXCHANGE_EVERY + EXCHANGE_LIMIT, cloud: 0 });
    expect(seenOf("slow")).toEqual(seenOf("cloud-first"));
    expect(seenOf("home-late")).toEqual({ home: CASE_13_SETTINGS.awayMs, cloud: 0 });
    expect(seenOf("reset")).toEqual({ home: 0, cloud: 0 });
    expect(seenOf("stall")).toEqual({ home: 0, cloud: 0 });
  });

  it("expects one call, except two calls when the exchange is down, and the first call from home, except in home-late", () => {
    expect(Object.fromEntries(COPIES_ARMS.map((arm) => [arm, expectedCallsOf(arm)]))).toEqual({
      control: { count: 1, first: "home" },
      "cloud-first": { count: 1, first: "home" },
      "home-late": { count: 1, first: "cloud" },
      slow: { count: 1, first: "home" },
      reset: { count: 2, first: "home" },
      stall: { count: 2, first: "home" },
    });
  });

  it("gives a fault to each connection of the fault arms, and no fault to the other arms", () => {
    const armMs = CASE_13_SETTINGS.armMs;
    expect(copiesFaultOf("control")).toBeUndefined();
    expect(copiesFaultOf("cloud-first")).toBeUndefined();
    expect(copiesFaultOf("home-late")).toBeUndefined();
    expect(copiesFaultOf("reset")).toEqual({ window: { from: 0, to: 2 * armMs }, direction: "up", at: { byte: 0 }, kind: "reset" });
    // A stall holds the answer past the time limit of the read, and a delay keeps it within the limit.
    expect(copiesFaultOf("stall")).toMatchObject({ direction: "down", at: { frame: 0 }, kind: "stall" });
    expect(copiesFaultOf("slow")).toMatchObject({ direction: "down", at: { frame: 0 }, kind: "delay", ms: CASE_13_SETTINGS.slowMs });
    expect(CASE_13_SETTINGS.slowMs).toBeLessThan(EXCHANGE_LIMIT);
    expect(copiesPlanOf("control")).toEqual(faultPlanOf([], []));
    expect(copiesPlanOf("reset")).toEqual(faultPlanOf([], [{ window: { from: 0, to: 2 * armMs }, direction: "up", at: { byte: 0 }, kind: "reset" }]));
  });

  it("passes each gate of a good record of each arm", () => {
    for (const arm of COPIES_ARMS) expect(copiesGatesOf(recordOf(arm)), arm).toEqual({ gates: allPass(), problems: [] });
  });

  it("fails the gate calls on a second call, and the gate caller on a call from the wrong copy", () => {
    const twice = copiesGatesOf(recordOf("control", { calls: [{ copy: "home", at: 0 }, { copy: "cloud", at: RANK_FLOOR }] }));
    expect(twice.gates).toMatchObject({ calls: false, caller: true, apart: true });
    const wrong = copiesGatesOf(recordOf("cloud-first", { calls: [{ copy: "cloud", at: RANK_FLOOR }] }));
    expect(wrong.gates).toMatchObject({ calls: true, caller: false });
    expect(wrong.problems).toEqual(["cloud-first: the first call came from cloud, not from home."]);
    expect(copiesGatesOf(recordOf("reset", { calls: [] })).gates).toMatchObject({ calls: false, caller: false });
  });

  it("fails the gate apart when two calls come less than one floor less one read apart", () => {
    const close = copiesGatesOf(recordOf("reset", { calls: [{ copy: "home", at: 0 }, { copy: "cloud", at: APART_LIMIT - 1 }] }));
    expect(close.gates.apart).toBe(false);
    expect(copiesGatesOf(recordOf("reset", { calls: [{ copy: "home", at: 0 }, { copy: "cloud", at: APART_LIMIT }] })).gates.apart).toBe(true);
    expect(APART_LIMIT).toBe(RANK_FLOOR - EXCHANGE_LIMIT);
  });

  it("fails the gate pushed with no push or with two pushes from one copy", () => {
    expect(copiesGatesOf(recordOf("control", { pushes: [] })).gates.pushed).toBe(false);
    expect(copiesGatesOf(recordOf("control", { pushes: [{ copy: "home", at: 0 }, { copy: "home", at: 5_000 }] })).gates.pushed).toBe(false);
    // A push of one copy can come into the ledger of the other copy before its first pass. Thus one push is enough.
    expect(copiesGatesOf(recordOf("control", { pushes: [{ copy: "home", at: 0 }] })).gates.pushed).toBe(true);
  });

  it("fails the gate noThrow on an error, the gate faulted on a fault arm with no fault, and the gate clean on a failed read in control", () => {
    expect(copiesGatesOf(recordOf("slow", { errors: ["home: a pass threw: boom"] }))).toMatchObject({ gates: { noThrow: false }, problems: ["slow: home: a pass threw: boom"] });
    expect(copiesGatesOf(recordOf("slow", { faults: 0 })).gates.faulted).toBe(false);
    const reads = recordOf("reset");
    const working = { ...reads, copies: reads.copies.map((copy) => ({ ...copy, failedRounds: copy.copy === "home" ? 0 : 3 })) };
    expect(copiesGatesOf(working).gates.faulted).toBe(false);
    const control = recordOf("control");
    expect(copiesGatesOf({ ...control, copies: control.copies.map((copy) => ({ ...copy, failedRounds: 1 })) }).gates.clean).toBe(false);
  });

  it("passes the verdict with each arm good, and gives no read when an arm did not run or the settings have a problem", () => {
    const records = COPIES_ARMS.map((arm) => recordOf(arm));
    expect(copiesVerdictOf(records)).toMatchObject({ read: true, pass: true, problems: [] });
    expect(copiesVerdictOf(records.slice(1))).toMatchObject({ read: false, pass: false });
    const idle = records.map((record) => (record.arm === "stall" ? { ...record, copies: record.copies.map((copy) => ({ ...copy, rounds: 0 })) } : record));
    expect(copiesVerdictOf(idle)).toMatchObject({ read: false, pass: false });
    expect(copiesVerdictOf(records, { ...CASE_13_SETTINGS, speed: 20 })).toMatchObject({ read: false, pass: false });
    const failed = records.map((record) => (record.arm === "cloud-first" ? recordOf("cloud-first", { calls: [{ copy: "home", at: 8_000 }, { copy: "cloud", at: RANK_FLOOR }] }) : record));
    expect(copiesVerdictOf(failed)).toMatchObject({ read: true, pass: false });
  });
});
