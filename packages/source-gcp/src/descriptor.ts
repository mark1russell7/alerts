/**
 * The descriptors of the dashboards of Google: the facts that the core uses for the schedule, the health and the
 * coverage. The dashboards differ only in their ids and their titles.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { FIREBASE_DASHBOARD, GCP_DASHBOARD, GCP_INTERVAL, GCP_KIND, GCP_ORIGIN, GCP_PROVIDER, GCP_SLOW_AFTER, type GoogleDashboard } from "./feed.ts";

const made = new WeakMap<GoogleDashboard, SourceDescriptor>();

/**
 * This function gives the descriptor of the source of a dashboard, the same object for the same dashboard. The source
 * asks for the file with no key. It has no canary: a service with no incident is normal. A cloud region is not an area
 * of the map, so the coverage is the whole Earth. Google Cloud hosts each dashboard.
 */
export function dashboardDescriptor(dashboard: GoogleDashboard): SourceDescriptor {
  const known = made.get(dashboard);
  if (known !== undefined) return known;
  const descriptor: SourceDescriptor = {
    id: dashboard.id,
    title: dashboard.title,
    origins: [GCP_ORIGIN],
    dependsOn: [GCP_PROVIDER],
    uses: ["internet", "dns", "power"],
    kinds: [GCP_KIND],
    coverage: "global",
    transport: "poll",
    interval: GCP_INTERVAL,
    slowAfter: GCP_SLOW_AFTER,
    auth: "none",
    listing: "snapshot",
  };
  made.set(dashboard, descriptor);
  return descriptor;
}

/** The descriptor of the source of Google Cloud Service Health. */
export const GCP_DESCRIPTOR: SourceDescriptor = dashboardDescriptor(GCP_DASHBOARD);

/** The descriptor of the source of the Firebase Status Dashboard. */
export const FIREBASE_DESCRIPTOR: SourceDescriptor = dashboardDescriptor(FIREBASE_DASHBOARD);
