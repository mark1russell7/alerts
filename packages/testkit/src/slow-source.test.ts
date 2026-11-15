import { describe, expect, it } from "vitest";
import type { Baseline } from "./nws.ts";
import { CASE_2_ID, CASE_2_SETTINGS, runSlowSource, type SlowArm, type SlowRecord, type SlowSettings, slowVerdictOf, stallPoints, trickleMs } from "./slow-source.ts";

describe("stallPoints", () => {
  it("gives the first byte, the middle of the head and the head plus each sweep point of the body", () => {
    const points = stallPoints(200, 5000, 4, CASE_2_ID);
    expect(points).toHaveLength(9);
    expect(points.slice(0, 3)).toEqual([0, 100, 200]);
    expect(points.at(-1)).toBe(200 + 4999);
    expect(points.slice(2).every((p) => p >= 200 && p < 5200)).toBe(true);
    // The seed fixes the points: a second call gives the same points.
    expect(stallPoints(200, 5000, 4, CASE_2_ID)).toEqual(points);
  });
});

describe("the settings of the case in CI", () => {
  it("have a long stall and a trickle longer than the limit, and a short stall of a quarter of the limit or less", () => {
    expect(CASE_2_SETTINGS.longStallMs).toBeGreaterThan(CASE_2_SETTINGS.limitMs);
    expect(trickleMs(CASE_2_SETTINGS)).toBe(3900);
    expect(CASE_2_SETTINGS.shortStallMs).toBeLessThanOrEqual(CASE_2_SETTINGS.limitMs / 4);
  });
});

