/**
 * The GFZ source of the alert system: the planetary index Kp of GFZ, each 3 hours. A value of the NOAA scale G1 or
 * more gives a report of a geomagnetic storm, with the polar caps of its level. The data is under the license CC BY 4.0.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { GFZ_DESCRIPTOR } from "./descriptor.ts";
import { createGfzFetch, type GfzFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { checkCanary, NEWEST_MAX_AGE_MS } from "./check.ts";
export { GFZ_DESCRIPTOR } from "./descriptor.ts";
export { createGfzFetch, entryBody, GFZ_BASE_URL, isGfzEntry, queryPath, readAnswer, RUN_GAP_MS, runsOf, SERIES_PATH, WINDOW_INTERVALS } from "./fetch.ts";
export type { Entry, GfzFetchInput, GfzFetchOptions, Interval, Read } from "./fetch.ts";
export {
  GFZ_CREDIT,
  GFZ_KINDS,
  GFZ_LICENSE,
  GFZ_ORIGIN,
  GFZ_PAGE,
  GFZ_SENDER,
  INTERVAL_FIELDS,
  INTERVAL_MS,
  INTERVAL_SYSTEM,
  intervalStart,
  intervalText,
  kpOf,
  mapObservation,
  REPORT_LIFE_MS,
  RUN_SYSTEM,
  SOURCE_ID,
  STATUSES,
} from "./map.ts";

/**
 * This function makes the procedures of the GFZ source. The source has a canary: the age of the newest interval. It
 * has no `locate`: the source asks for no point.
 */
export function createGfzSource(options: GfzFetchOptions): SourceProcedures {
  const fetch = createGfzFetch(options);
  return {
    describe: () => GFZ_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
