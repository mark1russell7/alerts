/**
 * The facts of the feed of Google Cloud Service Health. The status page gives the history of the incidents of the public
 * cloud as one JSON file. The documentation of the page names this file for integrations, and its `robots.txt` file
 * stops no path.
 */

import type { Duration, SourceId, SubjectSystem } from "@mark1russell7/alerts";

/** The id of the source. */
export const GCP_SOURCE = "gcp-status" as SourceId;

/** The origin of each report: the provider. */
export const GCP_ORIGIN = "google-cloud";

/** The base of the status page. */
export const GCP_BASE = "https://status.cloud.google.com";

/** The path of the history of the incidents. */
export const INCIDENTS_PATH = "/incidents.json";

/** The kind of each report: a failure of a public cloud region or service. */
export const GCP_KIND = "infra.cloud.outage";

/** The failure domain of the status page. Google Cloud hosts the page, so a wide failure of the cloud can stop it. */
export const GCP_PROVIDER = "provider:google-cloud";

/** The time between two fetches. A conditional GET of an unchanged file gives a 304 with no body. */
export const GCP_INTERVAL: Duration = 120_000;

/** The longest normal time of one fetch. The file had 292 kB on 2026-11-18. */
export const GCP_SLOW_AFTER: Duration = 15_000;

/** The domain of the service. The subject `domain:cloud.google.com` goes to a person who names the service. */
export const GCP_DOMAIN = "cloud.google.com";

/** The system of the subject of the service. */
export const DOMAIN_SYSTEM: SubjectSystem = "domain";

/**
 * The system of the subject of each location of an incident. Its id is the provider, a slash and the id of the location,
 * for example `gcp/europe-west1`. The location `global` gives `gcp/global`.
 */
export const REGION_SYSTEM: SubjectSystem = "provider-region";

/** The provider part of the id of each region. */
export const REGION_PROVIDER = "gcp";

/** This function gives the id of the subject of one location of Google Cloud: `gcp/` and the id of the location. */
export function regionId(location: string): string {
  return `${REGION_PROVIDER}/${location}`;
}
