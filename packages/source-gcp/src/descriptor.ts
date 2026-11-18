/**
 * The descriptor of the feed of Google Cloud Service Health: the facts that the core uses for the schedule, the health
 * and the coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { GCP_INTERVAL, GCP_KIND, GCP_ORIGIN, GCP_PROVIDER, GCP_SLOW_AFTER, GCP_SOURCE } from "./feed.ts";

/**
 * The descriptor of the source. The source asks for the file with no key. It has no canary: a cloud with no incident is
 * normal. A cloud region is not an area of the map, so the coverage is the whole Earth.
 */
export const GCP_DESCRIPTOR: SourceDescriptor = {
  id: GCP_SOURCE,
  title: "Google Cloud Service Health: the incidents of the public cloud",
  origins: [GCP_ORIGIN],
  dependsOn: [GCP_PROVIDER],
  uses: ["internet", "dns", "power"],
  kinds: [GCP_KIND],
  coverage: "global",
  transport: "poll",
  interval: GCP_INTERVAL,
  slowAfter: GCP_SLOW_AFTER,
  auth: "none",
  listing: "snapshot",
};
