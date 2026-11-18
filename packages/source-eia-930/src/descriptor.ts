/**
 * The descriptor of the EIA-930 source: the facts that the core uses for the schedule, the health and the indicator
 * measures.
 */

import type { MeasureDeclaration, SourceDescriptor } from "@mark1russell7/alerts";

import { BACKFILL_MS } from "./fetch.ts";
import { DEMAND, DEMAND_UNIT, EIA_ORIGIN, HOUR_MS, SOURCE_ID } from "./map.ts";

/**
 * The time from the end of an hour to the publication of its demand. On 2026-11-18 at 18:47 UTC, the newest hour of each
 * balancing authority ended at 18:00 UTC. Some authorities send an hour later, so the value is 2 hours.
 */
export const MEASURE_DELAY_MS: number = 2 * HOUR_MS;

/** The time between two fetches. A new hour comes each hour, so a fetch each 15 minutes gets it at most 15 minutes late. */
export const FETCH_INTERVAL_MS: number = HOUR_MS / 4;

/** The measure of the source: the demand of each hour of each balancing authority, with its day-ahead forecast. */
export const EIA_930_MEASURES: readonly MeasureDeclaration[] = [
  {
    id: DEMAND,
    dimension: "power-demand",
    title: "The electric demand of each hour of a balancing authority of the United States",
    unit: DEMAND_UNIT,
    area: "zone",
    moves: "both",
    baseline: "expected",
    cadence: HOUR_MS,
    delay: MEASURE_DELAY_MS,
    backfill: BACKFILL_MS,
  },
];

/**
 * The descriptor of the EIA-930 source. The source gives indicator readings and no event, so it has no kind and no
 * coverage of events. The host `api.eia.gov` is a name of the API gateway `api.data.gov`, so the source needs the two.
 */
export const EIA_930_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "EIA-930: the hourly electric demand and its day-ahead forecast of each balancing authority of the United States",
  origins: [EIA_ORIGIN],
  dependsOn: ["provider:eia", "provider:api-data-gov"],
  uses: ["internet", "dns", "power"],
  kinds: [],
  coverage: [],
  transport: "poll",
  interval: FETCH_INTERVAL_MS,
  slowAfter: 20_000,
  maxQuiet: MEASURE_DELAY_MS + HOUR_MS,
  auth: "key",
  canary: "Each balancing authority sends its demand each hour. The check passes when the newest hour with a real demand ended at most 3 hours before the fetch. A demand that equals its forecast is a placeholder, not a real demand.",
  measures: EIA_930_MEASURES,
};
