/**
 * The source adapter of the alert system for Azure Status. The status page of Azure links an RSS feed of the widespread
 * incidents that have not ended. Each incident gives one report of `infra.cloud.outage`. The subjects of the report are
 * the domain of the service and the regions of the incident.
 *
 * The terms of the texts of the incidents are the terms of Microsoft. The fixtures keep the text of real feeds with no change.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { AZURE_DESCRIPTOR } from "./descriptor.ts";
import { createAzureFetch, type AzureFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { AZURE_DESCRIPTOR } from "./descriptor.ts";
export {
  AZURE_BASE,
  AZURE_CDN,
  AZURE_DOMAIN,
  AZURE_INTERVAL,
  AZURE_KIND,
  AZURE_ORIGIN,
  AZURE_PAGE,
  AZURE_PROVIDER,
  AZURE_REGIONS,
  AZURE_SLOW_AFTER,
  AZURE_SOURCE,
  categoriesOf,
  DOMAIN_SYSTEM,
  FEED_PATH,
  isNonRegional,
  isRegion,
  REGION_PROVIDER,
  REGION_SYSTEM,
  regionId,
  type Categories,
} from "./feed.ts";
export { createAzureFetch, FEED_TIMEOUT_MS, INCIDENT_CONTENT_TYPE, incidentBodies } from "./fetch.ts";
export type { AzureFetchInput, AzureFetchOptions, Incidents } from "./fetch.ts";
export { AZURE_SEVERITY, mapObservation, plainText } from "./map.ts";

/**
 * This function makes the procedures of the source: `describe`, `fetch` and `map`. The source has no `check`, because
 * the feed has no canary. It has no `locate`: the source asks for no point.
 */
export function createAzureSource(options: AzureFetchOptions): SourceProcedures {
  const fetch = createAzureFetch(options);
  return {
    describe: () => AZURE_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
  };
}
