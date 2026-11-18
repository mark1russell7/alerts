/**
 * The years of the measures. Each measure uses whole years that end before the time of the run. A
 * source publishes the data of a year some months after its end. Thus each source has a lag in
 * months.
 */

/** A range of whole years, from `first` to `last`. */
export interface Years {
  readonly first: number;
  readonly last: number;
}

/** The years of the Cow measure: 5 years. The storm reports of a month are complete approximately 2 months after the month. */
export const COW_YEARS = { count: 5, lagMonths: 2 } as const;

/** The years of the NCEI measure: 10 years. NCEI completes the events of a year approximately 6 months after the year. */
export const NCEI_YEARS = { count: 10, lagMonths: 6 } as const;

/** The years of the measure of the harm under an alert: 5 years. The join needs the events of NCEI, so it has the lag of NCEI. */
export const ALERT_YEARS = { count: 5, lagMonths: 6 } as const;

/**
 * This function gives the last whole year of a source at the time `now`. It is the year before the
 * month that is `lagMonths` before `now`, in UTC.
 */
export function lastFullYear(now: number, lagMonths: number): number {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - lagMonths, 1)).getUTCFullYear() - 1;
}

/** This function gives the `count` years of a source that end at its last whole year at the time `now`. */
export function measureYears(now: number, rule: { readonly count: number; readonly lagMonths: number }): Years {
  const last = lastFullYear(now, rule.lagMonths);
  return { first: last - rule.count + 1, last };
}

/** This function reads a range of years in the form `2021-2025`, or one year in the form `2025`. */
export function parseYears(text: string): Years {
  const match = /^(\d{4})(?:-(\d{4}))?$/.exec(text.trim());
  if (match === null) throw new Error(`The years ${JSON.stringify(text)} are not in the form 2021-2025.`);
  const first = Number(match[1]);
  const last = Number(match[2] ?? match[1]);
  if (first > last) throw new Error(`The years ${JSON.stringify(text)} are not in order.`);
  return { first, last };
}

/** This function gives each year of a range, in order. */
export function eachYear(years: Years): number[] {
  return Array.from({ length: years.last - years.first + 1 }, (_, index) => years.first + index);
}
