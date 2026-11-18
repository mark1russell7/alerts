// The probe of the Twilio channels: a read of the balance of the account (AL-65, `docs/CONTRACTS.md`).

import type { Instant, ProbeOutcome } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { callTwilio, extractTwilioBalance, TWILIO_ACCOUNT_SID, twilioBalanceRequest, type TwilioCredentials, type TwilioFetch, type TwilioRequest } from "@procedures/notify/twilio";

/** The options of a probe of the Twilio account. */
export interface TwilioProbeOptions {
  readonly credentials: TwilioCredentials;
  readonly fetch: TwilioFetch;
  /** The time limit of the request. */
  readonly timeoutMs: number;
  /** The clock of the outcome. */
  readonly now: () => Instant;
}

/**
 * This function reads the balance of the account. The read sends nothing and costs nothing. A pass tells that the API of
 * Twilio answers and takes the credentials. The call channel and the text channel use it as their `probe`. It does not throw.
 */
export async function probeTwilioAccount(options: TwilioProbeOptions): Promise<ProbeOutcome> {
  if (!TWILIO_ACCOUNT_SID.test(options.credentials.accountSid)) return { ok: false, kind: "auth", message: "The account SID is not AC and 32 hexadecimal digits." };
  let request: TwilioRequest;
  try {
    request = twilioBalanceRequest(options.credentials);
  } catch (error) {
    return { ok: false, kind: "auth", message: `The credentials of the account are not valid: ${errorMessage(error)}` };
  }
  const result = await callTwilio(options.fetch, request, extractTwilioBalance, { timeoutMs: options.timeoutMs });
  if (!result.ok) return { ok: false, kind: result.kind, message: result.errors.join(" ") };
  return { ok: true, at: options.now() };
}
