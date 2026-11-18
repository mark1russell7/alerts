/**
 * The descriptor of the IPAWS source: the facts that the core uses for the schedule, the health
 * and the coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";
import { KIND_PREFIXES, US_COVERAGE } from "@mark1russell7/alerts-format-nws";
import { ORIGINS, SOURCE_ID } from "./map.ts";

/**
 * The descriptor of the IPAWS source. The source has no canary: the feed has no keepalive message,
 * and a quiet feed is normal. Gaps of 12 hours with no alert occur. The lateness of the NWS API
 * source against this source examines its content.
 */
export const IPAWS_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "FEMA IPAWS public alert feed (IPAWS-OPEN)",
  origins: [ORIGINS.nws, ORIGINS.authority],
  // The feed answers through the Cloudflare network (apps.fema.gov)
  dependsOn: ["provider:fema-ipaws", "cdn:cloudflare", "carrier:ipaws-open"],
  uses: ["internet", "dns", "power"],
  kinds: KIND_PREFIXES,
  coverage: US_COVERAGE,
  transport: "poll",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
};
