/**
 * The expectation of the IPAWS source: IPAWS carries a copy of each WEA message of the NWS.
 *
 * The NWS sends a message to IPAWS for Wireless Emergency Alerts (WEA). The NWS API gives the same
 * message with the parameter `WEAHandling`. The measure of 2026-11-15 found an IPAWS copy for 7 of 7
 * such messages in 6 days, and no copy for 72 warnings with no `WEAHandling`.
 */

import type { Expectation } from "@mark1russell7/alerts";
import { NWS_API_SOURCE, WEA_PARAMETER } from "@mark1russell7/alerts-format-nws";
import { SOURCE_ID } from "./map.ts";

/**
 * The expectation: each actual report of the NWS API source with the parameter `WEAHandling` has a
 * copy in IPAWS. The copies join one incident by the VTEC key. The core calculates the limit of the
 * delay from the measured delays.
 *
 * The core checks each such message (`carriages`). The copy of a message is the first IPAWS report in its incident
 * with the same sent time. Thus a lost copy of a later message of the same event, for example an extension, is a miss.
 */
export const WEA_EXPECTATION: Expectation = {
  id: "nws-api.ipaws",
  from: NWS_API_SOURCE,
  to: SOURCE_ID,
  when: { statuses: ["actual"], parameters: [WEA_PARAMETER] },
};
