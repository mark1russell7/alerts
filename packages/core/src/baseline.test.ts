import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { DEFAULT_BASELINE, isSignal, readSeries, staleTime, type BaselinePolicy, type SeriesRead } from "./baseline.ts";
import type { IndicatorArea, IndicatorAreaKind, MeasureDeclaration, ObservationId, Reading, SourceId } from "./contracts.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const SOURCE_ID = "test-roads" as SourceId;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A Monday at 08:00 UTC: the time of the latest value in each test.
const END = Date.UTC(2026, 10, 16, 8);

// Four made-up measures with an hourly cadence: one for each baseline, and one that drops.
const FLOW: MeasureDeclaration = { id: "flow", dimension: "road-traffic", title: "Vehicles", unit: "{vehicle}/h", area: "line", moves: "both", baseline: "none", cadence: HOUR };
const TRIPS: MeasureDeclaration = { id: "trips", dimension: "public-transit", title: "Trips in service", unit: "{trip}/h", area: "line", moves: "drop", baseline: "none", cadence: HOUR };
const LOAD: MeasureDeclaration = { id: "load", dimension: "power-demand", title: "Electric load", unit: "kW", area: "zone", moves: "rise", baseline: "expected", cadence: HOUR, delay: HOUR };
const OUTAGES: MeasureDeclaration = { id: "outages", dimension: "internet-connectivity", title: "Outages", unit: "{event}", area: "code", moves: "rise", baseline: "flag", cadence: HOUR };

const AREAS: Readonly<Partial<Record<IndicatorAreaKind, IndicatorArea>>> = {
  line: { type: "line", path: [[-95.68, 39.05], [-95.6, 39.1]] },
  zone: { type: "zone", system: "test-zone", code: "Z1" },
  code: { type: "code", system: "ugc", code: "KSZ083" },
};

function readingAt(measure: MeasureDeclaration, at: number, value: number, extra: Partial<Reading> = {}): Reading {
  const area = AREAS[measure.area];
  if (area === undefined) throw new Error(`No test area of the kind ${measure.area}.`);
  return { source: SOURCE_ID, measure: measure.id, series: "s1", at, value, area, observation: `obs-${String(at)}` as ObservationId, ...extra };
}

// The hourly history of 28 days before END, with a value from the time, and a noise of up to 1 from the seed.
function history(measure: MeasureDeclaration, valueAt: (at: number) => number, seed: string, extra: (at: number) => Partial<Reading> = () => ({})): Reading[] {
  const r = random(seed);
  return Array.from({ length: 28 * 24 }, (_, index) => {
    const at = END - (index + 1) * HOUR;
    return readingAt(measure, at, valueAt(at) + r.range(-1, 1), extra(at));
  });
}

const steady = (): number => 100;
// A rush hour from 06:00 to 10:00 UTC each day: 300 vehicles, and 100 at other times.
const rush = (at: number): number => (new Date(at).getUTCHours() >= 6 && new Date(at).getUTCHours() <= 10 ? 300 : 100);
const scoreOf = (read: SeriesRead): number => (read.kind === "score" ? read.score : Number.NaN);

describe("isSignal and staleTime", () => {
  it("give a signal only in the direction of the measure", () => {
    expect([isSignal(4, "rise", 3.5), isSignal(-4, "rise", 3.5), isSignal(-4, "drop", 3.5), isSignal(4, "drop", 3.5)]).toEqual([true, false, true, false]);
    expect([isSignal(4, "both", 3.5), isSignal(-4, "both", 3.5), isSignal(3, "both", 3.5)]).toEqual([true, true, false]);
  });

  it("take the cadence of the reading first, then the cadence of the measure, then the policy", () => {
    expect(staleTime(readingAt(FLOW, END, 1), FLOW)).toBe(3 * HOUR);
    expect(staleTime(readingAt(LOAD, END, 1, { expected: 1 }), LOAD)).toBe(4 * HOUR);
    expect(staleTime(readingAt(FLOW, END, 1, { cadence: 2 * HOUR }), FLOW)).toBe(6 * HOUR);
    const { cadence: _cadence, ...noCadence } = FLOW;
    expect(staleTime(readingAt(FLOW, END, 1), noCadence)).toBe(DEFAULT_BASELINE.staleAfter);
  });
});

