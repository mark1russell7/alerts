/**
 * The canary check of the NWWS-OI source. The NWS sends a keepalive test message each 10 minutes, with the AWIPS id
 * `KEPWBC`. A recent keepalive on the stream proves that the CAP messages of the NWS reach the room. The rule is
 * `keepaliveCheck` of format-nws, the same rule as the NWS API source.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";
import { readCap } from "@mark1russell7/alerts-format-cap";
import { isKeepalive, KEEPALIVE_MAX_AGE_MS, keepaliveCheck } from "@mark1russell7/alerts-format-nws";

/** This function gives the sent time of a keepalive in an observation. Another observation gives `undefined`. */
export function keepaliveSent(observation: Observation): Instant | undefined {
  const read = readCap(observation.body);
  if (!read.ok) return undefined;
  const awips = read.alert.infos.flatMap((info) => info.parameters.filter((pair) => pair.valueName === "AWIPSidentifier").map((pair) => pair.value));
  if (!isKeepalive(read.alert.identifier, awips)) return undefined;
  const sent = Date.parse(read.alert.sent);
  return Number.isNaN(sent) ? undefined : sent;
}

/** The session of the source at a check: the time of its join in the room, and the time of the check. */
export interface CanarySession {
  readonly joined: Instant;
  readonly now: Instant;
}

/**
 * This function examines the observations of one fetch against the canary. The fetch gives the newest keepalive again
 * each time, with the time of the fetch. The check passes when the newest keepalive is at most 15 minutes old.
 *
 * At a join, the room sends again only its last 25 products, so a new session gets no keepalive before the next one.
 * Thus with no fresh keepalive, the check gives no read (`undefined`) in the first 15 minutes of a session. After them,
 * or with no session, it fails. The function is pure.
 */
export function checkCanary(observations: readonly Observation[], session?: CanarySession): CanaryResult | undefined {
  let newest: { readonly sent: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const sent = keepaliveSent(observation);
    if (sent !== undefined && (newest === undefined || sent > newest.sent)) newest = { sent, fetched: observation.fetched };
  }
  const result = keepaliveCheck(newest);
  if (result.pass || session === undefined || session.now - session.joined >= KEEPALIVE_MAX_AGE_MS) return result;
  return undefined;
}
