/**
 * The source adapter of the alert system for the space weather messages of the SWPC (the Space Weather Prediction
 * Center of the NOAA). The package reads the product list `alerts.json`, and gives the procedures of the source
 * contract of `@mark1russell7/alerts`.
 *
 * The messages are works of the US government, so they are in the public domain. The NWS asks for a credit of the
 * NWS as the source.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";
import { SWPC_DESCRIPTOR } from "./descriptor.ts";
import { createSwpcFetch, type SwpcFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { SWPC_DESCRIPTOR } from "./descriptor.ts";
export { ALERTS_PATH, createSwpcFetch, entryBody, isSwpcEntry, readAnswer, SWPC_BASE_URL } from "./fetch.ts";
export type { Read, SwpcFetchInput, SwpcFetchOptions } from "./fetch.ts";
export {
  ALERT_LIFE_MS,
  ENTRY_FIELDS,
  entryTime,
  GEOMAGNETIC_POLES,
  GEOMAGNETIC_STORM_KIND,
  kindOf,
  mapObservation,
  POLEWARD_BY_LEVEL,
  polarCaps,
  PRODUCTS,
  RADIO_BLACKOUT_KIND,
  SEVERITY_BY_LEVEL,
  SHORT_ALERT_LIFE_MS,
  SIGNIFICANCE,
  SOLAR_RADIATION_STORM_KIND,
  SOURCE_ID,
  SPACE_WEATHER_KIND,
  SWPC_KINDS,
  SWPC_PAGE,
  SWPC_SENDER,
  WATCH_DAY_SYSTEM,
  WATCH_SYSTEM,
} from "./map.ts";
export type { Family, Product } from "./map.ts";
export { HEADS, messageTime, monthOf, parseMessage, periodEnd, polewardOf, scaleLevel, statedScale, watchDays } from "./text.ts";
export type { Head, MessageText, Parsed, ScaleLevel, WatchDay } from "./text.ts";

/**
 * This function makes the procedures of the SWPC source: `describe`, `fetch` and `map`. The source has no `check`,
 * because the list has no canary. It has no `locate`: the source asks for no point.
 */
export function createSwpcSource(options: SwpcFetchOptions): SourceProcedures {
  const fetch = createSwpcFetch(options);
  return {
    describe: () => SWPC_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
  };
}
