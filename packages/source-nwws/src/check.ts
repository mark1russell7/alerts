/**
 * The canary check of the NWWS-OI source. The NWS sends a keepalive test message each 10 minutes, with the AWIPS id
 * `KEPWBC`. A recent keepalive on the stream proves that the CAP messages of the NWS reach the room. The rule is
 * `keepaliveCheck` of format-nws, the same rule as the NWS API source.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";
import { readCap } from "@mark1russell7/alerts-format-cap";
import { isKeepalive, keepaliveCheck } from "@mark1russell7/alerts-format-nws";

/** This function gives the sent time of a keepalive in an observation. Another observation gives `undefined`. */
export function keepaliveSent(observation: Observation): Instant | undefined {
  const read = readCap(observation.body);
  if (!read.ok) return undefined;
  const awips = read.alert.infos.flatMap((info) => info.parameters.filter((pair) => pair.valueName === "AWIPSidentifier").map((pair) => pair.value));
  if (!isKeepalive(read.alert.identifier, awips)) return undefined;
  const sent = Date.parse(read.alert.sent);
  return Number.isNaN(sent) ? undefined : sent;
}

/**
 * This function examines the observations of one fetch against the canary. The fetch gives the newest keepalive again
 * each time, with the time of the fetch. The check passes when the newest keepalive is at most 15 minutes old. The
 * function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly sent: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const sent = keepaliveSent(observation);
    if (sent !== undefined && (newest === undefined || sent > newest.sent)) newest = { sent, fetched: observation.fetched };
  }
  return keepaliveCheck(newest);
}
