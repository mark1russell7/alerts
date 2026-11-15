import { CAP_CERTAINTY_BANDS } from "@mark1russell7/alerts-format-cap";
import { wilson } from "@mark1russell7/rigor-statistics";
import { escapeMarkdown } from "@mark1russell7/text";
import { describe, expect, it } from "vitest";

import { COW_PHENOMENA, type CowCount, type CowPhenomenon, type CowTally } from "./cow.ts";
import { checkRates, gatedValues } from "./gate.ts";
import type { Harm, YearHarm } from "./ncei.ts";
import { cowRates, nceiRates, RATES_FORMAT, ratesFile, type RatesFile, type RatesInput } from "./rates.ts";
import { ratesSummary } from "./summary.ts";

const cowYears = { first: 2023, last: 2025 };
const nceiYears = { first: 2023, last: 2025 };

/** A synthetic tally: each phenomenon has `warnings` warnings in each year, and the verified counts of `verified`. */
const tally = (verified: readonly number[], warnings = 100): Record<CowPhenomenon, CowTally> =>
  Object.fromEntries(
    COW_PHENOMENA.map((phenomenon) => {
      const byYear: Record<string, CowCount> = {};
      verified.forEach((count, index) => (byYear[String(cowYears.first + index)] = { warnings, verified: count, verifiedOwn: Math.floor(count / 2) }));
      const sum = (field: keyof CowCount): number => Object.values(byYear).reduce((total, count) => total + count[field], 0);
      return [phenomenon, { warnings: sum("warnings"), verified: sum("verified"), verifiedOwn: sum("verifiedOwn"), byYear }];
    }),
  ) as Record<CowPhenomenon, CowTally>;

const harm = (events: number, deaths: number, injuries: number): Harm => ({ events, deathsDirect: deaths, deathsIndirect: 0, injuriesDirect: injuries, injuriesIndirect: 0 });

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** Synthetic sums of three years. */
const harms = (tornadoDeaths: readonly number[]): YearHarm[] =>
  tornadoDeaths.map((deaths, index) => ({
    year: nceiYears.first + index,
    rows: 10,
    months: ALL_MONTHS,
    types: {
      Tornado: harm(5, deaths, deaths * 10),
      ...(index === 0 ? { Drought: harm(2, 0, 0) } : {}),
      ...(index === 2 ? { "Space Weather": harm(1, 0, 1) } : {}),
    },
  }));

const input = (verified: readonly number[], tornadoDeaths: readonly number[]): RatesInput => ({
  fetched: Date.UTC(2026, 10, 15),
  cow: { years: cowYears, params: { wfo: [], lsrbuffer: 15 }, queries: ["?begints=x"], tally: tally(verified) },
  ncei: { years: nceiYears, files: [], harms: harms(tornadoDeaths) },
});

describe("the Cow measure", () => {
  it("gives the share, its Wilson interval and its interval over the years", () => {
    const rates = cowRates(tally([60, 70, 80]), cowYears);
    const { share, ownShare } = rates.TO;
    expect(rates.TO).toMatchObject({ kind: "met.tornado", label: "Tornado", warnings: 300, verified: 210, verifiedOwn: 105 });
    expect(share.value).toBeCloseTo(0.7, 12);
    const score = wilson(210, 300);
    expect(share.wilson).toEqual([score.low, score.high]);
    expect(share.overYears[0]).toBeGreaterThanOrEqual(0.6);
    expect(share.overYears[1]).toBeLessThanOrEqual(0.8);
    expect(share.gate).toEqual([Math.min(share.wilson[0], share.overYears[0]), Math.max(share.wilson[1], share.overYears[1])]);
    expect(ownShare.value).toBeCloseTo(105 / 300, 12);
    expect(Object.keys(rates.TO.byYear)).toEqual(["2023", "2024", "2025"]);
  });

  it("gives the same intervals for the same counts", () => {
    expect(JSON.stringify(cowRates(tally([60, 70, 80]), cowYears))).toBe(JSON.stringify(cowRates(tally([60, 70, 80]), cowYears)));
  });

  it("counts a year with no warning as 0, and throws an error for a phenomenon with no warning", () => {
    const counts = tally([60, 70]);
    expect(cowRates(counts, cowYears).TO.byYear["2025"]).toEqual({ warnings: 0, verified: 0, verifiedOwn: 0 });
    expect(() => cowRates({ ...counts, EW: { warnings: 0, verified: 0, verifiedOwn: 0, byYear: {} } }, cowYears)).toThrow(/no EW warning/);
  });
});

