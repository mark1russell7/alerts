import { DEFAULT_ASSESS_POLICY, type Estimate, type ScorePriors } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";

import type { CapMonths } from "./cap.ts";
import { placeRate, readCapKey, replayOf, replaySummary, RISK_VALUES, type ReplayFile } from "./replay.ts";
import { underSection, type UnderRate, type UnderSection } from "./under.ts";
import { AlertTally, type AlertRow } from "./watchwarn.ts";

// Made-up alerts and priors. The offices, the numbers and the values are not real.
const years = { first: 2024, last: 2025 };
const row = (fields: Partial<AlertRow>): AlertRow => ({
  wfo: "TOP",
  phenomenon: "TO",
  significance: "W",
  eventId: 1,
  year: 2024,
  ugc: "KSC173",
  issue: Date.UTC(2024, 4, 6, 22),
  expire: Date.UTC(2024, 4, 6, 23),
  ...fields,
});

const tally = new AlertTally(years);
tally.add({
  rows: [
    row({}),
    row({ eventId: 2, ugc: "KSC177" }),
    row({ eventId: 3, year: 2025 }),
    // A severe thunderstorm warning adds a second county to 2025.
    row({ phenomenon: "SV", eventId: 4, year: 2025, ugc: "KSC001" }),
    row({ wfo: "EWX", phenomenon: "FG", significance: "Y", eventId: 5, ugc: "TXZ205" }),
  ],
  faults: {},
});
const under: UnderSection = underSection({ years, windows: [], counts: tally.counts(), matches: [], unplaced: [] });

const months: CapMonths = {
  "2026-10": { "TO.W": { "severe/immediate/likely": 2 } },
  "2026-11": { "FG.Y": { "minor/expected/likely": 4 }, "TO.W": { "extreme/immediate/observed": 1, "moderate/future/possible": 1, "severe/immediate/likely": 1 } },
};

const estimate = (value: number): Estimate => ({ value, low: value / 2, high: value * 2 });
const probability = (value: number): Estimate => ({ value, low: value / 2, high: Math.min(1, value * 2) });
const priors: ScorePriors = {
  format: "alerts-priors/2",
  kinds: { "met.tornado": { deaths: estimate(0.05), injuries: estimate(0.5), under: { warning: { deaths: estimate(0.002), injuries: estimate(0.02), area: "county" } } } },
  certainty: { observed: probability(1), likely: probability(0.8), possible: probability(0.3) },
};

const replay = replayOf({ under, months, priors, policy: DEFAULT_ASSESS_POLICY, risks: [0.001, 0.01, 0.1] });

describe("the keys of the CAP fields", () => {
  it("reads a key, and refuses a key that is not of the form severity/urgency/certainty", () => {
    expect(readCapKey("extreme/immediate/observed")).toEqual({ severity: "extreme", urgency: "immediate", certainty: "observed" });
    expect(() => readCapKey("extreme/immediate")).toThrow(/severity\/urgency\/certainty/);
    expect(() => readCapKey("extreme/now/observed")).toThrow(/severity\/urgency\/certainty/);
    expect(() => readCapKey("extreme/immediate/observed/more")).toThrow(/severity\/urgency\/certainty/);
  });
});

describe("the alerts in one place", () => {
  it("adds the areas in counties over the counties of each year and the areas in zones over the zones", () => {
    expect(under.codes).toEqual({ "2024": { counties: 2, zones: 1 }, "2025": { counties: 2, zones: 0 } });
    const tornado = under.kinds["met.tornado"]?.significances.W as UnderRate;
    expect(placeRate(tornado, under.codes, years)).toEqual({ mean: 0.75, low: 0.5, high: 1 });
    const fog = under.kinds["met.fog"]?.significances.Y as UnderRate;
    expect(placeRate(fog, under.codes, years)).toEqual({ mean: 0.5, low: 0, high: 1 });
  });

  it("has no read with no codes or with a year that has no codes", () => {
    const tornado = under.kinds["met.tornado"]?.significances.W as UnderRate;
    expect(placeRate(tornado, undefined, years)).toBeUndefined();
    expect(placeRate(tornado, { "2024": { counties: 2, zones: 1 } }, years)).toBeUndefined();
  });

  it("throws an error for areas with no codes of their kind", () => {
    const tornado = under.kinds["met.tornado"]?.significances.W as UnderRate;
    expect(() => placeRate(tornado, { "2024": { counties: 0, zones: 1 }, "2025": { counties: 2, zones: 0 } }, years)).toThrow(/no codes in counties/);
  });
});

