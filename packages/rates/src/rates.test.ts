import { CAP_CERTAINTY_BANDS } from "@mark1russell7/alerts-format-cap";
import { wilson } from "@mark1russell7/rigor-statistics";
import { escapeMarkdown } from "@mark1russell7/text";
import { describe, expect, it } from "vitest";

import { COW_PHENOMENA, COW_QUERY_PHENOMENA, COW_UNVERIFIED, type CowCount, type CowQueryPhenomenon, type CowTally } from "./cow.ts";
import { checkRates, gatedValues } from "./gate.ts";
import type { Harm, YearHarm } from "./ncei.ts";
import { cowRates, MIN_YEAR_COUNT, nceiRates, noReadOf, RATES_FORMAT, ratesFile, type RatesFile, type RatesInput } from "./rates.ts";
import { ratesSummary } from "./summary.ts";

const cowYears = { first: 2023, last: 2025 };
const nceiYears = { first: 2023, last: 2025 };

/** The counts of one phenomenon: `warnings` warnings in each year, and the verified counts of `verified`. */
const counts = (verified: readonly number[], warnings = 100): CowTally => {
  const byYear: Record<string, CowCount> = {};
  verified.forEach((count, index) => (byYear[String(cowYears.first + index)] = { warnings, verified: count, verifiedOwn: Math.floor(count / 2) }));
  const sum = (field: keyof CowCount): number => Object.values(byYear).reduce((total, count) => total + count[field], 0);
  return { warnings: sum("warnings"), verified: sum("verified"), verifiedOwn: sum("verifiedOwn"), byYear };
};

/** A synthetic tally: each phenomenon of the requests has the counts of `verified`. */
const tally = (verified: readonly number[], warnings = 100): Record<CowQueryPhenomenon, CowTally> =>
  Object.fromEntries(COW_QUERY_PHENOMENA.map((phenomenon) => [phenomenon, counts(verified, warnings)])) as Record<CowQueryPhenomenon, CowTally>;

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

const input = (verified: readonly number[], tornadoDeaths: readonly number[], cow: Record<CowQueryPhenomenon, CowTally> = tally(verified)): RatesInput => ({
  fetched: Date.UTC(2026, 10, 15),
  cow: { years: cowYears, params: { wfo: [], lsrbuffer: 15 }, queries: ["?begints=x"], tally: cow },
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
    expect(share.noRead).toBeNull();
    expect(ownShare.value).toBeCloseTo(105 / 300, 12);
    expect(ownShare.noRead).toBeNull();
    expect(Object.keys(rates.TO.byYear)).toEqual(["2023", "2024", "2025"]);
  });

  it("gives the same intervals for the same counts", () => {
    expect(JSON.stringify(cowRates(tally([60, 70, 80]), cowYears))).toBe(JSON.stringify(cowRates(tally([60, 70, 80]), cowYears)));
  });

  it("counts a year with no warning as 0, and throws an error for a phenomenon with no warning", () => {
    const some = tally([60, 70]);
    expect(cowRates(some, cowYears).TO.byYear["2025"]).toEqual({ warnings: 0, verified: 0, verifiedOwn: 0 });
    expect(() => cowRates({ ...some, SQ: { warnings: 0, verified: 0, verifiedOwn: 0, byYear: {} } }, cowYears)).toThrow(/no SQ warning/);
  });

  it("gives a reason of no read for each year with too few verified or unverified warnings", () => {
    // The snow squalls of Cow: no verified warning in two years, then a share near 30%.
    const rates = cowRates({ ...tally([60, 70, 80]), SQ: counts([0, 0, 30], 300) }, cowYears);
    expect(rates.SQ.share.noRead).toBe("too few verified or unverified warnings in a year (2023: 0 verified of 300, 2024: 0 verified of 300)");
    expect(rates.SQ.share.value).toBeCloseTo(30 / 900, 12);
    expect(rates.TO.share.noRead).toBeNull();
    // A year with too few unverified warnings is short too, and a year with no warning is short.
    expect(noReadOf({ "2023": { warnings: 100, verified: 95, verifiedOwn: 95 } }, (count) => count.verified)).toBe("too few verified or unverified warnings in a year (2023: 95 verified of 100)");
    expect(noReadOf({ "2023": { warnings: 0, verified: 0, verifiedOwn: 0 } }, (count) => count.verified)).toMatch(/2023: 0 verified of 0/);
    // The limit itself reads.
    const edge = { "2023": { warnings: 2 * MIN_YEAR_COUNT, verified: MIN_YEAR_COUNT, verifiedOwn: MIN_YEAR_COUNT - 1 } };
    expect(noReadOf(edge, (count) => count.verified)).toBeNull();
    expect(noReadOf(edge, (count) => count.verifiedOwn)).not.toBeNull();
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

  it("keeps the counts of an extreme wind warning with the reason, and no share for it", () => {
    const file = ratesFile(input([60, 70, 80], [1, 2, 6], { ...tally([60, 70, 80]), EW: counts([0, 0, 0], 8) }));
    expect(Object.keys(file.cow.phenomena)).toEqual([...COW_PHENOMENA]);
    expect(file.cow.phenomena).not.toHaveProperty("EW");
    expect(file.cow.unverified.EW).toMatchObject({ kind: "met.wind.extreme", warnings: 24, verified: 0, reason: COW_UNVERIFIED.EW.reason, instead: COW_UNVERIFIED.EW.instead });
    expect(file.cow.unverified.EW.sources.length).toBeGreaterThan(0);
    expect(file.cow.unverified.EW).not.toHaveProperty("share");
    expect(Object.keys(file.cow.unverified.EW.byYear)).toEqual(["2023", "2024", "2025"]);
    expect([...gatedValues(file).keys()].filter((path) => path.startsWith("cow.EW"))).toEqual([]);
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
    expect(checkRates(committed, committed)).toEqual({ breaks: [], noReads: [] });
    expect(checkRates(committed, ratesFile(input([62, 70, 79], [2, 2, 5])))).toEqual({ breaks: [], noReads: [] });
  });

  it("stops a value out of its interval", () => {
    const { breaks, noReads } = checkRates(committed, ratesFile(input([90, 85, 89], [1, 2, 6])));
    expect(noReads).toEqual([]);
    expect(breaks.map((item) => item.path)).toEqual(COW_PHENOMENA.flatMap((phenomenon) => [`cow.${phenomenon}.ownShare`, `cow.${phenomenon}.share`]).sort());
    const share = breaks.find((item) => item.path === "cow.TO.share");
    expect(share?.value).toBeCloseTo(264 / 300, 12);
    expect(share?.gate).toEqual(committed.cow.phenomena.TO.share.gate);
  });

  it("stops a new type with deaths or injuries, and a type that goes away", () => {
    const fresh = ratesFile(input([60, 70, 80], [1, 2, 6]));
    const added: RatesFile = { ...fresh, ncei: { ...fresh.ncei, types: { ...fresh.ncei.types, Tsunami: { ...(fresh.ncei.types["Tornado"] as RatesFile["ncei"]["types"][string]), kind: "geo.tsunami" } } } };
    expect(checkRates(committed, added).breaks.map((item) => item.path)).toEqual(["ncei.Tsunami.deaths", "ncei.Tsunami.injuries"]);
    const { Tornado: _, ...rest } = fresh.ncei.types;
    const removed: RatesFile = { ...fresh, ncei: { ...fresh.ncei, types: rest } };
    expect(checkRates(committed, removed).breaks).toEqual([
      { path: "ncei.Tornado.deaths", value: 0, gate: committed.ncei.types["Tornado"]?.deaths.gate },
      { path: "ncei.Tornado.injuries", value: 0, gate: committed.ncei.types["Tornado"]?.injuries.gate },
    ]);
  });

  it("gives no read, not a pass and not a break, for a share with a short year in either file", () => {
    // The new SQ share is far out of the gate interval, but its years are short: the gate cannot read it.
    const short = ratesFile(input([60, 70, 80], [1, 2, 6], { ...tally([60, 70, 80]), SQ: counts([0, 0, 30]) }));
    const fresh = checkRates(committed, short);
    expect(fresh.breaks).toEqual([]);
    expect(fresh.noReads.map((item) => item.path)).toEqual(["cow.SQ.ownShare", "cow.SQ.share"]);
    expect(fresh.noReads[1]?.reason).toBe("the new measure has too few verified or unverified warnings in a year (2023: 0 verified of 100, 2024: 0 verified of 100)");
    // A short year in the committed file gives no read too, with the counts of that file.
    const before = checkRates(short, committed);
    expect(before.breaks).toEqual([]);
    expect(before.noReads.map((item) => item.reason)).toEqual([expect.stringMatching(/^the committed file has /), expect.stringMatching(/^the committed file has /)]);
  });
});

