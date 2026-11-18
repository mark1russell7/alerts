/**
 * The EIA-930 source of the alert system: the hourly demand of each balancing authority of the United States, with its
 * day-ahead forecast. The data comes from the Hourly Electric Grid Monitor of the U.S. Energy Information Administration. Each hour
 * gives one indicator reading and no report. The data of EIA is in the public domain. Its reuse policy asks for the
 * credit `EIA_CREDIT` with the date of the data.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { EIA_930_DESCRIPTOR } from "./descriptor.ts";
import { createEia930Fetch, type Eia930FetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { checkCanary, NEWEST_MAX_AGE_MS } from "./check.ts";
export { EIA_930_DESCRIPTOR, EIA_930_MEASURES, FETCH_INTERVAL_MS, MEASURE_DELAY_MS } from "./descriptor.ts";
export {
  BACKFILL_MS,
  coveredOf,
  createEia930Fetch,
  cursorOf,
  DATA_PATH,
  DATE_FORMAT,
  EIA_BASE_URL,
  failureOfRequest,
  hoursOf,
  KEY_ERROR_CODES,
  LIVE_HOURS,
  MAX_PAGES,
  MAX_ROWS,
  MIN_INTERVAL_MS,
  PAGE_HOURS,
  queryPath,
  readPage,
  TIMEOUT_MS,
} from "./fetch.ts";
export type { Covered, Eia930FetchInput, Eia930FetchOptions, Hours, Page } from "./fetch.ts";
export {
  AGGREGATE_RESPONDENTS,
  API_UNIT,
  DEMAND,
  DEMAND_UNIT,
  EIA_CREDIT,
  EIA_ORIGIN,
  hourBody,
  HOUR_FIELDS,
  HOUR_MS,
  isPlaceholder,
  mapObservation,
  periodEnd,
  periodText,
  SOURCE_ID,
  ZONE_SYSTEM,
  zoneOf,
} from "./map.ts";
export type { HourBody } from "./map.ts";

/**
 * This function makes the procedures of the EIA-930 source. The source has a canary: the age of the newest hour with a
 * demand. It has no `locate`: the source asks for no point.
 */
export function createEia930Source(options: Eia930FetchOptions): SourceProcedures {
  const fetch = createEia930Fetch(options);
  return {
    describe: () => EIA_930_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
