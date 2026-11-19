/**
 * The read of the map from the alert runtime on this computer. The local page gives the fetch as a parameter, so the
 * tests give a fake fetch. The path has no host, so the read stays on the origin of the page.
 */

import type { MapPayload } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";

/** The path of the map route of the runtime. */
export const MAP_PATH = "/map";

/** The time between two reads of the map. */
export const READ_EVERY_MS = 30_000;

/** The result of one read: the map, or the words of the failure. */
export type MapRead = { readonly ok: true; readonly payload: MapPayload } | { readonly ok: false; readonly text: string };

const SOURCE_TEXT = "This page reads the alert runtime on this computer.";

/** The words of the page when the runtime does not answer. */
export const NO_ANSWER_TEXT = `${SOURCE_TEXT} The runtime does not answer. Start the runtime. The page reads it again every ${String(READ_EVERY_MS / 1000)} seconds.`;

/** This function examines a region of the basemap: a code with a system and a value, a name and a list of shapes. */
function isRegion(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value["code"])) return false;
  const code = value["code"];
  return typeof code["system"] === "string" && typeof code["code"] === "string" && typeof value["name"] === "string" && Array.isArray(value["shapes"]);
}

/**
 * This function examines the outside of a map payload: the three lists of the view, and each region of the basemap.
 * The runtime of the same version writes the payload on the same computer. Thus the page does not examine each shape.
 */
function isPayload(value: unknown): value is MapPayload {
  if (!isRecord(value) || !isRecord(value["view"]) || !Array.isArray(value["basemap"]) || !value["basemap"].every(isRegion)) return false;
  const view = value["view"];
  return Array.isArray(view["incidents"]) && Array.isArray(view["places"]) && Array.isArray(view["unshaped"]);
}

/** This function reads the map from the runtime once. Each failure gives a text for the reader. */
export async function readMap(get: (path: string) => Promise<Response>): Promise<MapRead> {
  let response: Response;
  try {
    response = await get(MAP_PATH);
  } catch {
    return { ok: false, text: NO_ANSWER_TEXT };
  }
  if (!response.ok) return { ok: false, text: `${SOURCE_TEXT} The runtime answers with the status ${String(response.status)}.` };
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, text: `${SOURCE_TEXT} The answer of the runtime is not JSON.` };
  }
  return isPayload(data) ? { ok: true, payload: data } : { ok: false, text: `${SOURCE_TEXT} The answer of the runtime is not a map.` };
}

/**
 * This function gives the line of the read: the time of the last good read, or a note that no read is good yet.
 * After a failure, the page keeps the last good map and tells its time.
 */
export function readLine(lastGood: number | undefined, failed: boolean, time: (at: number) => string): string {
  if (lastGood === undefined) return failed ? "No map yet." : "Reading the runtime.";
  return failed ? `The map shows the read of ${time(lastGood)}.` : `Read at ${time(lastGood)}. The page reads again every ${String(READ_EVERY_MS / 1000)} seconds.`;
}