describe("the NCEI measure", () => {
  it("gives the mean of each year with its interval, and a year with no row as 0", () => {
    const { types, newTypes } = nceiRates(harms([1, 2, 6]), nceiYears);
    expect(types["Tornado"]).toMatchObject({ kind: "met.tornado", events: 15, deathsDirect: 9, injuriesDirect: 90 });
    expect(types["Tornado"]?.deaths.value).toBe(3);
    expect(types["Tornado"]?.injuries.value).toBe(30);
    const { overYears, gate } = types["Tornado"]?.deaths ?? { overYears: [0, 0], gate: [0, 0] };
    expect(overYears[0]).toBeGreaterThanOrEqual(1);
    expect(overYears[1]).toBeLessThanOrEqual(6);
    expect(gate[0]).toBeLessThanOrEqual(3);
    expect(gate[1]).toBeGreaterThanOrEqual(3);
    expect(types["Drought"]).toMatchObject({ kind: null, events: 2, byYear: { "2023": { events: 2, deaths: 0, injuries: 0 }, "2024": { events: 0, deaths: 0, injuries: 0 } } });
    expect(types["Drought"]?.deaths).toEqual({ value: 0, overYears: [0, 0], gate: [0, 0] });
    expect(newTypes).toEqual(["Space Weather"]);
  });

  it("throws an error for a year with no file or with fewer than 12 months", () => {
    expect(() => nceiRates(harms([1, 2]), nceiYears)).toThrow(/no file of 2025/);
    const short = harms([1, 2, 3]).map((year) => (year.year === 2024 ? { ...year, months: [1, 2, 3] } : year));
    expect(() => nceiRates(short, nceiYears)).toThrow(/2024 has events in 3 months/);
  });
});

describe("the file of the base rates", () => {
  it("holds the format, the time, the queries and the CAP bands", () => {
    const file = ratesFile(input([60, 70, 80], [1, 2, 6]));
    expect(file.format).toBe(RATES_FORMAT);
    expect(file.fetched).toBe("2026-11-15T00:00:00.000Z");
    expect(file.cow.queries).toEqual(["?begints=x"]);
    expect(file.cap.bands).toEqual(CAP_CERTAINTY_BANDS);
    expect(file.cap.source.section).toMatch(/^3\.2\.2/);
  });
});

describe("the gate", () => {
  const committed: RatesFile = ratesFile(input([60, 70, 80], [1, 2, 6]));

  it("examines the two shares of each phenomenon and the deaths and injuries of each type", () => {
    const paths = [...gatedValues(committed).keys()];
    expect(paths).toHaveLength(COW_PHENOMENA.length * 2 + 3 * 2);
    expect(paths).toContain("cow.TO.share");
    expect(paths).toContain("ncei.Tornado.deaths");
  });

  it("passes the same measure, and a measure in the intervals", () => {
    expect(checkRates(committed, committed)).toEqual([]);
    expect(checkRates(committed, ratesFile(input([62, 70, 79], [2, 2, 5])))).toEqual([]);
  });

  it("stops a value out of its interval", () => {
    const breaks = checkRates(committed, ratesFile(input([90, 95, 99], [1, 2, 6])));
    expect(breaks.map((item) => item.path)).toEqual(COW_PHENOMENA.flatMap((phenomenon) => [`cow.${phenomenon}.ownShare`, `cow.${phenomenon}.share`]).sort());
    const share = breaks.find((item) => item.path === "cow.TO.share");
    expect(share?.value).toBeCloseTo(284 / 300, 12);
    expect(share?.gate).toEqual(committed.cow.phenomena.TO.share.gate);
  });

  it("stops a new type with deaths or injuries, and a type that goes away", () => {
    const fresh = ratesFile(input([60, 70, 80], [1, 2, 6]));
    const added: RatesFile = { ...fresh, ncei: { ...fresh.ncei, types: { ...fresh.ncei.types, Tsunami: { ...(fresh.ncei.types["Tornado"] as RatesFile["ncei"]["types"][string]), kind: "geo.tsunami" } } } };
    expect(checkRates(committed, added).map((item) => item.path)).toEqual(["ncei.Tsunami.deaths", "ncei.Tsunami.injuries"]);
    const { Tornado: _, ...rest } = fresh.ncei.types;
    const removed: RatesFile = { ...fresh, ncei: { ...fresh.ncei, types: rest } };
    expect(checkRates(committed, removed)).toEqual([
      { path: "ncei.Tornado.deaths", value: 0, gate: committed.ncei.types["Tornado"]?.deaths.gate },
      { path: "ncei.Tornado.injuries", value: 0, gate: committed.ncei.types["Tornado"]?.injuries.gate },
    ]);
  });
});

describe("the summary", () => {
  const file = ratesFile(input([60, 70, 80], [1, 2, 6]));

  it("tells the shares, the types, the bands and the result of the gate", () => {
    const text = ratesSummary(file, { committed: false });
    expect(text).toContain("| TO Tornado | `met.tornado` | 300 | 210 | 70.0% |");
    expect(text).toContain("| Tornado | `met.tornado` | 15 | 9 | 3 (");
    expect(text).toContain("| Drought | none |");
    expect(text).toContain("does not have these types: Space Weather.");
    expect(text).toContain(`| likely | ${escapeMarkdown("Likely (p > ~50%)")} | (0.5, 1], approximate |`);
    expect(text).toContain("There is no committed file.");
    expect(ratesSummary(file, { committed: true, breaks: [] })).toContain("Each value is in the gate interval");
    expect(ratesSummary(file, { committed: true, breaks: [{ path: "cow.TO.share", value: 0.9, gate: [0.6, 0.8] }] })).toContain("| cow.TO.share | 0.9 | 0.6 to 0.8 |");
  });
});
