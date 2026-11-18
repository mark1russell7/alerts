/**
 * The descriptors of the two sources of Cloudflare Radar: the facts that the core uses for the schedule, the health and
 * the coverage.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { ANOMALIES_SOURCE, CLOUD_KIND, OUTAGE_KIND, OUTAGES_SOURCE, RADAR_INTERVAL, RADAR_KINDS, RADAR_ORIGIN, RADAR_PROVIDER, RADAR_SLOW_AFTER } from "./feed.ts";

/**
 * The descriptor of the outages. The analysts of Cloudflare confirm each outage of the whole internet. The source asks for
 * the list with a token. It has no canary: a day with no outage is normal.
 */
export const OUTAGES_DESCRIPTOR: SourceDescriptor = {
  id: OUTAGES_SOURCE,
  title: "Cloudflare Radar: the confirmed internet outages and shutdowns of the outage center",
  origins: [RADAR_ORIGIN],
  dependsOn: [RADAR_PROVIDER],
  uses: ["internet", "dns", "power"],
  kinds: RADAR_KINDS,
  coverage: "global",
  transport: "poll",
  interval: RADAR_INTERVAL,
  slowAfter: RADAR_SLOW_AFTER,
  auth: "key",
  listing: "snapshot",
};

/**
 * The descriptor of the traffic anomalies. A model of Cloudflare finds each drop of the traffic of a country, a network
 * or a cloud region. The source shares the origin and the token of the outages.
 */
export const ANOMALIES_DESCRIPTOR: SourceDescriptor = {
  id: ANOMALIES_SOURCE,
  title: "Cloudflare Radar: the traffic anomalies of the countries, the networks and the cloud regions",
  origins: [RADAR_ORIGIN],
  dependsOn: [RADAR_PROVIDER],
  uses: ["internet", "dns", "power"],
  kinds: [OUTAGE_KIND, CLOUD_KIND],
  coverage: "global",
  transport: "poll",
  interval: RADAR_INTERVAL,
  slowAfter: RADAR_SLOW_AFTER,
  auth: "key",
  listing: "snapshot",
};
