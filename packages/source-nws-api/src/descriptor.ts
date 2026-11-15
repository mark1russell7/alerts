/**
 * The descriptor of the NWS API source: the facts that the core uses for the schedule, the health
 * and the coverage.
 */

import type { Area, SourceDescriptor } from "@mark1russell7/alerts";
import { EVENT_CODES, PHENOMENA } from "@mark1russell7/alerts-format-nws";
import { ORIGIN, SOURCE_ID } from "./map.ts";

/** The countries and territories of the NWS, as ISO 3166 codes. */
const COVERAGE: readonly Area[] = ["US", "PR", "GU", "AS", "VI", "MP"].map((code) => ({ type: "code", system: "iso3166", code }));

/** The first parts of the taxonomy codes in the kind tables: the kinds that the source covers. */
export const KIND_PREFIXES: readonly string[] = [
  ...new Set([...Object.values(PHENOMENA), ...Object.values(EVENT_CODES)].map((hazard) => hazard.code.split(".", 1)[0] ?? "other")),
].sort();

/** The descriptor of the NWS API source. */
export const NWS_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "NWS alerts API (api.weather.gov)",
  origins: [ORIGIN],
  // The NWS API answers through the Akamai network (api.weather.gov is a name of edgekey.net)
  dependsOn: ["provider:nws-api", "cdn:akamai"],
  uses: ["internet", "power"],
  kinds: KIND_PREFIXES,
  coverage: COVERAGE,
  transport: "poll",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
  canary: "The NWS sends a keepalive test message each 10 minutes. The check passes when the newest one is at most 15 minutes old.",
};
