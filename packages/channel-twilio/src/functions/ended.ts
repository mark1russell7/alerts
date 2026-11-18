/**
 * The ended Function of the outage call. The server of Twilio operates the bundle of this file at the path `/ended`.
 */

import { runtimeHandler, twilioGlobals, type RuntimeHandler } from "../twilio-runtime.ts";

/** The handler of the ended Function. */
export const handler: RuntimeHandler = runtimeHandler("ended", twilioGlobals);
