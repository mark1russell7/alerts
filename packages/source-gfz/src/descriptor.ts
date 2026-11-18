/**
 * The descriptor of the GFZ source: the facts that the core uses for the schedule, the health and the coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { GFZ_KINDS, GFZ_ORIGIN, SOURCE_ID } from "./map.ts";

/**
 * The descriptor of the GFZ source. A geomagnetic storm has effects on the whole Earth, so the coverage is global. GFZ
 * calculates Kp from 13 observatories, apart from the NOAA, so the source is a second origin of the storms of the SWPC.
 * The site answers with no CDN. The source is a snapshot, and the canary is the age of the newest interval.
 */
export const GFZ_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "GFZ: the planetary index Kp of each 3 hours, and the geomagnetic storms of the NOAA scale G",
  origins: [GFZ_ORIGIN],
  dependsOn: ["provider:gfz"],
  uses: ["internet", "dns", "power"],
  kinds: GFZ_KINDS,
  coverage: "global",
  transport: "poll",
  interval: 600_000,
  slowAfter: 10_000,
  auth: "none",
  listing: "snapshot",
  canary: "The series has a value for each 3-hour interval. The check passes when the newest interval started at most 6 hours before the fetch.",
};
