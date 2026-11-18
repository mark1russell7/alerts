/**
 * The file of the base rates: the measures of Cow and NCEI with their intervals, and the CAP
 * certainty bands. The file holds only national sums by type. It does not hold a row of a state.
 *
 * Each measure has a value, an interval and the interval of the gate. The gate interval is the hull
 * of the intervals of the measure and its value. The workflow compares each new value with the gate
 * interval of the committed file. A share with too few verified or unverified warnings in a year has
 * a reason of no read. The gate does not read it.
 *
 * Cow links no storm report to the phenomena of `COW_UNVERIFIED`. The file keeps their counts with
 * the reason, and it has no share for them.
 *
 * The section `under` has the alerts of each kind and significance, and the harm under an active alert
 * (`under.ts`). It holds national sums only. The gate does not read it at this time.
 */

import { CAP_CERTAINTY_BANDS, CAP_CERTAINTY_SOURCE, type CertaintyBand } from "@mark1russell7/alerts-format-cap";
import { bootstrap, mean, wilson } from "@mark1russell7/rigor-statistics";

import {
  COW_PHENOMENA,
  COW_UNVERIFIED,
  COW_UNVERIFIED_PHENOMENA,
  COW_URL,
  phenomenonKind,
  type CowCount,
  type CowPhenomenon,
  type CowQueryPhenomenon,
  type CowTally,
  type CowUnverified,
  type CowUnverifiedPhenomenon,
} from "./cow.ts";
import { NCEI_FOLDER_URL, nceiKind, type DetailsFile, type Harm, type YearHarm } from "./ncei.ts";
import { underSection, type UnderInput, type UnderSection } from "./under.ts";
import { eachYear, type Years } from "./years.ts";

/**
 * The format of the file. A change of its structure gives a new number. Format 2 adds the no reads and the unverified
 * phenomena. Format 3 adds the section `under`: the alerts of each kind and the harm under an active alert. Format 4
 * gives the areas of the alerts and the harm in them, in counties and in zones, in each year (`UnderRate.byArea`).
 */
export const RATES_FORMAT = "alerts-rates/4";

/** The level of each interval. */
export const LEVEL = 0.95;

/** The count of the draws of each bootstrap. */
export const BOOTSTRAP_RUNS = 10_000;

/**
 * The least count of verified warnings, and of warnings with no verification, in each year of a share. With fewer in a
 * year, the gate cannot read the share. With 10 or more of each, the normal approximation of a share holds: n p >= 10
 * and n (1 - p) >= 10.
 */
export const MIN_YEAR_COUNT = 10;

/** An interval, from `low` to `high`. */
export type Range = readonly [low: number, high: number];

/** A share of the warnings, with its intervals. */
export interface Share {
  /** The share: the verified warnings divided by all the warnings. */
  readonly value: number;
  /** The Wilson interval of the share. It holds the noise of the counts. */
  readonly wilson: Range;
  /** The percentile bootstrap interval of the share over the years. It holds the change from year to year. */
  readonly overYears: Range;
  /** The hull of `wilson`, `overYears` and `value`. */
  readonly gate: Range;
  /**
   * The reason that the gate cannot read the share, with the counts of each short year. It is `null` when each year has
   * `MIN_YEAR_COUNT` or more verified and unverified warnings.
   */
  readonly noRead: string | null;
}

/** A count for each year, with its intervals. */
export interface PerYear {
  /** The mean of the counts of the years. */
  readonly value: number;
  /** The percentile bootstrap interval of the mean over the years. */
  readonly overYears: Range;
  /** The hull of `overYears` and `value`. */
  readonly gate: Range;
}

/** The Cow measure of one phenomenon. */
export interface CowRate extends CowCount {
  readonly kind: string;
  readonly label: string;
  /** The share of the warnings that one or more storm reports verified. */
  readonly share: Share;
  /** The share of the warnings that a storm report of the hazard of the warning verified. */
  readonly ownShare: Share;
  readonly byYear: Readonly<Record<string, CowCount>>;
}

