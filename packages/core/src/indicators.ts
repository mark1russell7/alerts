/**
 * The checks of the indicator contract. An indicator is a measure that is not an event, for example road traffic,
 * rail delays or grid frequency. A measure becomes a signal when it leaves its normal level.
 *
 * - A source declares each measure in the field `measures` of its descriptor. The schema of the descriptor checks them.
 * - A reading is one value of one series of a measure. The schema checks its form, and `readingProblems` checks it against its measure.
 * - `seriesKey` gives the key of the history of a series. The key holds the version, so a baseline does not cross a change of method.
 *
 * The types are in `contracts.ts`. `docs/CONTRACTS.md` explains them.
 */
import { kindOf } from "@mark1russell7/quantity";
import { DIMENSION_IDS, type DimensionId, type MeasureDeclaration, type Reading, type SourceDescriptor } from "./contracts.ts";

/** The form of the id of a measure: small letters, digits and hyphens, with a letter first, 40 characters or fewer. */
export const MEASURE_ID: RegExp = /^[a-z][a-z0-9-]{0,39}$/u;

/** The form of the version of a series: letters, digits, dots and hyphens, with a letter or a digit first, 40 characters or fewer. */
export const SERIES_VERSION: RegExp = /^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/u;

// The kinds of quantity whose values are 0 or more: a count, and a count in each unit of time.
const NOT_NEGATIVE = new Set(["count", "frequency"]);

/** This function tells if a text is the id of a dimension of `DIMENSIONS`. */
export function isDimensionId(text: string): text is DimensionId {
  return DIMENSION_IDS.some((id) => id === text);
}

/** This function gives the declaration of the measure of a reading, or undefined when the source does not declare it. */
export function measureOf(reading: Reading, source: SourceDescriptor): MeasureDeclaration | undefined {
  return reading.source === source.id ? source.measures?.find((measure) => measure.id === reading.measure) : undefined;
}

/**
 * This function checks a reading against the declaration of its measure. The schema checks the form of the reading
 * first. This check finds the rules that need the declaration: the area kind, the baseline and the sign of a count.
 */
export function readingProblems(reading: Reading, source: SourceDescriptor): string[] {
  const measure = measureOf(reading, source);
  if (measure === undefined) return [`The source ${source.id} declares no measure ${reading.measure}.`];
  const name = `A reading of the measure ${measure.id} of ${source.id}`;
  const problems: string[] = [];
  if (reading.area.type !== measure.area) problems.push(`${name} has an area of the kind ${reading.area.type}, and the measure declares ${measure.area}.`);
  if ((measure.baseline === "expected") !== (reading.expected !== undefined)) {
    problems.push(measure.baseline === "expected" ? `${name} has no expected value, and its measure has the baseline expected.` : `${name} has an expected value, and its measure has the baseline ${measure.baseline}.`);
  }
  if ((measure.baseline === "flag") !== (reading.flagged !== undefined)) {
    problems.push(measure.baseline === "flag" ? `${name} has no flag, and its measure has the baseline flag.` : `${name} has a flag, and its measure has the baseline ${measure.baseline}.`);
  }
  if (reading.value < 0 && NOT_NEGATIVE.has(kindOf(measure.unit))) problems.push(`${name} has a value below 0, and its unit ${measure.unit} counts.`);
  return problems;
}

/**
 * This function gives the key of the history of the series of a reading: the source, the measure, the series and the
 * version. Two readings have one key only when they are values of one series with one method.
 */
export function seriesKey(reading: Reading): string {
  return JSON.stringify([reading.source, reading.measure, reading.series, reading.version ?? ""]);
}
