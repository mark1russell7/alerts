/**
 * The GTFS Realtime source of the alert system: the service alerts of the transit agencies. Each feed is one source.
 * Each alert gives one report of `transport.transit.service-alert`. The census of each fetch gives two indicator
 * readings of the dimension `public-transit`. The license of each feed is in its config. The reader of the catalog of
 * the Mobility Database gives the config of each open feed.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";

import { checkCanary } from "./check.ts";
import { gtfsDescriptor } from "./descriptor.ts";
import { createGtfsFetch, type GtfsFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { CATALOG_COLUMNS, CATALOG_URL, catalogFeeds, feedsFor, MAX_ORIGIN_LENGTH, originOf } from "./catalog.ts";
export type { CatalogFeeds, CatalogSkip } from "./catalog.ts";
export { checkCanary, FEED_MAX_AGE_MS } from "./check.ts";
export { GTFS_MEASURES, gtfsDescriptor } from "./descriptor.ts";
export { BODY_TYPE, createGtfsFetch, DIFFERENTIAL, FEED_TIMEOUT_MS, feedBodies } from "./fetch.ts";
export type { FeedBodies, GtfsFetchInput, GtfsFetchOptions } from "./fetch.ts";
export { boxArea, DEFAULT_INTERVAL, FEED_ID_PATTERN, feedProblems, intervalOf, isFeedUrl, SOURCE_PREFIX, sourceIdOf } from "./feed.ts";
export type { Box, GtfsFeed } from "./feed.ts";
export {
  ACTIVE_ALERTS,
  ALERT_UNIT,
  alertText,
  CAUSES,
  censusText,
  EFFECTS,
  ended,
  GTFS_KIND,
  inEffect,
  mapObservation,
  MAX_PARAMETER_VALUES,
  NO_SERVICE,
  NO_SERVICE_ALERTS,
  SEVERITY_LEVELS,
  severityOf,
  textIn,
} from "./map.ts";
export type { AlertBody, CensusBody } from "./map.ts";
export { decodeFeed, GTFS_REALTIME_DESCRIPTOR } from "./proto.ts";
export type { Alert, EntitySelector, FeedEntity, FeedMessage, TimeRange, TranslatedString, Translation } from "./proto.ts";

/**
 * This function makes the procedures of the source of one feed. The source has a canary: the age of the feed. It has no
 * `locate`: the source asks for no point.
 */
export function createGtfsSource(options: GtfsFetchOptions): SourceProcedures {
  const fetch = createGtfsFetch(options);
  const descriptor = gtfsDescriptor(options.feed);
  return {
    describe: () => descriptor,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(options.feed, observation),
    check: ({ observations }) => checkCanary(observations),
  };
}