describe("slowVerdictOf", () => {
  const OBSERVATIONS = 15;
  const settings: SlowSettings = { ...CASE_2_SETTINGS, draws: 0 };
  const framings = ["length", "chunked", "close"] as const;
  const baseline = (framing: Baseline["framing"]): Baseline => ({
    framing,
    head: 200,
    body: 5000,
    whole: true,
    outcome: { ok: true, complete: true, observations: OBSERVATIONS },
    ms: 20,
  });
  const baselines = framings.map(baseline);
  const timeout = { ok: false, kind: "timeout", message: "no answer in 2 s" } as const;
  const whole = { ok: true, complete: true, observations: OBSERVATIONS } as const;
  const record = (framing: SlowRecord["framing"], arm: SlowArm, point: number, outcome: SlowRecord["outcome"], ms: number): SlowRecord => ({
    framing,
    arm,
    point,
    faulted: true,
    sameHead: true,
    outcome,
    ms,
  });
  const points = stallPoints(200, 5000, 0, CASE_2_ID);
  const all = (): SlowRecord[] =>
    framings.flatMap((framing) => [
      ...points.map((p) => record(framing, "long", p, timeout, 2004)),
      record(framing, "trickle", 200, timeout, 2003),
      ...points.map((p) => record(framing, "short", p, whole, 530)),
    ]);

  it("passes when each long stall and each trickle is a timeout before its end, and each short stall gives the full list", () => {
    const verdict = slowVerdictOf(baselines, all(), OBSERVATIONS, settings);
    expect(verdict.problems).toEqual([]);
    expect(verdict).toMatchObject({ read: true, pass: true, gates: { long: true, trickle: true, short: true } });
  });

  it("fails the arm long when a stall gives another failure, or a timeout only at the end of the stall", () => {
    const network = all();
    network[0] = record("length", "long", 0, { ok: false, kind: "network", message: "terminated" }, 2004);
    expect(slowVerdictOf(baselines, network, OBSERVATIONS, settings)).toMatchObject({ read: true, pass: false, gates: { long: false, trickle: true, short: true } });
    const late = all();
    late[1] = record("length", "long", points[1] ?? 0, timeout, 8000);
    expect(slowVerdictOf(baselines, late, OBSERVATIONS, settings)).toMatchObject({ pass: false, gates: { long: false } });
  });

  it("fails the arm trickle when the full body comes in through the trickle", () => {
    const records = all().map((r) => (r.arm === "trickle" && r.framing === "chunked" ? { ...r, outcome: whole, ms: 3950 } : r));
    expect(slowVerdictOf(baselines, records, OBSERVATIONS, settings)).toMatchObject({ read: true, pass: false, gates: { trickle: false } });
  });

  it("fails the arm short on a false failure, or on a list that is not full", () => {
    const failure = all().map((r) => (r.arm === "short" && r.point === 0 && r.framing === "close" ? { ...r, outcome: timeout, ms: 2001 } : r));
    expect(slowVerdictOf(baselines, failure, OBSERVATIONS, settings)).toMatchObject({ pass: false, gates: { short: false } });
    const partial = all().map((r) => (r.arm === "short" && r.framing === "length" ? { ...r, outcome: { ok: true, complete: false, observations: 14 } as const } : r));
    expect(slowVerdictOf(baselines, partial, OBSERVATIONS, settings)).toMatchObject({ pass: false, gates: { short: false } });
  });

  it("has no read, and no pass, when a fault did not fall at its point, or a baseline is slow or not whole", () => {
    const missed = all();
    missed[2] = { ...(missed[2] as SlowRecord), faulted: false };
    expect(slowVerdictOf(baselines, missed, OBSERVATIONS, settings)).toMatchObject({ read: false, pass: false });
    const otherHead = all();
    otherHead[3] = { ...(otherHead[3] as SlowRecord), sameHead: false };
    expect(slowVerdictOf(baselines, otherHead, OBSERVATIONS, settings)).toMatchObject({ read: false, pass: false });
    const slow = [{ ...baseline("length"), ms: 500 }, ...baselines.slice(1)];
    expect(slowVerdictOf(slow, all(), OBSERVATIONS, settings)).toMatchObject({ read: false, pass: false });
    const broken = [{ ...baseline("length"), whole: false }, ...baselines.slice(1)];
    expect(slowVerdictOf(broken, all(), OBSERVATIONS, settings)).toMatchObject({ read: false, pass: false });
    expect(slowVerdictOf(baselines.slice(1), all(), OBSERVATIONS, settings)).toMatchObject({ read: false, pass: false });
    expect(slowVerdictOf(baselines, all().slice(1), OBSERVATIONS, settings)).toMatchObject({ read: false, pass: false });
  });

  it("has no read when the settings cannot test the limit", () => {
    const records = all();
    expect(slowVerdictOf(baselines, records, OBSERVATIONS, { ...settings, longStallMs: 2000 })).toMatchObject({ read: false, pass: false });
    expect(slowVerdictOf(baselines, records, OBSERVATIONS, { ...settings, trickle: { pieces: 21, gapMs: 100 } })).toMatchObject({ read: false, pass: false });
    expect(slowVerdictOf(baselines, records, OBSERVATIONS, { ...settings, shortStallMs: 501 })).toMatchObject({ read: false, pass: false });
  });
});

describe("runSlowSource", () => {
  // The times are small, and each gate has a wide margin: the limit is 600 ms, the long stall is 2400 ms, the trickle is
  // 1100 ms and the short stall is 60 ms. The test examines the records and the gates, not the time of the baseline.
  it("slows the length framing at each point, with the record of each fault at its byte", async () => {
    const run = await runSlowSource({ framings: ["length"], draws: 0, limitMs: 600, longStallMs: 2400, shortStallMs: 60, trickle: { pieces: 12, gapMs: 100 } });
    const [baseline] = run.baselines;
    expect([baseline?.framing, baseline?.whole]).toEqual(["length", true]);
    const head = baseline?.head ?? Number.NaN;
    const points = stallPoints(head, baseline?.body ?? 0, 0, CASE_2_ID);
    expect(run.records.filter((r) => r.arm === "long").map((r) => r.point)).toEqual(points);
    expect(run.records.filter((r) => r.arm === "trickle").map((r) => r.point)).toEqual([head]);
    expect(run.records.filter((r) => r.arm === "short").map((r) => r.point)).toEqual(points);
    for (const r of run.records) expect([r.arm, r.point, r.faulted, r.sameHead]).toEqual([r.arm, r.point, true, true]);
    expect(run.verdict.gates).toEqual({ long: true, trickle: true, short: true });
  }, 60_000);
});
