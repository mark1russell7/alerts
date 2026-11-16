/**
 * The Twilio voice call channel of the alert system. It gives the procedures of the channel contract of
 * `@mark1russell7/alerts`: `describe`, `send`, `status` and `cancel`. The calls of the Twilio API come
 * from `@procedures/notify/twilio`.
 */

import { COPY_ID, type ChannelProcedures, type Instant, type SendOutcome } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import {
  callTwilio,
  extractTwilioCall,
  TWILIO_ACCOUNT_SID,
  twilioCallRequest,
  twilioCallStatusRequest,
  twilioEndCallRequest,
  type TwilioCallRead,
  type TwilioCredentials,
  type TwilioFailure,
  type TwilioFetch,
  type TwilioRequest,
} from "@procedures/notify/twilio";
import { isQuotaError, type QuotaError, type QuotaGate, type QuotaState } from "polite-crawler/api";
import { twilioCallDescriptor } from "./descriptor.ts";
import { callFailureOf, callStatusOf, twilioCallOf, type TwilioCallMapOptions } from "./map.ts";

export { CHANNEL_ID, TWILIO_CALL_ADDRESS, TWILIO_CALL_COST_USD, TWILIO_CALL_MAX_IN_FLIGHT, TWILIO_PHONE_PATTERN, twilioCallDescriptor } from "./descriptor.ts";
export { CALL_LAST_SENTENCE, CALL_REPEATS, CALL_SAY_LIMIT, callFailureOf, callStatusOf, spokenTextOf, twilioCallOf } from "./map.ts";
export type { Refusal, TwilioCallMapOptions } from "./map.ts";

/** The time limit of one request to Twilio. */
export const TWILIO_CALL_TIMEOUT_MS = 10_000;

/**
 * The cap of the spend of the account, as two gates of `polite-crawler/api`. The two gates have one store,
 * one key and one quota name, thus they count the same units.
 */
export interface TwilioSpendGates {
  /** The gate of each message below `life-safety`. Its quota keeps the reserve. */
  readonly gate: QuotaGate;
  /** The gate of a `life-safety` message: the same quota with no reserve. Thus only `life-safety` uses the reserve. */
  readonly lifeSafety: QuotaGate;
  /** The units of one call in the quota: for example 4 cents. */
  readonly units: number;
}

/** The options of the Twilio call channel. */
export interface TwilioCallChannelOptions extends TwilioCallMapOptions {
  /** The credentials of the Twilio account. The private configuration gives them at run time. */
  readonly credentials: TwilioCredentials;
  /** The fetch of each request. */
  readonly fetch: TwilioFetch;
  /** The time limit of one request. The default is 10 seconds. */
  readonly timeoutMs?: number | undefined;
  /** This function gives the time in milliseconds since the epoch. The default is `Date.now`. */
  readonly now?: (() => Instant) | undefined;
  /** The cap of the spend. Without it, the channel makes each call. */
  readonly spend?: TwilioSpendGates | undefined;
}

/**
 * This function makes the procedures of the Twilio call channel.
 *
 * - `send` does not throw. A call that Twilio accepted gives the receipt `{ call: <the call SID> }`.
 * - `send` takes the units of the call from the gate of its level before the call. A full cap gives `rate-limited`, and a cap in its reserve gives `reserved`.
 * - A call that Twilio refused, did not authorize or limited gives its units back. A call with no answer keeps them, because it can have started.
 * - `status` does not throw. A receipt that the channel cannot read keeps the state `accepted`.
 * - `cancel` ends the call of a receipt in each state. It is idempotent: Twilio refuses the end of a call that it does not know, and the cancel ends with no error.
 * - `cancel({ copy })` does nothing. A call does not repeat, and Twilio keeps no tag on a call.
 * - `cancel` of a receipt with no valid call SID does nothing.
 * - `cancel` throws for each other failure, thus the caller can try again.
 */
