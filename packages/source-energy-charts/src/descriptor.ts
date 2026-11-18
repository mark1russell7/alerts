/**
 * The descriptor of the Energy-Charts source: the facts that the core uses for the schedule, the health and the
 * indicator measures.
 */

import type { MeasureDeclaration, SourceDescriptor } from "@mark1russell7/alerts";

import { ENERGY_CHARTS_ORIGIN, FREQUENCY_MAX, FREQUENCY_MIN, FREQUENCY_UNIT, MINUTE_MS, SOURCE_ID } from "./map.ts";

/**
 * The time from the start of a minute to the publication of its last second. Twenty reads on 2026-11-18 found the newest
 * second 32 to 114 seconds old. Thus a minute is complete at most 174 seconds after its start. The delay changes with the
 * load of the server, so the value is 4 minutes.
 */
export const MEASURE_DELAY_MS: number = 4 * MINUTE_MS;

/** The time between two fetches. Each fetch asks for 10 minutes, at a quarter of the published limit of the API. */
export const FETCH_INTERVAL_MS: number = 2 * MINUTE_MS;

/** The two measures of the source: the lowest and the highest grid frequency of each minute. */
export const ENERGY_CHARTS_MEASURES: readonly MeasureDeclaration[] = [
  {
    id: FREQUENCY_MIN,
    dimension: "grid-frequency",
    title: "The lowest grid frequency of each minute in Continental Europe",
    unit: FREQUENCY_UNIT,
    area: "zone",
    moves: "drop",
    baseline: "none",
    cadence: MINUTE_MS,
    delay: MEASURE_DELAY_MS,
  },
  {
    id: FREQUENCY_MAX,
    dimension: "grid-frequency",
    title: "The highest grid frequency of each minute in Continental Europe",
    unit: FREQUENCY_UNIT,
    area: "zone",
    moves: "rise",
    baseline: "none",
    cadence: MINUTE_MS,
    delay: MEASURE_DELAY_MS,
  },
];

/**
 * The descriptor of the Energy-Charts source. The source gives indicator readings and no event, so it has no kind and
 * no coverage of events. The API answers from one server of Fraunhofer ISE, with no CDN. A fetch with no recent minute
 * tells of an old series.
 */
export const ENERGY_CHARTS_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "Energy-Charts: the grid frequency of Continental Europe, each second, from the meter of Fraunhofer ISE",
  origins: [ENERGY_CHARTS_ORIGIN],
  dependsOn: ["provider:energy-charts"],
  uses: ["internet", "dns", "power"],
  kinds: [],
  coverage: [],
  transport: "poll",
  interval: FETCH_INTERVAL_MS,
  slowAfter: 10_000,
  maxQuiet: 10 * MINUTE_MS,
  auth: "none",
  canary: "The meter gives a value each second. The check passes when the newest complete minute started at most 6 minutes before the fetch.",
  measures: ENERGY_CHARTS_MEASURES,
};
