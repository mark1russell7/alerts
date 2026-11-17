/**
 * The descriptor of the source of one CAP feed: the facts that the core uses for the schedule, the health and the
 * coverage. The config of the feed gives each fact that differs between two feeds.
 */

import type { Area, SourceDescriptor } from "@mark1russell7/alerts";

import { DEFAULT_INTERVAL, DEFAULT_SLOW_AFTER, type CapFeed } from "./feed.ts";

/**
 * This function gives the descriptor of the source of one feed. The source asks for the index with no key, and it has
 * no canary: a feed with no alert is normal.
 */
export function descriptorOf(feed: CapFeed): SourceDescriptor {
  const coverage: readonly Area[] = feed.coverage.map((code) => ({ type: "code", system: "iso3166", code }));
  return {
    id: feed.id,
    title: `${feed.title}: the CAP feed`,
    origins: [feed.origin],
    dependsOn: feed.dependsOn,
    uses: ["internet", "dns", "power"],
    kinds: feed.kinds,
    coverage,
    transport: "poll",
    interval: feed.interval ?? DEFAULT_INTERVAL,
    slowAfter: feed.slowAfter ?? DEFAULT_SLOW_AFTER,
    auth: "none",
    ...(feed.listing === undefined ? {} : { listing: feed.listing }),
  };
}
