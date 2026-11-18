/**
 * The descriptor of the source of one status page: the facts that the core uses for the schedule, the health and the
 * coverage. The config of the page gives each fact that differs between two pages.
 */

import type { SourceDescriptor } from "@mark1russell7/alerts";

import { DEFAULT_INTERVAL, DEFAULT_SLOW_AFTER, type StatusPage } from "./page.ts";

/**
 * This function gives the descriptor of the source of one page. The source asks for the summary with no key. It has no
 * canary: a page with no incident is normal. A service has no area, so the coverage is the whole Earth.
 */
export function descriptorOf(page: StatusPage): SourceDescriptor {
  return {
    id: page.id,
    title: `${page.title}: the incidents of its status page`,
    origins: [page.origin],
    dependsOn: page.dependsOn,
    uses: ["internet", "dns", "power"],
    kinds: [page.kind],
    coverage: "global",
    transport: "poll",
    interval: page.interval ?? DEFAULT_INTERVAL,
    slowAfter: page.slowAfter ?? DEFAULT_SLOW_AFTER,
    auth: "none",
    listing: "snapshot",
  };
}
