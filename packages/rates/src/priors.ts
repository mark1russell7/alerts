/**
 * The priors of the shadow score (`ScorePriors`, format `alerts-priors/1`) from the file of the base rates. This is
 * step 2c of AL-31. The function is pure, so the same file of rates gives the same priors, bit for bit.
 *
 * - The verified share of a kind comes from Cow (`ownShare`). It is the share of the warnings that a storm report of
 *   the same hazard verified. The interval is the gate interval of the share. A share with a reason of no read gives no
 *   prior.
 * - The deaths and the injuries of one event of a kind come from NCEI. Each is its count over its events, summed over
 *   the types of the kind. The interval is the percentile bootstrap over the years. A kind with too few
 *   counts or events gives no prior.
 * - The probability of each CAP certainty word is the middle of its band, and the interval is the band.
 *
 * A field with no prior is absent. Then the shadow score of a kind with that field has no read. It does not take 0.
 */

import { PRIORS_FORMAT, type Certainty, type Estimate, type KindPrior, type ScorePriors } from "@mark1russell7/alerts";
import { bootstrap } from "@mark1russell7/rigor-statistics";

import { BOOTSTRAP_RUNS, LEVEL, type RatesFile, type Share } from "./rates.ts";

/**
 * The least count of deaths or injuries, and the least count of events, of a kind for a prior of one event. With fewer,
 * the kind has no prior for that count. The value follows `MIN_YEAR_COUNT` of the shares.
 *
 * This limit is a shortcut. A bootstrap of 10 years gives a narrow interval for a small count, and an exact Poisson
 * interval does not exist in `@mark1russell7/rigor-statistics` at this time. When it exists, its interval joins the
 * hull, and a small count gets a prior with a wide interval.
 */
export const MIN_RATE_COUNT = 10;

/** The CAP certainty words, in the order of the contract. */
const CERTAINTIES: readonly Certainty[] = ["observed", "likely", "possible", "unlikely", "unknown"];

/** The counts of the events of one kind in one year, summed over the event types of the kind. */
interface KindYear {
  readonly events: number;
  readonly deaths: number;
  readonly injuries: number;
}

/** This function gives the prior of a verified share, or undefined when the gate cannot read the share. */
function verifiedOf(share: Share): Estimate | undefined {
  if (share.noRead !== null) return undefined;
  return { value: share.value, low: share.gate[0], high: share.gate[1] };
}

/**
 * This function gives the count of one event of a kind, with the percentile bootstrap interval over the years. It gives
 * undefined when the kind has fewer than `MIN_RATE_COUNT` events or counts. The hull holds the value.
 */
function perEventOf(years: readonly KindYear[], part: "deaths" | "injuries", seed: string): Estimate | undefined {
  const events = years.reduce((sum, year) => sum + year.events, 0);
  const count = years.reduce((sum, year) => sum + year[part], 0);
  if (events < MIN_RATE_COUNT || count < MIN_RATE_COUNT) return undefined;
  const value = count / events;
  const drawn = bootstrap(years, (sample) => sample.reduce((sum, year) => sum + year[part], 0) / sample.reduce((sum, year) => sum + year.events, 0), {
    runs: BOOTSTRAP_RUNS,
    level: LEVEL,
    seed,
  });
  return { value, low: Math.min(drawn.low, value), high: Math.max(drawn.high, value) };
}

/** This function gives the counts of each kind in each year of NCEI, summed over the event types of the kind. Each year of the file has a row. */
function nceiYears(rates: RatesFile): Map<string, KindYear[]> {
  const years: string[] = [];
  for (let year = rates.ncei.years.first; year <= rates.ncei.years.last; year += 1) years.push(String(year));
  const kinds = new Map<string, Map<string, { events: number; deaths: number; injuries: number }>>();
  for (const type of Object.keys(rates.ncei.types).sort()) {
    const rate = rates.ncei.types[type];
    if (rate === undefined || rate.kind === null) continue;
    let byYear = kinds.get(rate.kind);
    if (byYear === undefined) {
      byYear = new Map(years.map((year) => [year, { events: 0, deaths: 0, injuries: 0 }]));
      kinds.set(rate.kind, byYear);
    }
    for (const [year, count] of Object.entries(rate.byYear)) {
      const sum = byYear.get(year);
      if (sum === undefined) throw new Error(`The NCEI type ${type} has the year ${year}, out of the years of the file.`);
      sum.events += count.events;
      sum.deaths += count.deaths;
      sum.injuries += count.injuries;
    }
  }
  return new Map([...kinds].map(([kind, byYear]) => [kind, [...byYear.values()]]));
}

/**
 * This function gives the priors of the shadow score from a file of the base rates. The keys of `kinds` are in the
 * order of the codes, so the JSON text of the priors is stable. It throws an error when two Cow phenomena have the
 * same kind, or when the CAP bands do not have each certainty word.
 */
export function priorsOf(rates: RatesFile): ScorePriors {
  const kinds = new Map<string, { -readonly [K in keyof KindPrior]: KindPrior[K] }>();
  const entry = (kind: string): { -readonly [K in keyof KindPrior]: KindPrior[K] } => {
    let prior = kinds.get(kind);
    if (prior === undefined) {
      prior = {};
      kinds.set(kind, prior);
    }
    return prior;
  };

  const shareKinds = new Set<string>();
  for (const rate of Object.values(rates.cow.phenomena)) {
    if (shareKinds.has(rate.kind)) throw new Error(`Two Cow phenomena have the kind ${rate.kind}.`);
    shareKinds.add(rate.kind);
    const verified = verifiedOf(rate.ownShare);
    if (verified !== undefined) entry(rate.kind).verified = verified;
  }

  for (const [kind, years] of nceiYears(rates)) {
    const deaths = perEventOf(years, "deaths", `priors/${kind}/deaths`);
    const injuries = perEventOf(years, "injuries", `priors/${kind}/injuries`);
    if (deaths !== undefined) entry(kind).deaths = deaths;
    if (injuries !== undefined) entry(kind).injuries = injuries;
  }

  const certainty: Partial<Record<Certainty, Estimate>> = {};
  for (const word of CERTAINTIES) {
    const band = rates.cap.bands[word];
    if (band === undefined) throw new Error(`The CAP bands have no certainty ${word}.`);
    certainty[word] = { value: (band.low + band.high) / 2, low: band.low, high: band.high };
  }

  const sorted = [...kinds].filter(([, prior]) => Object.keys(prior).length > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { format: PRIORS_FORMAT, kinds: Object.fromEntries(sorted), certainty };
}
