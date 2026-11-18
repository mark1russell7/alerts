/**
 * The descriptor of the BoM SWS source: the facts that the core uses for the schedule, the health and the coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { BOM_ORIGIN, BOM_SWS_KINDS, SOURCE_ID } from "./map.ts";

/**
 * The descriptor of the BoM SWS source. BoM calculates its alerts from the magnetometers of the Australian region,
 * apart from the NOAA and GFZ. A geomagnetic storm has effects on the whole Earth, so the coverage is global. The API
 * needs a key. The source is a snapshot, and the canary is the age of the newest K index.
 */
export const BOM_SWS_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "BoM SWS: the magnetic alerts and the geophysical warnings of the Australian region, on the NOAA scale G",
  origins: [BOM_ORIGIN],
  dependsOn: ["provider:bom-sws", "cdn:akamai"],
  uses: ["internet", "dns", "power"],
  kinds: BOM_SWS_KINDS,
  coverage: "global",
  transport: "poll",
  interval: 600_000,
  slowAfter: 10_000,
  auth: "key",
  listing: "snapshot",
  canary: "The K index of the Australian region has a value for each 3-hour period. The check passes when the newest period started at most 6 hours before the fetch.",
};
