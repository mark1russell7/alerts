/**
 * The descriptor of the SWPC source: the facts that the core uses for the schedule, the health and the coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";
import { NWS_ORIGIN } from "@mark1russell7/alerts-format-nws";

import { SOURCE_ID, SWPC_KINDS } from "./map.ts";

/**
 * The descriptor of the SWPC source. Space weather has effects on the whole Earth, so the coverage is global. The
 * source is a stream with no canary: long times with no message are normal at the minimum of the solar cycle. The
 * SWPC is a center of the NWS, so the source is a second path of the NWS, not a second outside domain. The answers
 * come through a CDN.
 */
export const SWPC_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "SWPC: the space weather alerts, watches, warnings and summaries of the NOAA",
  origins: [NWS_ORIGIN],
  dependsOn: ["provider:swpc", "cdn:cloudfront"],
  uses: ["internet", "dns", "power"],
  kinds: SWPC_KINDS,
  coverage: "global",
  transport: "poll",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
};
