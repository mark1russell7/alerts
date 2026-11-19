/**
 * The read of the health from the alert runtime on this computer. The local page gives the fetch as a parameter, so
 * the tests give a fake fetch. The path has no host, so the read stays on the origin of the page.
 */

import { HEALTH_FORMAT, healthPayloadSchema, type HealthPayload } from "@mark1russell7/alerts";
import { isRecord } from "@mark1russell7/optional/read";

/** The path of the health route of the runtime. */
export const HEALTH_PATH = "/health";

/**
 * The result of one read: the health, no route, or the words of the failure. A runtime with no health function has no
 * health route. Then the page tells that this runtime gives no health.
 */
export type HealthRead = { readonly ok: true; readonly payload: HealthPayload } | { readonly ok: false; readonly absent: true } | { readonly ok: false; readonly absent: false; readonly text: string };

const SOURCE_TEXT = "The panel of the sources reads the health from the alert runtime on this computer.";

/** The words of the page when the runtime gives a health of a different format. */
export const OTHER_HEALTH_TEXT = `${SOURCE_TEXT} The runtime has a different version of the health. Start the runtime of the version of this page.`;

/**
 * This function reads the health from the runtime once. A status 404 tells that the runtime has no health route.
 * Each other failure gives a text for the reader. The schema of the core examines each part of the answer.
 */
export async function readHealth(get: (path: string) => Promise<Response>): Promise<HealthRead> {
  const fail = (text: string): HealthRead => ({ ok: false, absent: false, text: `${SOURCE_TEXT} ${text}` });
  let response: Response;
  try {
    response = await get(HEALTH_PATH);
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
  // A health names its format. An answer with the name of a different format comes from a runtime of a different version.
  if (!isRecord(data) || typeof data["format"] !== "string") return fail("The answer of the runtime is not a health.");
  if (data["format"] !== HEALTH_FORMAT) return { ok: false, absent: false, text: OTHER_HEALTH_TEXT };
  const result = healthPayloadSchema.safeParse(data);
  return result.success ? { ok: true, payload: result.data } : fail("The answer of the runtime is not a health.");
}