describe("readSeries with the baseline none", () => {
  it("gives a signal for a spike, and no signal for a normal value", () => {
    const past = history(FLOW, steady, "spike");
    const spike = readSeries([...past, readingAt(FLOW, END, 200)], FLOW, END);
    expect(spike).toMatchObject({ kind: "score", at: END, signal: true });
    expect(scoreOf(spike)).toBeGreaterThan(DEFAULT_BASELINE.cut);
    const normal = readSeries([...past, readingAt(FLOW, END, 100.2)], FLOW, END);
    expect(normal).toMatchObject({ kind: "score", signal: false });
    if (normal.kind === "score") expect(Math.abs(normal.center - 100)).toBeLessThan(1);
  });

  it("gives a signal for a drop only to a measure that drops", () => {
    const fall = readingAt(TRIPS, END, 0);
    expect(readSeries([...history(TRIPS, steady, "drop"), fall], TRIPS, END)).toMatchObject({ kind: "score", signal: true });
    const rise = readingAt(TRIPS, END, 200);
    expect(readSeries([...history(TRIPS, steady, "drop"), rise], TRIPS, END)).toMatchObject({ kind: "score", signal: false });
  });

  it("keeps a normal rush hour out of the signals with the season of the week or of the day, and not with no season", () => {
    const past = history(FLOW, rush, "rush");
    const now = readingAt(FLOW, END, 300);
    for (const season of ["week", "day"] as const) expect(readSeries([...past, now], FLOW, END, { ...DEFAULT_BASELINE, season })).toMatchObject({ kind: "score", signal: false });
    expect(readSeries([...past, now], FLOW, END, { ...DEFAULT_BASELINE, season: "none" })).toMatchObject({ kind: "score", signal: true });
  });

  it("scores a series with no spread: 0 for the same value, and a signal for a change", () => {
    const flat = history(FLOW, steady, "flat").map((reading) => ({ ...reading, value: 100 }));
    expect(readSeries([...flat, readingAt(FLOW, END, 100)], FLOW, END)).toMatchObject({ kind: "score", score: 0, signal: false, center: 100 });
    expect(readSeries([...flat, readingAt(FLOW, END, 101)], FLOW, END)).toMatchObject({ kind: "score", signal: true, center: 100 });
  });

  it("counts only the values of the slot and of the window", () => {
    const past = history(FLOW, steady, "slot");
    const read = (policy: Partial<BaselinePolicy>): SeriesRead => readSeries([...past, readingAt(FLOW, END, 100)], FLOW, END, { ...DEFAULT_BASELINE, ...policy });
    // The week slot of 1 h: 3 hours in each of the weeks 1 to 3, and 2 hours in week 4, as the history ends at 28 days.
    expect(read({})).toMatchObject({ samples: 11 });
    expect(read({ season: "day" })).toMatchObject({ samples: 27 * 3 + 2 });
    expect(read({ season: "none" })).toMatchObject({ samples: 28 * 24 });
    expect(read({ season: "none", window: DAY })).toMatchObject({ samples: 24 });
    expect(read({ slack: 0, samples: 1 })).toMatchObject({ samples: 4 });
    expect(read({ slack: 0 })).toEqual({ kind: "no-read", cause: "few-samples" });
  });
});

