/**
 * The entry Function of the outage call. The server of Twilio operates the bundle of this file at the path `/outage`.
 */

import { runtimeHandler, twilioGlobals } from "../twilio-runtime.ts";

/** The handler of the entry Function. */
export const handler = runtimeHandler("entry", twilioGlobals);
