/**
 * This module gives the region codes of a position from the outlines of the NWS zones. The runtime adds them to each place
 * with a position. The function reads only the outlines in memory. Thus no request names the position.
 */
import { regionsNear, type MapRegion, type Position, type RegionCode } from "@mark1russell7/alerts";
import { sameOfCountyUgc, stateOfUgc } from "@mark1russell7/alerts-format-nws";
import { compareCodes, zoneKindOf } from "./zones.ts";

/**
 * This function gives the region codes of the zones at `bufferKm` or less from a position. The codes are the UGC code of each
 * county and forecast zone, the SAME code of each county and the code of each state. The SAME code lets the alerts of the radio
 * and of IPAWS match. Each code is in the list one time, in the order of the system and the code. A region that is not a county
 * or a forecast zone gives no code.
 */
export function zoneCodesNear(regions: readonly MapRegion[], at: Position, bufferKm: number): RegionCode[] {
  const codes = new Map<string, RegionCode>();
  const add = (code: RegionCode): void => {
    codes.set(`${code.system}:${code.code}`, code);
  };
  for (const { region } of regionsNear(regions, at, bufferKm)) {
    if (region.code.system !== "ugc") continue;
    const ugc = region.code.code.trim().toUpperCase();
    const kind = zoneKindOf(ugc);
    const state = stateOfUgc(ugc);
    if (kind === undefined || state === undefined) continue;
    add({ system: "ugc", code: ugc });
    add({ system: "state", code: state });
    const same = kind === "county" ? sameOfCountyUgc(ugc) : undefined;
    if (same !== undefined) add({ system: "same", code: same });
  }
  return [...codes.values()].sort((a, b) => compareCodes(a.system, b.system) || compareCodes(a.code, b.code));
}