describe("readSeries with the baseline of the source", () => {
  it("scores the residual from the expected value, and gives the expected value as the center", () => {
    const expectedAt = (at: number): number => 1000 + 500 * Math.sin((2 * Math.PI * at) / DAY);
    const past = history(LOAD, expectedAt, "load", (at) => ({ expected: expectedAt(at) }));
    const high = readSeries([...past, readingAt(LOAD, END, expectedAt(END) + 50, { expected: expectedAt(END) })], LOAD, END);
    expect(high).toMatchObject({ kind: "score", signal: true });
    if (high.kind === "score") expect(Math.abs(high.center - expectedAt(END))).toBeLessThan(1);
    const normal = readSeries([...past, readingAt(LOAD, END, expectedAt(END) + 0.3, { expected: expectedAt(END) })], LOAD, END);
    expect(normal).toMatchObject({ kind: "score", signal: false });
  });

  it("gives the flag of the source as the signal", () => {
    expect(readSeries([readingAt(OUTAGES, END, 3, { flagged: true })], OUTAGES, END)).toEqual({ kind: "flag", at: END, signal: true });
    expect(readSeries([readingAt(OUTAGES, END, 3, { flagged: false })], OUTAGES, END)).toEqual({ kind: "flag", at: END, signal: false });
    expect(readSeries([readingAt(OUTAGES, END - 4 * HOUR, 3, { flagged: true })], OUTAGES, END)).toEqual({ kind: "no-read", cause: "stale" });
  });
});

describe("the gate: a missing value is not a normal value", () => {
  it("gives no read with no reading, with only readings after the time of the read, and with a stale series", () => {
    expect(readSeries([], FLOW, END)).toEqual({ kind: "no-read", cause: "no-reading" });
    expect(readSeries([readingAt(FLOW, END + HOUR, 100)], FLOW, END)).toEqual({ kind: "no-read", cause: "no-reading" });
    const past = history(FLOW, steady, "stale");
    expect(readSeries(past, FLOW, END + 3 * HOUR)).toEqual({ kind: "no-read", cause: "stale" });
    expect(readSeries(past, FLOW, END + 2 * HOUR)).toMatchObject({ kind: "score" });
    // The cadence of the series replaces the cadence of the measure.
    const slow = past.map((reading) => ({ ...reading, cadence: 2 * HOUR }));
    expect(readSeries(slow, FLOW, END + 3 * HOUR)).toMatchObject({ kind: "score" });
  });

  it("gives no read for a new series, and for a new version, until the history has enough values", () => {
    expect(readSeries([readingAt(FLOW, END, 500)], FLOW, END)).toEqual({ kind: "no-read", cause: "few-samples" });
    const old = history(FLOW, steady, "version", () => ({ version: "1" }));
    expect(readSeries([...old, readingAt(FLOW, END, 500, { version: "2" })], FLOW, END)).toEqual({ kind: "no-read", cause: "few-samples" });
    expect(readSeries([...old, readingAt(FLOW, END, 500, { version: "1" })], FLOW, END)).toMatchObject({ kind: "score", signal: true });
  });

  it("gives no score with fewer values than the policy needs, for any measure, count and policy (seeded)", () => {
    for (const seed of SEEDS) {
      const r = random(`baseline-few:${seed}`);
      const samples = r.int(1, 30);
      const policy: BaselinePolicy = { ...DEFAULT_BASELINE, season: r.pick(["week", "day", "none"] as const), samples };
      const measure = r.pick([FLOW, TRIPS]);
      const all = history(measure, steady, `baseline-few-history:${seed}`);
      const kept = r.sample(all, r.int(0, samples - 1));
      const read = readSeries([...kept, readingAt(measure, END, r.range(0, 1000))], measure, END, policy);
      expect(read, `seed ${r.seed}`).toEqual({ kind: "no-read", cause: "few-samples" });
    }
  });
});

describe("readSeries is a function of the set of readings", () => {
  it("gives one read for each order of the readings and with duplicates of a later observation (seeded)", () => {
    for (const seed of SEEDS) {
      const r = random(`baseline-order:${seed}`);
      const measure = r.pick([FLOW, TRIPS]);
      const readings = [...history(measure, rush, `baseline-order-history:${seed}`), readingAt(measure, END, r.range(0, 600))];
      const expected = readSeries(readings, measure, END);
      const copies = r.sample(readings, r.int(1, 50)).map((reading) => ({ ...reading, value: 1e6, observation: `${reading.observation}-copy` as ObservationId }));
      expect(readSeries(r.shuffle([...readings, ...copies]), measure, END), `seed ${r.seed}`).toEqual(expected);
    }
  });
});
