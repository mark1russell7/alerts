/**
 * The descriptor of the feed of Azure Status: the facts that the core uses for the schedule, the health and the
 * coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { AZURE_CDN, AZURE_INTERVAL, AZURE_KIND, AZURE_ORIGIN, AZURE_PROVIDER, AZURE_SLOW_AFTER, AZURE_SOURCE } from "./feed.ts";

/**
 * The descriptor of the source. The source asks for the feed with no key. It has no canary: a cloud with no incident is
 * normal. A cloud region is not an area of the map, so the coverage is the whole Earth.
 */
export const AZURE_DESCRIPTOR: SourceDescriptor = {
  id: AZURE_SOURCE,
  title: "Azure Status: the widespread incidents of the public cloud",
  origins: [AZURE_ORIGIN],
  dependsOn: [AZURE_PROVIDER, AZURE_CDN],
  uses: ["internet", "dns", "power"],
  kinds: [AZURE_KIND],
  coverage: "global",
  transport: "poll",
  interval: AZURE_INTERVAL,
  slowAfter: AZURE_SLOW_AFTER,
  auth: "none",
  listing: "snapshot",
};
