/**
 * The descriptor of the NWWS-OI source: the facts that the core uses for the schedule, the health and the coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";
import { KIND_PREFIXES, NWS_ORIGIN, US_COVERAGE } from "@mark1russell7/alerts-format-nws";
import { SOURCE_ID } from "./map.ts";

/**
 * The descriptor of the NWWS-OI source. The stream comes from the servers of the NWS for NWWS-OI, not from the NWS API
 * and its network. Thus a fault of the NWS API is not a fault of this source. The two sources share the origin `nws`.
 */
export const NWWS_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "NOAA Weather Wire Service Open Interface (NWWS-OI)",
  origins: [NWS_ORIGIN],
  dependsOn: ["provider:nwws-oi"],
  uses: ["internet", "power"],
  kinds: KIND_PREFIXES,
  coverage: US_COVERAGE,
  transport: "stream",
  // A fetch reads the buffer of the stream, so a short interval costs no request.
  interval: 15_000,
  // The first fetch waits for the join of the room.
  slowAfter: 30_000,
  auth: "key",
  canary: "The NWS sends a keepalive test message each 10 minutes. The check passes when the newest one is at most 15 minutes old.",
};
