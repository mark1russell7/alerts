/**
 * The facts of the feed of Google Cloud Service Health. The status page gives the history of the incidents of the public
 * cloud as one JSON file. The documentation of the page names this file for integrations, and its `robots.txt` file
 * stops no path.
 *
 * The Firebase Status Dashboard gives its history in the same format. Its page links the file as its JSON history, and
 * its `robots.txt` file stops no path. Each dashboard is data (`GoogleDashboard`).
 */

import type { Duration, SourceId, SubjectSystem } from "@mark1russell7/alerts";

/** The id of the source. */
export const GCP_SOURCE = "gcp-status" as SourceId;

/** The origin of each report: the provider. */
export const GCP_ORIGIN = "google";

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

/**
 * The key of one product of a dashboard: the domain of the endpoint that the product serves. A key names the endpoint,
 * not the company. Thus an outage of Firebase Hosting does not go to a person who watches only the push messages.
 */
export interface ProductKey {
  /** The id of the product in the dashboard. The documentation of the dashboards gives the ids as stable. */
  readonly id: string;
  /** The name of the product, for a person who reads the config, for example `Cloud Messaging`. */
  readonly name: string;
  /** The domain of the endpoint, for example `fcm.googleapis.com`. Each report of the product names it as a subject. */
  readonly domain: string;
}

/** One status dashboard of Google that gives the history of its incidents as `/incidents.json`. */
export interface GoogleDashboard {
  /** The id of the source. */
  readonly id: SourceId;
  /** The title of the descriptor of the source. */
  readonly title: string;
  /** The name of the service. It is the label of the subject of the service and the start of each headline. */
  readonly name: string;
  /** The name of the dashboard. It is the sender of each report. */
  readonly sender: string;
  /** The base of the dashboard: `https://` and a host. */
  readonly base: string;
  /** The domain of the service. Each report names it as its first subject. */
  readonly domain: string;
  /** The keys of the products that serve an endpoint. A product with no key gives only the domain of the service. */
  readonly products: readonly ProductKey[];
}

/** The dashboard of Google Cloud. Its products have no key: a person who uses Google Cloud names `cloud.google.com`. */
export const GCP_DASHBOARD: GoogleDashboard = {
  id: GCP_SOURCE,
  title: "Google Cloud Service Health: the incidents of the public cloud",
  name: "Google Cloud",
  sender: "Google Cloud Service Health",
  base: GCP_BASE,
  domain: GCP_DOMAIN,
  products: [],
};

/** The id of the source of the Firebase Status Dashboard. */
export const FIREBASE_SOURCE = "firebase-status" as SourceId;

/** The base of the Firebase Status Dashboard. */
export const FIREBASE_BASE = "https://status.firebase.google.com";

/** The domain of Firebase. The subject `domain:firebase.google.com` goes to a person who names the service. */
export const FIREBASE_DOMAIN = "firebase.google.com";

/**
 * The keys of the products of Firebase. Firebase Cloud Messaging sends the push messages of Android apps through the
 * endpoint `fcm.googleapis.com`. The id comes from the product catalog of the dashboard (`/products.json`) on 2026-11-18.
 */
export const FIREBASE_KEYS: readonly ProductKey[] = [{ id: "K2T198LhzrR5kLU8hmkk", name: "Cloud Messaging", domain: "fcm.googleapis.com" }];

/** The Firebase Status Dashboard. The incidents of Firebase have no location. */
export const FIREBASE_DASHBOARD: GoogleDashboard = {
  id: FIREBASE_SOURCE,
  title: "Firebase Status Dashboard: the incidents of Firebase",
  name: "Firebase",
  sender: "Firebase Status Dashboard",
  base: FIREBASE_BASE,
  domain: FIREBASE_DOMAIN,
  products: FIREBASE_KEYS,
};

/** The dashboards of Google, in the order of the instance. */
export const GOOGLE_DASHBOARDS: readonly GoogleDashboard[] = [GCP_DASHBOARD, FIREBASE_DASHBOARD];
