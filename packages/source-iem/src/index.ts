/**
 * The source adapter of the alert system for the Iowa Environmental Mesonet (IEM). IEM gives the VTEC
 * events of the NWS that are in effect, by county and zone. The package gives the procedures of the
 * source contract of `@mark1russell7/alerts`.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";
import { IEM_DESCRIPTOR } from "./descriptor.ts";
import { createIemFetch, type IemFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { IEM_DESCRIPTOR } from "./descriptor.ts";
export { createIemFetch, IEM_BASE_URL, isListRow, keepsRow, LIST_PATH, readAnswer, rowBody } from "./fetch.ts";
export type { IemFetchInput, IemFetchOptions } from "./fetch.ts";
export { EVENT_PAGE, mapObservation, ROW_FIELDS, SOURCE_ID } from "./map.ts";

/**
 * This function makes the procedures of the IEM source: `describe`, `fetch` and `map`. The source has
 * no `check`, because the list has no canary. It has no `locate`: the list has no lookup.
 */
export function createIemSource(options: IemFetchOptions): SourceProcedures {
  const fetch = createIemFetch(options);
  return {
    describe: () => IEM_DESCRIPTOR,
    fetch: (input) => fetch(input),
    map: ({ observation }) => mapObservation(observation),
  };
}