describe("the replay of the table and the score", () => {
  it("gives each type its codes, its alerts, its place and its keys with the table level and the score", () => {
    expect(replay.types.map((type) => `${type.kind}|${type.significance}`)).toEqual(["met.fog|Y", "met.thunderstorm.severe|W", "met.tornado|W"]);
    const tornado = replay.types[2];
    expect(tornado).toMatchObject({ codes: ["TO.W"], alerts: 1.5, place: { mean: 0.75, low: 0.5, high: 1 }, cap: 5 });
    expect(tornado?.keys).toEqual([
      { key: "severe/immediate/likely", alerts: 3, level: "life-safety", deaths: 0.002, basis: "alert" },
      { key: "extreme/immediate/observed", alerts: 1, level: "life-safety", deaths: 0.05, basis: "event" },
      { key: "moderate/future/possible", alerts: 1, level: "urgent", deaths: 0.002, basis: "alert" },
    ]);
    expect(replay.types[0]?.keys).toEqual([{ key: "minor/expected/likely", alerts: 4, level: "digest" }]);
    expect(replay.months).toEqual(["2026-10", "2026-11"]);
  });

  it("names the types with no read of each factor", () => {
    expect(replay.noRead).toEqual({ place: [], cap: ["met.thunderstorm.severe|W"], score: ["met.fog|Y"] });
  });

  it("gives the sends at life-safety in one place in each year at each risk value", () => {
    expect(replay.table).toBeCloseTo(0.6, 12);
    const expected = [
      { risk: 0.001, score: 0.75, rule: 0.75, added: 0.15, kept: 0 },
      { risk: 0.01, score: 0.15, rule: 0.6, added: 0, kept: 0.45 },
      { risk: 0.1, score: 0, rule: 0.6, added: 0, kept: 0.6 },
    ];
    replay.curve.forEach((point, index) => {
      const want = expected[index];
      for (const field of ["risk", "score", "rule", "added", "kept"] as const) expect(point[field]).toBeCloseTo(want?.[field] ?? Number.NaN, 12);
    });
  });

  it("keeps the table as the floor: the rule is the table plus the sends that the score adds, and it falls as the risk grows", () => {
    const full = replayOf({ under, months, priors, policy: DEFAULT_ASSESS_POLICY });
    expect(full.curve.map((point) => point.risk)).toEqual(RISK_VALUES);
    full.curve.forEach((point, index) => {
      expect(point.rule).toBeCloseTo(full.table + point.added, 12);
      expect(point.score).toBeCloseTo(point.rule - point.kept, 12);
      expect(point.rule).toBeGreaterThanOrEqual(full.table - 1e-12);
      const before = full.curve[index - 1];
      if (before !== undefined) expect(point.rule).toBeLessThanOrEqual(before.rule + 1e-12);
    });
  });

  it("has no curve for a file of the base rates with no codes", () => {
    // A section of format 4 is the same section with no codes.
    const old = Object.fromEntries(Object.entries(under).filter(([key]) => key !== "codes")) as unknown as UnderSection;
    expect(old.codes).toBeUndefined();
    const result = replayOf({ under: old, months, priors, policy: DEFAULT_ASSESS_POLICY });
    expect(result.noRead.place).toEqual(["met.fog|Y", "met.thunderstorm.severe|W", "met.tornado|W"]);
    expect(result.table).toBe(0);
    expect(result.curve.every((point) => point.rule === 0 && point.score === 0)).toBe(true);
    expect(replaySummary(result)).toContain("No type has a read of the place and of the CAP fields. The curve has no read.");
  });
});

describe("the summary of a replay", () => {
  const text = replaySummary(replay);

  it("gives the curve and the types with the most alerts in one place", () => {
    expect(text).toContain("### The replay of the table and the score (2024 to 2025)");
    expect(text).toContain("The curve has 2 types. The table gives 0.60 sends at `life-safety` in one place in each year.");
    expect(text).toContain("| 0.0010 | 0.75 | 0.75 | 0.15 | 0 |");
    expect(text).toContain("| `met.tornado` W | TO.W | 1.5 | 0.75 (0.50 to 1.0) | 5 | 0.80 | 0.012 |");
    expect(text).toContain("| `met.fog` Y | FG.Y | 0.50 | 0.50 (0 to 1.0) | 4 | 0.00 | no read |");
    expect(text.indexOf("| `met.tornado` W")).toBeLessThan(text.indexOf("| `met.fog` Y"));
  });

  it("names the types with no read", () => {
    expect(text).toContain("No read of the CAP fields (1 types): `met.thunderstorm.severe|W`.");
    expect(text).toContain("No read of the score (1 types): `met.fog|Y`.");
  });

  it("is a pure function of the replay", () => {
    const copy = JSON.parse(JSON.stringify(replay)) as ReplayFile;
    expect(replaySummary(copy)).toBe(text);
  });
});
