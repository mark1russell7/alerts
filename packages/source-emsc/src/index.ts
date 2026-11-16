/**
 * The source adapter of the alert system for the event service of EMSC (the European-Mediterranean Seismological
 * Centre). The service gives the earthquakes of the world. The package asks for the events of magnitude 2.5 or more of
 * the past day, and gives the procedures of the source contract of `@mark1russell7/alerts`.
 *
 * The data of EMSC is under the license CC BY 4.0. Each report has the credit `EMSC_CREDIT` in its parameters.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";
import { EMSC_DESCRIPTOR } from "./descriptor.ts";
import { createEmscFetch, type EmscFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { EMSC_DESCRIPTOR } from "./descriptor.ts";
export { createEmscFetch, EMSC_BASE_URL, eventBody, eventFields, isEmscEvent, MIN_MAGNITUDE, pastDay, QUERY_LIMIT, QUERY_PATH, queryPath, readAnswer } from "./fetch.ts";
export type { EmscFetchInput, EmscFetchOptions } from "./fetch.ts";
export {
  ANSS_AUTHORS,
  ANSS_ORIGIN,
  EARTHQUAKE_KIND,
  EMSC_CREDIT,
  EMSC_ORIGIN,
  EVENT_FIELDS,
  EVENT_PAGE,
  EVENT_SYSTEM,
  EVENT_TYPES,
  eventTime,
  mapObservation,
  originOf,
  REPORT_LIFE_MS,
  SOURCE_ID,
} from "./map.ts";

/**
 * This function makes the procedures of the EMSC source: `describe`, `fetch` and `map`. The source has no `check`,
 * because the service has no canary. It has no `locate`: the source asks for no point.
 */
export function createEmscSource(options: EmscFetchOptions): SourceProcedures {
  const fetch = createEmscFetch(options);
  return {
    describe: () => EMSC_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
  };
}
