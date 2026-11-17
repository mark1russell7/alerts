/**
 * The read of the history from the alert runtime on this computer. The local page gives the fetch as a parameter, so
 * the tests give a fake fetch. The path has no host, so the read stays on the origin of the page.
 */

import { addHistory, HISTORY_FORMAT, NO_HISTORIES, type Histories, type HistoryPayload } from "@mark1russell7/alerts";

/** The path of the history route of the runtime. */
export const HISTORY_PATH = "/history";

/**
 * The result of one read: the history, no route, or the words of the failure. A runtime of an older version has no
 * history route. Then the page shows the live map with no time scrubber.
 */
export type HistoryRead = { readonly ok: true; readonly payload: HistoryPayload } | { readonly ok: false; readonly absent: true } | { readonly ok: false; readonly absent: false; readonly text: string };

const SOURCE_TEXT = "The time scrubber reads the history from the alert runtime on this computer.";

/** The words of the page when the runtime gives a history of a different format. */
export const OTHER_FORMAT_TEXT = `${SOURCE_TEXT} The runtime has a different version of the history. Start the runtime of the version of this page.`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isTime = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isFinite(value));

/**
 * This function examines the history of one incident: an anchor, a list of reports and a list of changes.
 * Each change has a time, its areas and its places. The changes are in the sequence of their times.
 * The reader finds the change of a time by that sequence, so a different sequence is not a history.
 */
function isIncident(value: unknown): boolean {
  if (!isObject(value) || typeof value["anchor"] !== "string" || !Array.isArray(value["reports"]) || !Array.isArray(value["changes"])) return false;
  let last = -Infinity;
  for (const change of value["changes"] as readonly unknown[]) {
    if (!isObject(change) || !Array.isArray(change["codes"]) || !Array.isArray(change["shapes"]) || !Array.isArray(change["places"])) return false;
    const at = change["at"];
    // A time that is not a number is not after the last time, so this test refuses it also.
    if (typeof at !== "number" || !(at >= last)) return false;
    last = at;
  }
  return true;
}

/**
 * This function examines the outside of a history payload: the three times, each incident and the list of regions.
 * The runtime of the same version writes the payload on the same computer. Thus the page does not examine each shape.
 */
function isPayload(value: Record<string, unknown>): boolean {
  if (!isTime(value["at"]) || !isTime(value["since"]) || !isTime(value["next"])) return false;
  const regions = value["regions"];
  return Array.isArray(value["incidents"]) && value["incidents"].every(isIncident) && Array.isArray(regions) && regions.every((region) => isObject(region) && isObject(region["code"]) && Array.isArray(region["shapes"]));
}

/** This function gives the path of a read. The value `null` asks for each incident, and a time asks for the incidents with a change at that time or later. */
export function historyPath(since: number | null): string {
  return since === null ? HISTORY_PATH : `${HISTORY_PATH}?since=${String(since)}`;
}

/** This function reads the history from the runtime once. A status 404 tells that the runtime has no history route. Each other failure gives a text for the reader. */
export async function readHistory(get: (path: string) => Promise<Response>, since: number | null): Promise<HistoryRead> {
  const fail = (text: string): HistoryRead => ({ ok: false, absent: false, text: `${SOURCE_TEXT} ${text}` });
  let response: Response;
  try {
    response = await get(historyPath(since));
  } catch {
    return fail("The runtime does not answer.");
  }
  if (response.status === 404) return { ok: false, absent: true };
  if (!response.ok) return fail(`The runtime answers with the status ${String(response.status)}.`);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return fail("The answer of the runtime is not JSON.");
  }
  // A history names its format. An answer with the name of a different format comes from a runtime of a different version.
  if (!isObject(data) || typeof data["format"] !== "string") return fail("The answer of the runtime is not a history.");
  if (data["format"] !== HISTORY_FORMAT) return { ok: false, absent: false, text: OTHER_FORMAT_TEXT };
  return isPayload(data) ? { ok: true, payload: data as unknown as HistoryPayload } : fail("The answer of the runtime is not a history.");
}

/** The time between two reads of the whole history, in milliseconds. A read of the whole history drops each incident that left the runtime. */
export const WHOLE_READ_EVERY_MS = 600_000;

/** The result of the reads of one refresh of the page. */
export interface HistoriesRead {
  /** The histories after the reads. After a failure, they are the histories before the failed read. */
  readonly kept: Histories;
  /** This value is true when the runtime has no history route. Then the page shows no time scrubber. */
  readonly absent: boolean;
  /** The words of the failure, when a read failed. */
  readonly text?: string;
}

/**
 * This function reads the changes of the history since the last read, and adds them to the histories of the page.
 * With `whole`, and before the first read, it reads the whole history.
 *
 * A step of the clock of the runtime puts the newest change before the query. Then the function reads the whole
 * history one time more. Thus one refresh makes two reads at most.
 */
export async function readHistories(get: (path: string) => Promise<Response>, kept: Histories, whole = false): Promise<HistoriesRead> {
  const since = whole ? null : kept.since;
  const first = await readHistory(get, since);
  if (!first.ok) return first.absent ? { kept: NO_HISTORIES, absent: true } : { kept, absent: false, text: first.text };
  const added = addHistory(kept, first.payload);
  if (since === null || added.since !== null) return { kept: added, absent: false };
  const second = await readHistory(get, null);
  if (!second.ok) return second.absent ? { kept: NO_HISTORIES, absent: true } : { kept: added, absent: false, text: second.text };
  return { kept: addHistory(added, second.payload), absent: false };
}
