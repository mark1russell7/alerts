/**
 * The source adapter of the alert system for the two tsunami warning centers of the NWS. The package reads the latest
 * CAP message of each center from `www.tsunami.gov`, and gives the procedures of the source contract of
 * `@mark1russell7/alerts`. Each center is a source of its own.
 *
 * The messages of the centers are products of the US government, in the public domain.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";
import { descriptorOf } from "./descriptor.ts";
import { createTsunamiFetch, type TsunamiFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { TSUNAMI_CENTERS, type CenterName, type TsunamiCenter } from "./centers.ts";
export { descriptorOf } from "./descriptor.ts";
export { createTsunamiFetch, observationOf, TSUNAMI_BASE_URL } from "./fetch.ts";
export type { TsunamiFetchInput, TsunamiFetchOptions } from "./fetch.ts";
export { mapObservation, TSUNAMI_KIND, TSUNAMI_SENDER } from "./map.ts";

/**
 * This function makes the procedures of the source of one center: `describe`, `fetch` and `map`. The source has no
 * `check`, because the centers have no canary. It has no `locate`: the source asks for no point.
 */
export function createTsunamiSource(options: TsunamiFetchOptions): SourceProcedures {
  const { center } = options;
  const descriptor = descriptorOf(center);
  const fetch = createTsunamiFetch(options);
  return {
    describe: () => descriptor,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation, center),
  };
}
