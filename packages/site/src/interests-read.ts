/**
 * The read of the interests from the alert runtime on this computer: the rows of the interest graph of each person.
 * The local page gives the fetch as a parameter, so the tests give a fake fetch. The path has no host, so the read
 * stays on the origin of the page.
 */

import { INTERESTS_FORMAT, interestsPayloadSchema, type InterestsPayload } from "@mark1russell7/alerts";

/** The path of the interests route of the runtime. */
export const INTERESTS_PATH = "/interests";

/**
 * The result of one read: the interests, no route, or the words of the failure. A runtime of an older version has no
 * interests route. Then the page tells that this runtime gives no interests.
 */
export type InterestsRead = { readonly ok: true; readonly payload: InterestsPayload } | { readonly ok: false; readonly absent: true } | { readonly ok: false; readonly absent: false; readonly text: string };

const SOURCE_TEXT = "The panel of the interests reads them from the alert runtime on this computer.";

/** The words of the page when the runtime gives interests of a different format. */
export const OTHER_INTERESTS_TEXT = `${SOURCE_TEXT} The runtime has a different version of the interests. Start the runtime of the version of this page.`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * This function reads the interests from the runtime once. A status 404 tells that the runtime has no interests route.
 * Each other failure gives a text for the reader. The schema of the core examines each part of the answer.
 */
export async function readInterests(get: (path: string) => Promise<Response>): Promise<InterestsRead> {
  const fail = (text: string): InterestsRead => ({ ok: false, absent: false, text: `${SOURCE_TEXT} ${text}` });
  let response: Response;
  try {
    response = await get(INTERESTS_PATH);
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
  if (!isObject(data) || typeof data["format"] !== "string") return fail("The answer of the runtime is not a list of interests.");
  if (data["format"] !== INTERESTS_FORMAT) return { ok: false, absent: false, text: OTHER_INTERESTS_TEXT };
  const result = interestsPayloadSchema.safeParse(data);
  return result.success ? { ok: true, payload: result.data } : fail("The answer of the runtime is not a list of interests.");
}
