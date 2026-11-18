/**
 * The descriptor of the feed of the AWS Health Dashboard: the facts that the core uses for the schedule, the health and
 * the coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { AWS_INTERVAL, AWS_KIND, AWS_ORIGIN, AWS_PROVIDER, AWS_SLOW_AFTER, AWS_SOURCE } from "./feed.ts";

/**
 * The descriptor of the source. The source asks for the feed with no key. It has no canary: a cloud with no event is
 * normal. A cloud region is not an area of the map, so the coverage is the whole Earth.
 */
export const AWS_DESCRIPTOR: SourceDescriptor = {
  id: AWS_SOURCE,
  title: "AWS Health Dashboard: the events of the public cloud",
  origins: [AWS_ORIGIN],
  dependsOn: [AWS_PROVIDER],
  uses: ["internet", "dns", "power"],
  kinds: [AWS_KIND],
  coverage: "global",
  transport: "poll",
  interval: AWS_INTERVAL,
  slowAfter: AWS_SLOW_AFTER,
  auth: "none",
  listing: "snapshot",
};