/** The counts of one phenomenon that Cow does not verify, with the reason. The file has no share for it. */
export interface CowUnverifiedRate extends CowCount, CowUnverified {
  readonly kind: string;
  readonly label: string;
  readonly byYear: Readonly<Record<string, CowCount>>;
}

/** The NCEI measure of one event type. */
export interface NceiRate extends Harm {
  /** The kind of the taxonomy, or null for a type with no alert of its own. */
  readonly kind: string | null;
  /** The deaths (direct and indirect) in each year. */
  readonly deaths: PerYear;
  /** The injuries (direct and indirect) in each year. */
  readonly injuries: PerYear;
  /** The events, deaths and injuries of each year. */
  readonly byYear: Readonly<Record<string, { readonly events: number; readonly deaths: number; readonly injuries: number }>>;
}

/** The file of the base rates. */
export interface RatesFile {
  readonly format: typeof RATES_FORMAT;
  /** The time of the fetches, in ISO 8601. */
  readonly fetched: string;
  readonly level: number;
  readonly methods: Readonly<Record<string, string>>;
  readonly cow: {
    readonly url: string;
    readonly years: Years;
    /** The parameters that Cow used, from its answers. */
    readonly params: Readonly<Record<string, unknown>>;
    /** The query of each request, after `url`. */
    readonly queries: readonly string[];
    readonly phenomena: Readonly<Record<CowPhenomenon, CowRate>>;
    /** The phenomena that Cow does not verify: their counts and the reason, with no share. */
    readonly unverified: Readonly<Record<CowUnverifiedPhenomenon, CowUnverifiedRate>>;
  };
  readonly ncei: {
    readonly folder: string;
    readonly years: Years;
    readonly files: readonly DetailsFile[];
    /** The event types that `NCEI_KINDS` does not have. */
    readonly newTypes: readonly string[];
    readonly types: Readonly<Record<string, NceiRate>>;
  };
  readonly cap: {
    readonly source: typeof CAP_CERTAINTY_SOURCE;
    readonly bands: Readonly<Record<string, CertaintyBand>>;
  };
  /** The alerts of each kind and significance, and the harm under an active alert. */
  readonly under: UnderSection;
}

/** The text of the methods of the file. */
export const METHODS: Readonly<Record<string, string>> = {
  share: "The Wilson score interval of the verified warnings in all the warnings, at the level of the file.",
  overYears: `The percentile bootstrap interval over the years: ${String(BOOTSTRAP_RUNS)} draws of the years with replacement, with a fixed seed for each measure.`,
  gate: "The hull of the intervals of a measure and its value. A new value out of the gate interval of the committed file stops the workflow. A measure that a file does not have is 0 with the gate interval 0 to 0.",
  noRead: `The gate reads a share only when each year has ${String(MIN_YEAR_COUNT)} or more verified and ${String(MIN_YEAR_COUNT)} or more unverified warnings. Otherwise the gate gives no read for the share: not a pass and not a break.`,
  unverified: "Cow links no storm report to some phenomena. The file keeps their counts with the reason and the evidence, and it has no share for them.",
  cow: "One request for each month, with one day of margin before and after the month. A warning counts in the month of its start. The id of a warning counts one time.",
  ncei: "The rows of each file of details, by EVENT_TYPE. The deaths and injuries of a type are the sums of the direct and indirect counts.",
  under:
    "For each alert kind and significance: the alerts of each year, and the NCEI events of the kind with harm under an active alert. An alert is one event number of one office in one VTEC year. A national number counts one time (national). An event is under an alert when an alert row of its county or zone is active from the begin of the event minus marginMs to its end. NCEI gives its own state codes to the territories and the waters, and the join reads them (NCEI_TERRITORIES, NCEI_WATERS). A water event meets only the rows of its marine zone. A county event meets only county rows, and a zone event meets only zone rows. The gate does not read this section.",
  windows: "One request for each month, and one month before the first year. The service selects a row by its start, so two windows have no common row. An alert counts in the VTEC year of its number.",
};

const hull = (...ranges: readonly Range[]): Range => [Math.min(...ranges.map((range) => range[0])), Math.max(...ranges.map((range) => range[1]))];

