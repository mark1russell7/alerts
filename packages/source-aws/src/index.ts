/**
 * The source adapter of the alert system for the AWS Health Dashboard. The dashboard gives an RSS feed of the updates of
 * each event that has not ended. Each event gives one report of `infra.cloud.outage`. The subjects of the report are the
 * domain of the service and the region of the event.
 *
 * The terms of the texts of the events are the terms of Amazon. The fixture keeps one real feed with no change.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { AWS_DESCRIPTOR } from "./descriptor.ts";
import { createAwsFetch, type AwsFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { AWS_DESCRIPTOR } from "./descriptor.ts";
export {
  AWS_BASE,
  AWS_DOMAIN,
  AWS_INTERVAL,
  AWS_KIND,
  AWS_ORIGIN,
  AWS_PROVIDER,
  AWS_SLOW_AFTER,
  AWS_SOURCE,
  DOMAIN_SYSTEM,
  FEED_PATH,
  GUID_PATTERN,
  guidOf,
  REGION_PATTERN,
  REGION_PROVIDER,
  REGION_SYSTEM,
  regionId,
  serviceOf,
  type ServiceKey,
} from "./feed.ts";
export { createAwsFetch, EVENT_CONTENT_TYPE, eventBodies, FEED_TIMEOUT_MS } from "./fetch.ts";
export type { AwsFetchInput, AwsFetchOptions, Events } from "./fetch.ts";
export { LEVEL_OF_STATUS, mapObservation, statusOf, type StatusLevel } from "./map.ts";

/**
 * This function makes the procedures of the source: `describe`, `fetch` and `map`. The source has no `check`, because
 * the feed has no canary. It has no `locate`: the source asks for no point.
 */
export function createAwsSource(options: AwsFetchOptions): SourceProcedures {
  const fetch = createAwsFetch(options);
  return {
    describe: () => AWS_DESCRIPTOR,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation),
  };
}
