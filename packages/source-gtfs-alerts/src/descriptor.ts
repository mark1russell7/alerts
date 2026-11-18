/**
 * The descriptor of the source of one feed: the facts that the core uses for the schedule, the health, the coverage and
 * the indicator measures. Each feed is one source, so the health of one agency does not hide behind another.
 */

import type { MeasureDeclaration, SourceDescriptor } from "@mark1russell7/alerts";

import { boxArea, intervalOf, sourceIdOf, type GtfsFeed } from "./feed.ts";
import { ACTIVE_ALERTS, ALERT_UNIT, GTFS_KIND, NO_SERVICE_ALERTS } from "./map.ts";

/** The two measures of each feed: the count of the alerts in effect, and the count of those that stop a service. */
export const GTFS_MEASURES: readonly MeasureDeclaration[] = [
  {
    id: ACTIVE_ALERTS,
    dimension: "public-transit",
    title: "The count of the service alerts in effect on the network of an agency",
    unit: ALERT_UNIT,
    area: "code",
    moves: "rise",
    baseline: "none",
  },
  {
    id: NO_SERVICE_ALERTS,
    dimension: "public-transit",
    title: "The count of the service alerts in effect that stop a service of an agency",
    unit: ALERT_UNIT,
    area: "code",
    moves: "rise",
    baseline: "none",
  },
];

/** This function gives the cadence of the readings of a feed: one census at each fetch. */
function withCadence(feed: GtfsFeed): readonly MeasureDeclaration[] {
  return GTFS_MEASURES.map((measure) => ({ ...measure, cadence: intervalOf(feed) }));
}

/**
 * This function gives the descriptor of the source of a feed. The agency hosts its feed, so the agency is the failure
 * domain. The coverage is the box of the network.
 */
export function gtfsDescriptor(feed: GtfsFeed): SourceDescriptor {
  return {
    id: sourceIdOf(feed),
    title: `${feed.title}: the service alerts of the GTFS Realtime feed of the agency`,
    origins: [feed.origin],
    dependsOn: [`provider:${feed.origin}`],
    uses: ["internet", "dns", "power"],
    kinds: [GTFS_KIND],
    coverage: [boxArea(feed.box)],
    transport: "poll",
    interval: intervalOf(feed),
    slowAfter: 10_000,
    auth: "none",
    listing: "snapshot",
    canary: "The check passes when the feed decodes, and the time of its header is at most one hour before the fetch.",
    measures: withCadence(feed),
  };
}
