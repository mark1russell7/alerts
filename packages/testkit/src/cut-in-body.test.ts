import { describe, expect, it } from "vitest";
import { type Baseline, type CutRecord, caseBodies, runCutInBody, verdictOf } from "./cut-in-body.ts";

describe("caseBodies", () => {
  it("gives one feature collection of each fixture, and a canary with the keepalive message", () => {
    const bodies = caseBodies();
    const main = JSON.parse(new TextDecoder().decode(bodies.main)) as { features: unknown[] };
    const canary = JSON.parse(new TextDecoder().decode(bodies.canary)) as { features: unknown[] };
    expect(main.features).toHaveLength(bodies.features);
    expect(bodies.features).toBeGreaterThanOrEqual(14);
    expect(canary.features).toHaveLength(1);
    // A whole fetch gives the observations of the main query and of the canary query.
    expect(bodies.observations).toBe(bodies.features + 1);
    // The body ends with its last brace, with no white space. Thus each prefix of the body is not valid JSON.
    const text = new TextDecoder().decode(bodies.main);
    expect(text.trimEnd()).toBe(text);
    expect(text.endsWith("}")).toBe(true);
  });
});

describe("verdictOf", () => {
  const FEATURES = 14;
  const baseline = (framing: Baseline["framing"]): Baseline => ({
    framing,
    head: 100,
    body: 5000,
    whole: true,
    outcome: { ok: true, complete: true, observations: FEATURES },
  });
  const network = { ok: false, kind: "network", message: "terminated" } as const;
  const record = (framing: CutRecord["framing"], offset: number, outcome: CutRecord["outcome"] = network): CutRecord => ({
    framing,
    offset,
    cutByte: 100 + offset,
    cut: true,
    sameHead: true,
    outcome,
    ms: 3,
  });
  const baselines = [baseline("length"), baseline("chunked"), baseline("close")];
  const all = (outcome?: CutRecord["outcome"]): CutRecord[] =>
    (["length", "chunked", "close"] as const).flatMap((framing) => [0, 1, 4999].map((offset) => record(framing, offset, outcome)));

  it("passes when each cut is a network failure", () => {
    const verdict = verdictOf(baselines, all(), FEATURES, 0);
    expect(verdict).toMatchObject({ read: true, neverWhole: true, pass: true, network: { length: true, chunked: true, close: true } });
    expect(verdict.problems).toEqual([]);
  });

  it("fails when a cut body gives ok and complete", () => {
    const records = all();
    records[7] = record("close", 1, { ok: true, complete: true, observations: 13 });
    const verdict = verdictOf(baselines, records, FEATURES, 0);
    expect(verdict).toMatchObject({ read: true, neverWhole: false, pass: false });
  });

  it("fails when a framed cut is not a network failure, but not for close with another failure", () => {
    const framed = all();
    framed[0] = record("length", 0, { ok: false, kind: "timeout", message: "timeout" });
    expect(verdictOf(baselines, framed, FEATURES, 0)).toMatchObject({ pass: false, network: { length: false } });
    const close = all();
    close[6] = record("close", 0, { ok: false, kind: "timeout", message: "timeout" });
    expect(verdictOf(baselines, close, FEATURES, 0)).toMatchObject({ pass: true, network: { close: false } });
  });

  it("has no read, and no pass, when a cut did not fall at its point or a baseline is not whole", () => {
    const records = all();
    records[1] = { ...record("length", 1), cut: false };
    expect(verdictOf(baselines, records, FEATURES, 0)).toMatchObject({ read: false, pass: false });
    expect(verdictOf([{ ...baseline("length"), whole: false }, ...baselines.slice(1)], all(), FEATURES, 0)).toMatchObject({ read: false, pass: false });
    expect(verdictOf(baselines.slice(1), all(), FEATURES, 0)).toMatchObject({ read: false, pass: false });
    expect(verdictOf(baselines, all().slice(1), FEATURES, 0)).toMatchObject({ read: false, pass: false });
  });
});

describe("runCutInBody", () => {
  it("cuts each framing at the edges of the body, at the point of each plan", async () => {
    const run = await runCutInBody({ draws: 0 });
    expect(run.baselines.map((b) => [b.framing, b.whole])).toEqual([
      ["length", true],
      ["chunked", true],
      ["close", true],
    ]);
    expect(run.records).toHaveLength(9);
    for (const b of run.baselines) {
      // With no draw, the sweep has only the edges of the wire body: the first byte, the second byte and the last byte.
      expect(run.records.filter((r) => r.framing === b.framing).map((r) => r.offset)).toEqual([0, 1, b.body - 1]);
    }
    for (const r of run.records) expect([r.cut, r.sameHead, r.cutByte]).toEqual([true, true, (run.baselines.find((b) => b.framing === r.framing)?.head ?? Number.NaN) + r.offset]);
    expect(run.verdict.read).toBe(true);
  }, 60_000);
});