export function createTwilioCallChannel(options: TwilioCallChannelOptions): ChannelProcedures {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? TWILIO_CALL_TIMEOUT_MS;
  const descriptor = twilioCallDescriptor();
  const spend = options.spend;
  if (spend !== undefined && !(Number.isInteger(spend.units) && spend.units > 0)) throw new Error("The units of one call in the cap of the spend are not a whole count above 0.");

  /** One request. */
  const call = (request: TwilioRequest): Promise<TwilioCallRead | TwilioFailure> => callTwilio(options.fetch, request, extractTwilioCall, { timeoutMs });

  return {
    describe: () => descriptor,

    async send({ message, address, copy }): Promise<SendOutcome> {
      if (copy !== undefined && !COPY_ID.test(copy)) return { ok: false, kind: "refused", message: `The copy id "${copy}" has a character that the path of a stop cannot have.` };
      const at = now();
      if (!TWILIO_ACCOUNT_SID.test(options.credentials.accountSid)) return { ok: false, kind: "auth", message: "The account SID is not AC and 32 hexadecimal digits." };
      const mapped = twilioCallOf(message, address, at, options);
      if ("refused" in mapped) return { ok: false, kind: "refused", message: mapped.refused };
      let request: TwilioRequest;
      try {
        request = twilioCallRequest(options.credentials, mapped);
      } catch (error) {
        return { ok: false, kind: "refused", message: `The call breaks a rule of the Twilio API: ${errorMessage(error)}` };
      }
      const gate = spend === undefined ? undefined : message.level === "life-safety" ? spend.lifeSafety : spend.gate;
      let taken: QuotaState | undefined;
      if (spend !== undefined && gate !== undefined) {
        try {
          taken = gate.take(spend.units);
        } catch (error) {
          // A refusal of the gate stops the call. A fault of the store of the gate does not: the call goes with no count.
          if (isQuotaError(error)) return spendRefusal(gate, error, spend, at);
        }
      }
      const result = await call(request);
      // Twilio makes no call for these answers. A network fault, a time-out and a server error can come after the start of a call.
      const notStarted = !result.ok && (result.kind === "auth" || result.kind === "refused" || result.kind === "rate-limited");
      if (notStarted && spend !== undefined && gate !== undefined && taken?.at !== undefined) giveBack(gate, spend.units, taken.at);
      if (!result.ok) return callFailureOf(result);
      return { ok: true, receipt: { call: result.sid }, accepted: at };
    },

    async status({ receipt }) {
      const at = now();
      const sid = receipt["call"];
      if (sid === undefined) return { state: "accepted", at, reason: "The receipt has no call SID." };
      let request: TwilioRequest;
      try {
        request = twilioCallStatusRequest(options.credentials, sid);
      } catch (error) {
        return { state: "accepted", at, reason: `The receipt is not valid: ${errorMessage(error)}` };
      }
      const result = await call(request);
      if (!result.ok) return { state: "accepted", at, reason: `The call was not read: ${result.errors.join(" ")}` };
      return callStatusOf(result, at);
    },

    async cancel(target) {
      if ("copy" in target) return;
      const sid = target.receipt["call"];
      if (sid === undefined) return;
      let request: TwilioRequest;
      try {
        request = twilioEndCallRequest(options.credentials, sid);
      } catch {
        // A receipt with no valid call SID has no call to end. Another try gives the same error.
        return;
      }
      const result = await call(request);
      if (!result.ok && result.kind !== "refused") throw new Error(`Twilio did not end the call (${result.kind}): ${result.errors.join(" ")}`);
    },
  };
}

export * from "./outage.ts";

/**
 * This function gives the refusal of a gate of the spend. The gate of `life-safety` has no reserve, thus
 * its refusal is a full cap. The other gate refuses a call that only `life-safety` can still make.
 */
function spendRefusal(gate: QuotaGate, error: QuotaError, spend: TwilioSpendGates, at: Instant): Extract<SendOutcome, { readonly ok: false }> {
  const state = gate.state();
  const full = gate === spend.lifeSafety || state.blockedUntil !== undefined || state.used + spend.units > gate.quota.limit;
  return { ok: false, kind: full ? "rate-limited" : "reserved", message: error.message, retryAfter: Math.max(0, error.resetAt - at) };
}

/** This function gives back the units of a call that did not start. A failed write changes no outcome of the send. */
function giveBack(gate: QuotaGate, units: number, at: number): void {
  try {
    gate.giveBack?.(units, at);
  } catch {
    // The count stays high by one call until the end of the window. Thus the cap can stop one call too early, never too late.
  }
}
