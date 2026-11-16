/**
 * The press Function of the outage call. The server of Twilio operates the bundle of this file at the path `/press`.
 */

import { runtimeHandler, twilioGlobals } from "../twilio-runtime.ts";

/** The handler of the press Function. */
export const handler = runtimeHandler("press", twilioGlobals);