/**
 * This function gives the reason that the gate cannot read the share of `part`, or `null`. The reason names each year with
 * fewer than `MIN_YEAR_COUNT` verified or unverified warnings.
 */
export function noReadOf(byYear: Readonly<Record<string, CowCount>>, part: (count: CowCount) => number): string | null {
  const short = Object.entries(byYear).filter(([, count]) => part(count) < MIN_YEAR_COUNT || count.warnings - part(count) < MIN_YEAR_COUNT);
  if (short.length === 0) return null;
  const counts = short.map(([year, count]) => `${year}: ${String(part(count))} verified of ${String(count.warnings)}`).join(", ");
  return `too few verified or unverified warnings in a year (${counts})`;
}

/** This function gives the share of `part` in the warnings of each year, with its intervals. */
function share(byYear: Readonly<Record<string, CowCount>>, part: (count: CowCount) => number, seed: string): Share {
  const years = Object.values(byYear);
  const k = years.reduce((sum, count) => sum + part(count), 0);
  const n = years.reduce((sum, count) => sum + count.warnings, 0);
  const value = k / n;
  const score = wilson(k, n);
  const drawn = bootstrap(years, (sample) => sample.reduce((sum, count) => sum + part(count), 0) / sample.reduce((sum, count) => sum + count.warnings, 0), {
    runs: BOOTSTRAP_RUNS,
    level: LEVEL,
    seed,
  });
  const wilsonRange: Range = [score.low, score.high];
  const overYears: Range = [drawn.low, drawn.high];
  return { value, wilson: wilsonRange, overYears, gate: hull(wilsonRange, overYears, [value, value]), noRead: noReadOf(byYear, part) };
}

/** This function gives the mean of the counts of the years, with its intervals. */
function perYear(counts: readonly number[], seed: string): PerYear {
  const value = mean(counts);
  const drawn = bootstrap(counts, mean, { runs: BOOTSTRAP_RUNS, level: LEVEL, seed });
  const overYears: Range = [drawn.low, drawn.high];
  return { value, overYears, gate: hull(overYears, [value, value]) };
}

/**
 * This function gives the Cow measure of each phenomenon. It throws an error when a phenomenon has
 * no warning in the years: a national measure of 5 years always has warnings.
 */
export function cowRates(tally: Readonly<Record<CowPhenomenon, CowTally>>, years: Years): Record<CowPhenomenon, CowRate> {
  return Object.fromEntries(
    COW_PHENOMENA.map((phenomenon) => {
      const total = tally[phenomenon];
      if (total.warnings === 0) throw new Error(`Cow gave no ${phenomenon} warning in ${String(years.first)} to ${String(years.last)}.`);
      const byYear = yearCounts(total, years);
      const rate: CowRate = {
        ...phenomenonKind(phenomenon),
        warnings: total.warnings,
        verified: total.verified,
        verifiedOwn: total.verifiedOwn,
        share: share(byYear, (count) => count.verified, `cow/${phenomenon}/share`),
        ownShare: share(byYear, (count) => count.verifiedOwn, `cow/${phenomenon}/own`),
        byYear,
      };
      return [phenomenon, rate];
    }),
  ) as Record<CowPhenomenon, CowRate>;
}

/** This function gives the counts of each year of the years. A year with no warning counts as 0. */
function yearCounts(total: CowTally, years: Years): Record<string, CowCount> {
  const zero: CowCount = { warnings: 0, verified: 0, verifiedOwn: 0 };
  return Object.fromEntries(eachYear(years).map((year) => [String(year), total.byYear[String(year)] ?? zero]));
}

/**
 * This function gives the counts of each phenomenon that Cow does not verify, with the reason and the evidence of
 * `COW_UNVERIFIED`. The counts are a note: the file has no share for these phenomena.
 */
