/**
 * The BoM SWS source of the alert system: the magnetic alerts and the geophysical warnings of the space weather
 * services of the Australian Bureau of Meteorology. An alert gives a report of a current geomagnetic storm. A warning
 * gives a report for each day of a storm in its forecast. Each report has the polar caps of its level of the NOAA scale G.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { BOM_SWS_DESCRIPTOR } from "./descriptor.ts";
import { createBomSwsFetch, type BomSwsFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { checkCanary, NEWEST_MAX_AGE_MS } from "./check.ts";
export { BOM_SWS_DESCRIPTOR } from "./descriptor.ts";
export { ACCEPT, BOM_SWS_BASE_URL, createBomSwsFetch, errorsDetail, errorsOf, failureOfRequest, FETCH_METHODS, KEY_ERROR_CODES, readAnswer, requestBody } from "./fetch.ts";
export type { ApiErrorItem, BomSwsFetchInput, BomSwsFetchOptions, Read } from "./fetch.ts";
export {
  ALERT_SYSTEM,
  alertLevel,
  BOM_CREDIT,
  BOM_ORIGIN,
  BOM_PAGE,
  BOM_SENDER,
  BOM_SWS_KINDS,
  bomDate,
  bomTime,
  bomTimeText,
  DAY_MS,
  DESCRIPTION_LEVELS,
  forecastLevel,
  isValidItem,
  mapObservation,
  METHODS,
  readItemBody,
  REGION,
  SOURCE_ID,
  WARNING_DAY_SYSTEM,
  WARNING_SYSTEM,
} from "./map.ts";
export type { ForecastLevel, ItemBody, Method } from "./map.ts";

/**
 * This function makes the procedures of the BoM SWS source. The source has a canary: the age of the newest K index.
 * It has no `locate`: the source asks for no point.
 */
export function createBomSwsSource(options: BomSwsFetchOptions): SourceProcedures {
  const fetch = createBomSwsFetch(options);
  return {
    describe: () => BOM_SWS_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
