/**
 * The expectation of the IPAWS source: IPAWS carries a copy of each WEA message of the NWS.
 *
 * The NWS sends a message to IPAWS for Wireless Emergency Alerts (WEA). The NWS API gives the same
 * message with the parameter `WEAHandling`. The measure of 2026-11-15 found an IPAWS copy for 7 of 7
 * such messages in 6 days, and no copy for 72 warnings with no `WEAHandling`.
 */

import type { Expectation, SourceId } from "@mark1russell7/alerts";
import { WEA_PARAMETER } from "@mark1russell7/alerts-format-nws";
import { SOURCE_ID } from "./map.ts";

/** The id of the NWS API source. A source package does not import another source package, so the id is here as data. */
export const NWS_API_SOURCE = "nws-api" as SourceId;

/**
 * The expectation: each actual report of the NWS API source with the parameter `WEAHandling` has a
 * copy in IPAWS. The copies join one incident by the VTEC key. The core calculates the limit of the
 * delay from the measured delays.
 */
export const WEA_EXPECTATION: Expectation = {
  id: "nws-api.ipaws",
  from: NWS_API_SOURCE,
  to: SOURCE_ID,
  when: { statuses: ["actual"], parameters: [WEA_PARAMETER] },
};
