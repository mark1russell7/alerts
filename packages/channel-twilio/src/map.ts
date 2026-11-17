/**
 * The maps of the Twilio call channel. One map gives the voice call of a message. The other map gives
 * the delivery state of a read of a call.
 */

import { addressProblems, type Address, type DeliveryStatus, type Instant, type Message, type SendOutcome } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { type TwilioCall, type TwilioCallRead, type TwilioFailure, twilioSayTwiml } from "@procedures/notify/twilio";
import { twilioCallDescriptor } from "./descriptor.ts";

/** The most code points of the text that a call says one time, before the last sentence. */
export const CALL_SAY_LIMIT = 600;

/** The count of times that a call says its text. A person who wakes up at the first time hears the second time. */
export const CALL_REPEATS = 2;

/**
 * The last sentence of each call. A call has no acknowledgment of its own, thus the person
 * acknowledges in the app, and the acknowledgment stops the next calls.
 */
export const CALL_LAST_SENTENCE = "To stop the calls, acknowledge the alert in the app.";

/** The options of the map of a message to a call. */
export interface TwilioCallMapOptions {
  /** The Twilio number that calls, in E.164 form. The private configuration gives it at run time. */
  readonly from: string;
  /** The time that the call rings before it is not answered. Without it, Twilio uses 60 seconds. */
  readonly ringMs?: number | undefined;
}

/** The reason that the channel does not make a call. */
export interface Refusal {
  readonly refused: string;
}

// A part of the spoken text as one sentence: one space between two words, and a stop at the end.
function sentence(part: string): string {
  const words = part.trim().replace(/\s+/g, " ");
  return /[.!?]$/.test(words) ? words : `${words}.`;
}

// The start of a text with `limit` code points or fewer. The cut is at the end of a word when the text has a space.
// The cut adds a stop, thus a cut with no space keeps one code point free for it.
function cut(text: string, limit: number): string {
  const points = [...text];
  if (points.length <= limit) return text;
  const start = points.slice(0, limit).join("");
  const space = start.lastIndexOf(" ");
  return sentence(space > 0 ? start.slice(0, space) : points.slice(0, limit - 1).join(""));
}

/**
 * This function gives the title, the why line and the body of a message as sentences, with `limit` code points or fewer.
 * The cut is at the end of a word.
 */
export function messageTextOf(message: Message, limit: number): string {
  const parts = [message.title, message.why, message.body].flatMap((part) => (part === undefined || part.trim() === "" ? [] : [sentence(part)]));
  return cut(parts.join(" "), limit);
}

/**
 * This function gives the text that a call says. The text has the title, the why line and the body of the
 * message as sentences, with `CALL_SAY_LIMIT` code points or fewer. `CALL_LAST_SENTENCE` follows them.
 */
export function spokenTextOf(message: Message): string {
  return `${messageTextOf(message, CALL_SAY_LIMIT)} ${CALL_LAST_SENTENCE}`.trim();
}

/**
 * This function gives the call of a message, or the reason that the channel does not make it.
 *
 * - A call has no silent mode. Thus a quiet message gets no call.
 * - A message that expired gets no call.
 * - The address has the fields of `TWILIO_CALL_ADDRESS`: `addressProblems` of the core examines it. A refusal names the field, not its value.
 * - The call says its text `CALL_REPEATS` times, and its machine detection tells a person from a machine.
 */
export function twilioCallOf(message: Message, address: Address, at: Instant, options: TwilioCallMapOptions): TwilioCall | Refusal {
  if (message.quiet) return { refused: "A call has no silent mode, thus a quiet message gets no call." };
  if (message.expires !== undefined && message.expires <= at) return { refused: "The message expired before the send." };
  const problems = addressProblems(address, twilioCallDescriptor());
  const to = address["to"];
  if (problems.length > 0 || to === undefined) return { refused: problems.join(" ") };
  let twiml: string;
  try {
    twiml = twilioSayTwiml(spokenTextOf(message), CALL_REPEATS);
  } catch (error) {
    return { refused: `The text of the call breaks a rule of TwiML: ${errorMessage(error)}` };
  }
  return { to, from: options.from, twiml, machineDetection: "Enable", ...(options.ringMs === undefined ? {} : { ringMs: options.ringMs }) };
}

/**
 * This function gives the failure of a send from a failure of Twilio. An error of Twilio can quote a phone number.
 * Thus the message has the mark `[number]` in place of each number of `numbers`, also with no plus sign.
 */
export function callFailureOf(failure: TwilioFailure, numbers: readonly string[] = []): Extract<SendOutcome, { readonly ok: false }> {
  const code = failure.code === undefined ? "" : ` (Twilio error ${failure.code})`;
  const forms = numbers.flatMap((number) => [number, number.replace(/^\+/u, "")]);
  const message = redactSecrets(`${failure.errors.join(" ")}${code}`, forms, { mark: "[number]" });
  switch (failure.kind) {
    case "auth":
    case "refused":
      return { ok: false, kind: failure.kind, message };
    default:
      return { ok: false, kind: failure.kind, message, ...(failure.retryAfterMs === undefined ? {} : { retryAfter: failure.retryAfterMs }) };
  }
}

/**
 * This function gives the state of a call from a read of it.
 *
 * - A call that a person or a machine answered is `delivered`. It is not `acknowledged`, because the machine
 *   detection can take a voice mailbox for a person.
 * - A call that nobody answered, and a call that Twilio could not make, are `failed`.
 * - Each other call is `accepted`.
 */
export function callStatusOf(read: TwilioCallRead, at: Instant): DeliveryStatus {
  switch (read.state) {
    case "answered":
      return { state: "delivered", at: read.startedAt ?? at, reason: "A person answered the call." };
    case "connected":
      return { state: "delivered", at: read.startedAt ?? at, reason: "Someone answered the call." };
    case "machine":
      return { state: "delivered", at: read.startedAt ?? at, reason: "A machine answered the call." };
    case "unanswered":
      return { state: "failed", at: read.endedAt ?? at, reason: `Nobody answered the call (${read.status}).` };
    case "failed":
      return { state: "failed", at: read.endedAt ?? at, reason: "Twilio could not make the call." };
    case "pending":
      return { state: "accepted", at };
  }
}
