/**
 * The source adapter of the alert system for the alerts API of the US National Weather Service
 * (api.weather.gov). It gives the procedures of the source contract of `@mark1russell7/alerts`.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";
import { checkCanary } from "./check.ts";
import { NWS_DESCRIPTOR } from "./descriptor.ts";
import { createNwsFetch, type NwsFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { checkCanary, keepaliveSent, KEEPALIVE_MAX_AGE_MS } from "./check.ts";
export { NWS_DESCRIPTOR } from "./descriptor.ts";
export { CANARY_PATH, createNwsFetch, NWS_BASE_URL, NWS_PROVIDER, queriesOf, readAnswer, WEA_PATH } from "./fetch.ts";
export type { NwsFetchInput, NwsFetchOptions, Query, QueryOptions } from "./fetch.ts";
export { KNOWN_FIELDS, mapObservation, SOURCE_ID } from "./map.ts";

/**
 * This function makes the procedures of the NWS API source: `describe`, `fetch`, `map` and `check`.
 * The source has no `locate`: the instance does not send the positions of its places to the NWS.
 */
export function createNwsSource(options: NwsFetchOptions): SourceProcedures {
  const fetch = createNwsFetch(options);
  return {
    describe: () => NWS_DESCRIPTOR,
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
