/**
 * The descriptors of the tsunami source: the facts that the core uses for the schedule, the health and the coverage.
 */

import type { Area, SourceDescriptor } from "@mark1russell7/alerts";
import { NWS_ORIGIN } from "@mark1russell7/alerts-format-nws";

import type { TsunamiCenter } from "./centers.ts";
import { TSUNAMI_KIND } from "./map.ts";

/**
 * This function gives the descriptor of the source of one center. The source is a stream with no canary: a center
 * sends no keepalive message, and long times with no message are normal. The origin is the NWS, so the source is a
 * second path of the NWS, not a second outside domain.
 */
export function descriptorOf(center: TsunamiCenter): SourceDescriptor {
  const coverage: readonly Area[] = center.coverage.map((code) => ({ type: "code", system: "iso3166", code }));
  return {
    id: center.id,
    title: `${center.title}: the latest tsunami message`,
    origins: [NWS_ORIGIN],
    dependsOn: ["provider:tsunami-gov"],
    uses: ["internet", "power"],
    kinds: [TSUNAMI_KIND],
    coverage,
    transport: "poll",
    interval: 60_000,
    slowAfter: 10_000,
    auth: "none",
  };
}