describe("the summary", () => {
  const file = ratesFile(input([60, 70, 80], [1, 2, 6]));

  it("tells the shares, the types, the bands and the result of the gate", () => {
    const text = ratesSummary(file, { committed: false });
    expect(text).toContain("| TO Tornado | `met.tornado` | 300 | 210 | 70.0% |");
    expect(text).toMatch(/\| TO Tornado .* \| reads \|\n/);
    expect(text).toContain("| Tornado | `met.tornado` | 15 | 9 | 3 (");
    expect(text).toContain("| Drought | none |");
    expect(text).toContain("does not have these types: Space Weather.");
    expect(text).toContain(`| likely | ${escapeMarkdown("Likely (p > ~50%)")} | (0.5, 1], approximate |`);
    expect(text).toContain("There is no committed file.");
    expect(ratesSummary(file, { committed: true, breaks: [], noReads: [] })).toContain("Each value is in the gate interval");
    expect(ratesSummary(file, { committed: true, breaks: [{ path: "cow.TO.share", value: 0.9, gate: [0.6, 0.8] }], noReads: [] })).toContain(`| ${escapeMarkdown("cow.TO.share")} | 0.9 | 0.6 to 0.8 |`);
  });

  it("tells the phenomena that Cow does not verify, with the reason and the evidence", () => {
    const text = ratesSummary(file, { committed: false });
    expect(text).toContain("### The phenomena that Cow does not verify");
    expect(text).toContain("**EW Extreme Wind** (`met.wind.extreme`)");
    for (const source of COW_UNVERIFIED.EW.sources) expect(text).toContain(`  - ${escapeMarkdown(source)}`);
  });

  it("tells each no read apart from the breaks, and a no read is not a pass", () => {
    const noReads = [{ path: "cow.SQ.share", reason: "the new measure has too few verified or unverified warnings in a year (2023: 0 verified of 100)" }];
    const text = ratesSummary(file, { committed: true, breaks: [], noReads });
    expect(text).toContain("Each value that the gate reads is in the gate interval");
    expect(text).not.toContain("Each value is in the gate interval");
    expect(text).toContain("**No read:** the gate cannot read 1 values. A no read is not a pass.");
    expect(text).toContain(`| ${escapeMarkdown("cow.SQ.share")} | ${escapeMarkdown(noReads[0]!.reason)} |`);
  });
});
