/**
 * The descriptor of the IEM source: the facts that the core uses for the schedule, the health and
 * the coverage.
 */

import type { Area, SourceDescriptor } from "@mark1russell7/alerts";
import { NWS_ORIGIN, VTEC_KIND_PREFIXES } from "@mark1russell7/alerts-format-nws";
import { SOURCE_ID } from "./map.ts";

/** The countries and territories of the NWS offices in the list of IEM, as ISO 3166 codes. */
const COVERAGE: readonly Area[] = ["US", "PR", "VI", "GU", "MP"].map((code) => ({ type: "code", system: "iso3166", code }));

/**
 * The descriptor of the IEM source. Each report of IEM is a copy of an NWS message, so its origin is
 * the NWS. IEM reads the NWS products from its own feeds, so the source does not depend on the NWS
 * API or its network. The source has no canary: the list has no keepalive row.
 *
 * The list is a snapshot. A row that ends leaves the list with no cancel. Thus the runtime ends the
 * report of a row that is absent from complete lists.
 */
export const IEM_DESCRIPTOR: SourceDescriptor = {
  id: SOURCE_ID,
  title: "Iowa Environmental Mesonet: NWS watches, warnings and advisories in effect, by county and zone",
  origins: [NWS_ORIGIN],
  dependsOn: ["provider:iem"],
  uses: ["internet", "power"],
  kinds: VTEC_KIND_PREFIXES,
  coverage: COVERAGE,
  transport: "poll",
  interval: 120_000,
  slowAfter: 10_000,
  auth: "none",
  listing: "snapshot",
};
