/**
 * The descriptor of the NWS API source: the facts that the core uses for the schedule, the health
 * and the coverage.
 */

import type { Area, SourceDescriptor } from "@mark1russell7/alerts";
import { KIND_PREFIXES, NWS_ORIGIN } from "@mark1russell7/alerts-format-nws";
import { SOURCE_ID } from "./map.ts";

/** The countries and territories of the NWS, as ISO 3166 codes. */
const COVERAGE: readonly Area[] = ["US", "PR", "GU", "AS", "VI", "MP"].map((code) => ({ type: "code", system: "iso3166", code }));

/** The descriptor of the NWS API source. */
export const NWS_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "NWS alerts API (api.weather.gov)",
  origins: [NWS_ORIGIN],
  // The NWS API answers through the Akamai network (api.weather.gov is a name of edgekey.net)
  dependsOn: ["provider:nws-api", "cdn:akamai"],
  uses: ["internet", "dns", "power"],
  kinds: KIND_PREFIXES,
  coverage: COVERAGE,
  transport: "poll",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
  canary: "The NWS sends a keepalive test message each 10 minutes. The check passes when the newest one is at most 15 minutes old.",
};
