/**
 * The descriptor of the EMSC source: the facts that the core uses for the schedule, the health and the coverage.
 */

import type { Area, SourceDescriptor } from "@mark1russell7/alerts";
import { ANSS_ORIGIN, EARTHQUAKE_KIND, EMSC_ORIGIN, SOURCE_ID } from "./map.ts";

/**
 * The areas of the coverage, as ISO 3166 codes: the areas of the USGS source. The service is global, but the places of
 * the system get their earthquakes from the networks of the ANSS. In one day of 2026-11-16, EMSC had 30 of the 41 events
 * of the USGS feed. The 11 misses were events of the Alaska network, of magnitude 2.5 to 2.7.
 */
const COVERAGE: readonly Area[] = ["US", "PR", "VI", "GU", "MP", "AS"].map((code) => ({ type: "code", system: "iso3166", code }));

/**
 * The descriptor of the EMSC source. EMSC relays the solutions of the ANSS for the events in the US. Thus the source
 * depends on the USGS too, and it is a second path there, not a second outside domain. The answer is a snapshot of
 * the past day. An event that EMSC deletes leaves the answer with no cancel, so the runtime ends a report that is
 * absent from complete answers.
 */
export const EMSC_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "EMSC: the earthquakes of magnitude 2.5 or more of the past day",
  origins: [EMSC_ORIGIN, ANSS_ORIGIN],
  dependsOn: ["provider:emsc", "provider:usgs"],
  uses: ["internet", "power"],
  kinds: [EARTHQUAKE_KIND],
  coverage: COVERAGE,
  transport: "poll",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
  listing: "snapshot",
};
