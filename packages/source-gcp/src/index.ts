/**
 * The source adapter of the alert system for Google Cloud Service Health. The status page of Google Cloud gives the
 * history of its incidents as one JSON file. Each incident that has not ended gives one report of `infra.cloud.outage`.
 * The subjects of the report are the domain of the service and each location of the incident.
 *
 * The terms of the texts of the incidents are the terms of Google. The fixtures keep two real incidents with no change.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { GCP_DESCRIPTOR } from "./descriptor.ts";
import { createGcpFetch, type GcpFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { GCP_DESCRIPTOR } from "./descriptor.ts";
export {
  DOMAIN_SYSTEM,
  GCP_BASE,
  GCP_DOMAIN,
  GCP_INTERVAL,
  GCP_KIND,
  GCP_ORIGIN,
  GCP_PROVIDER,
  GCP_SLOW_AFTER,
  GCP_SOURCE,
  INCIDENTS_PATH,
  REGION_PROVIDER,
  REGION_SYSTEM,
  regionId,
} from "./feed.ts";
export { createGcpFetch, incidentBody, INCIDENTS_TIMEOUT_MS, isLive, readIncidents } from "./fetch.ts";
export type { GcpFetchInput, GcpFetchOptions, Incidents } from "./fetch.ts";
export { HISTORY_FIELDS, INCIDENT_FIELDS, isIncident, ITEM_FIELDS, itemsOf, locationsOf, mapObservation, sentOf, SEVERITY_OF_INCIDENT, UPDATE_FIELDS, URGENCY_OF_STATUS } from "./map.ts";

/**
 * This function makes the procedures of the source: `describe`, `fetch` and `map`. The source has no `check`, because
 * the feed has no canary. It has no `locate`: the source asks for no point.
 */
export function createGcpSource(options: GcpFetchOptions): SourceProcedures {
  const fetch = createGcpFetch(options);
  return {
    describe: () => GCP_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
  };
}
