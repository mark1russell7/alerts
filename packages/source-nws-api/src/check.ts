/**
 * The canary check of the NWS API source. The NWS sends a keepalive test message each 10 minutes
 * (AWIPS id `KEPWBC`). A recent keepalive proves that the full path of the NWS works: the alert
 * system of the NWS, the API and the network.
 */

import type { CanaryResult, Observation } from "@mark1russell7/alerts";

/** The longest age of the newest keepalive at the fetch: the period of 10 minutes and a margin. */
export const KEEPALIVE_MAX_AGE_MS: number = 15 * 60_000;

const KEEPALIVE_ID = /KEEPALIVE/i;

/** This function gives the sent time of a keepalive in an observation. Another observation gives `undefined`. */
export function keepaliveSent(observation: Observation): number | undefined {
  let feature: unknown;
  try {
    feature = JSON.parse(observation.body);
  } catch {
    return undefined;
  }
  if (typeof feature !== "object" || feature === null || !("properties" in feature)) return undefined;
  const properties = feature.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const record = properties as Record<string, unknown>;
  const parameters = typeof record["parameters"] === "object" && record["parameters"] !== null ? (record["parameters"] as Record<string, unknown>) : {};
  const awips = Array.isArray(parameters["AWIPSidentifier"]) ? parameters["AWIPSidentifier"] : [];
  const isKeepalive =
    (typeof record["id"] === "string" && KEEPALIVE_ID.test(record["id"])) || awips.some((id) => typeof id === "string" && id.trim().toUpperCase() === "KEPWBC");
  if (!isKeepalive || typeof record["sent"] !== "string") return undefined;
  const sent = Date.parse(record["sent"]);
  return Number.isNaN(sent) ? undefined : sent;
}

/**
 * This function examines the observations of one fetch against the canary. The check passes when
 * the newest keepalive is at most `KEEPALIVE_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly sent: number; readonly fetched: number } | undefined;
  for (const observation of observations) {
    const sent = keepaliveSent(observation);
    if (sent !== undefined && (newest === undefined || sent > newest.sent)) newest = { sent, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no keepalive message of the NWS" };
  const age = newest.fetched - newest.sent;
  const minutes = (age / 60_000).toFixed(1);
  if (age > KEEPALIVE_MAX_AGE_MS) {
    return { pass: false, reason: `the newest keepalive message of the NWS is ${minutes} minutes old: the limit is 15 minutes` };
  }
  return { pass: true, reason: `the newest keepalive message of the NWS is ${minutes} minutes old` };
}
