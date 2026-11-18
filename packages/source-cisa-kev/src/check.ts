/**
 * The canary check of the CISA KEV source. CISA releases the catalog on most work days. Thus a catalog with an old
 * release tells of a file that CISA no longer keeps current, for example after a move of the feed.
 */

import type { CanaryResult, Instant, Observation } from "@mark1russell7/alerts";

import { releasedOf } from "./fetch.ts";

/**
 * The largest age of the release of the catalog at its fetch: 21 days. The largest gap between two dates of addition
 * from 2023-11-18 to 2026-11-17 was 18 days (355 gaps). The limit adds 3 days to that gap.
 */
export const RELEASE_MAX_AGE_MS: number = 21 * 86_400_000;

/**
 * This function examines the observations of one fetch against the canary. The check passes when the release of the
 * catalog is at most `RELEASE_MAX_AGE_MS` older than its fetch. The function is pure.
 */
export function checkCanary(observations: readonly Observation[]): CanaryResult {
  let newest: { readonly released: Instant; readonly fetched: Instant } | undefined;
  for (const observation of observations) {
    const released = releasedOf(observation.body);
    if (released !== undefined && (newest === undefined || released > newest.released)) newest = { released, fetched: observation.fetched };
  }
  if (newest === undefined) return { pass: false, reason: "the fetch has no head of the catalog with a release time" };
  const days = ((newest.fetched - newest.released) / 86_400_000).toFixed(1);
  const released = new Date(newest.released).toISOString();
  if (newest.fetched - newest.released > RELEASE_MAX_AGE_MS) {
    return { pass: false, reason: `the catalog was released at ${released}, ${days} days before the fetch: the limit is 21 days` };
  }
  return { pass: true, reason: `the catalog was released at ${released}, ${days} days before the fetch` };
}
