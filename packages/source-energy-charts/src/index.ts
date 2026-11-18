/**
 * The Energy-Charts source of the alert system: the grid frequency of Continental Europe, from the meter of Fraunhofer
 * ISE in Freiburg. Each minute gives two indicator readings, its lowest and its highest value, and no report. The data
 * is under the license CC BY 4.0, with the credit energy-charts.info.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { ENERGY_CHARTS_DESCRIPTOR } from "./descriptor.ts";
import { createEnergyChartsFetch, type EnergyChartsFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { checkCanary, NEWEST_MAX_AGE_MS } from "./check.ts";
export { ENERGY_CHARTS_DESCRIPTOR, ENERGY_CHARTS_MEASURES, FETCH_INTERVAL_MS, MEASURE_DELAY_MS } from "./descriptor.ts";
export { createEnergyChartsFetch, ENERGY_CHARTS_BASE_URL, FREQUENCY_PATH, MIN_INTERVAL_MS, queryPath, readAnswer, WINDOW_MINUTES } from "./fetch.ts";
export type { EnergyChartsFetchInput, EnergyChartsFetchOptions, Read } from "./fetch.ts";
export {
  ENERGY_CHARTS_CREDIT,
  ENERGY_CHARTS_LICENSE,
  ENERGY_CHARTS_ORIGIN,
  FREQUENCY_MAX,
  FREQUENCY_MIN,
  FREQUENCY_REGION,
  FREQUENCY_UNIT,
  mapObservation,
  minuteBody,
  MINUTE_FIELDS,
  MINUTE_MS,
  minuteStart,
  minuteText,
  SECONDS,
  SOURCE_ID,
  SYNCHRONOUS_AREA,
} from "./map.ts";
export type { MinuteBody } from "./map.ts";

/**
 * This function makes the procedures of the Energy-Charts source. The source has a canary: the age of the newest
 * minute. It has no `locate`: the source asks for no point.
 */
export function createEnergyChartsSource(options: EnergyChartsFetchOptions): SourceProcedures {
  const fetch = createEnergyChartsFetch(options);
  return {
    describe: () => ENERGY_CHARTS_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