export function cowUnverifiedRates(tally: Readonly<Record<CowUnverifiedPhenomenon, CowTally>>, years: Years): Record<CowUnverifiedPhenomenon, CowUnverifiedRate> {
  return Object.fromEntries(
    COW_UNVERIFIED_PHENOMENA.map((phenomenon) => {
      const total = tally[phenomenon];
      const rate: CowUnverifiedRate = {
        ...phenomenonKind(phenomenon),
        ...COW_UNVERIFIED[phenomenon],
        warnings: total.warnings,
        verified: total.verified,
        verifiedOwn: total.verifiedOwn,
        byYear: yearCounts(total, years),
      };
      return [phenomenon, rate];
    }),
  ) as Record<CowUnverifiedPhenomenon, CowUnverifiedRate>;
}

/**
 * This function gives the NCEI measure of each event type over the years. A year with no row of a
 * type counts as 0. It throws an error when a year has no file or not 12 months.
 */
export function nceiRates(harms: readonly YearHarm[], years: Years): { types: Record<string, NceiRate>; newTypes: string[] } {
  const all = eachYear(years);
  const byYear = new Map(harms.map((harm) => [harm.year, harm]));
  for (const year of all) {
    const harm = byYear.get(year);
    if (harm === undefined) throw new Error(`The NCEI measure has no file of ${String(year)}.`);
    if (harm.months.length !== 12) throw new Error(`The NCEI file of ${String(year)} has events in ${String(harm.months.length)} months, not 12.`);
  }
  const names = [...new Set(all.flatMap((year) => Object.keys((byYear.get(year) as YearHarm).types)))].sort();
  const types: Record<string, NceiRate> = {};
  for (const name of names) {
    const yearly = all.map((year) => (byYear.get(year) as YearHarm).types[name] ?? { events: 0, deathsDirect: 0, deathsIndirect: 0, injuriesDirect: 0, injuriesIndirect: 0 });
    const sum = (field: keyof Harm): number => yearly.reduce((total, harm) => total + harm[field], 0);
    const deaths = yearly.map((harm) => harm.deathsDirect + harm.deathsIndirect);
    const injuries = yearly.map((harm) => harm.injuriesDirect + harm.injuriesIndirect);
    types[name] = {
      kind: nceiKind(name) ?? null,
      events: sum("events"),
      deathsDirect: sum("deathsDirect"),
      deathsIndirect: sum("deathsIndirect"),
      injuriesDirect: sum("injuriesDirect"),
      injuriesIndirect: sum("injuriesIndirect"),
      deaths: perYear(deaths, `ncei/${name}/deaths`),
      injuries: perYear(injuries, `ncei/${name}/injuries`),
      byYear: Object.fromEntries(all.map((year, index) => [String(year), { events: (yearly[index] as Harm).events, deaths: deaths[index] as number, injuries: injuries[index] as number }])),
    };
  }
  return { types, newTypes: names.filter((name) => nceiKind(name) === undefined) };
}

/** The inputs of `ratesFile`. */
export interface RatesInput {
  readonly fetched: number;
  readonly cow: {
    readonly years: Years;
    readonly params: Readonly<Record<string, unknown>>;
    readonly queries: readonly string[];
    readonly tally: Readonly<Record<CowQueryPhenomenon, CowTally>>;
  };
  readonly ncei: {
    readonly years: Years;
    readonly files: readonly DetailsFile[];
    readonly harms: readonly YearHarm[];
  };
  readonly under: UnderInput;
}

/** This function makes the file of the base rates from the sums of the sources. */
export function ratesFile(input: RatesInput): RatesFile {
  const ncei = nceiRates(input.ncei.harms, input.ncei.years);
  return {
    format: RATES_FORMAT,
    fetched: new Date(input.fetched).toISOString(),
    level: LEVEL,
    methods: METHODS,
    cow: {
      url: COW_URL,
      years: input.cow.years,
      params: input.cow.params,
      queries: input.cow.queries,
      phenomena: cowRates(input.cow.tally, input.cow.years),
      unverified: cowUnverifiedRates(input.cow.tally, input.cow.years),
    },
    ncei: { folder: NCEI_FOLDER_URL, years: input.ncei.years, files: input.ncei.files, newTypes: ncei.newTypes, types: ncei.types },
    cap: { source: CAP_CERTAINTY_SOURCE, bands: CAP_CERTAINTY_BANDS },
    under: underSection(input.under),
  };
}
