/**
 * The Twilio text channel of the alert system (AL-56). Each step on the channel sends one SMS message to the phone of the person.
 *
 * - The text has the title, the why line and the body of the message, with `TWILIO_TEXT_LIMIT` code points or fewer.
 * - The text takes its units from the same gates of the spend as the call channel. Thus one cap holds the calls and the texts.
 * - A text does not repeat, and Twilio cannot cancel a text in its queue. Thus `cancel` does nothing.
 * - No outcome of a send holds a phone number. The reason of a failure has a mark in place of each number of the text.
 * - A text goes only to a number with the opt-in. Each other send fails with the kind `consent`, and Twilio gets no request.
 * - When Twilio refuses a text with the error of a number that replied STOP, the channel records the STOP.
 */

import { addressProblems, type Address, type ChannelProcedures, type DeliveryStatus, type Instant, type Message, type SendOutcome } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import {
  callTwilio,
  extractTwilioText,
  TWILIO_ACCOUNT_SID,
  twilioTextRequest,
  twilioTextStatusRequest,
  type TwilioCredentials,
  type TwilioFailure,
  type TwilioFetch,
  type TwilioRequest,
  type TwilioText,
  type TwilioTextRead,
} from "@procedures/notify/twilio";
import { TWILIO_TEXT_LIMIT, twilioTextDescriptor } from "./descriptor.ts";
import { callFailureOf, messageTextOf, type Refusal } from "./map.ts";
import { takeSpend, type TwilioSpendGates } from "./spend.ts";

/** The time limit of one request of the text channel to Twilio. */
export const TWILIO_TEXT_TIMEOUT_MS = 10_000;

/** The error code of Twilio for a text to a number that replied STOP: "Attempt to send to unsubscribed recipient". */
export const TWILIO_UNSUBSCRIBED = 21610;

/** The opt-in of the numbers of the texts. The runtime gives it from the opt-in list and the STOP and START replies. */
export interface TextOptIn {
  /** This function tells if the number has the opt-in at the time. */
  readonly has: (number: string, at: Instant) => boolean;
  /** This function records a STOP of the number at the time, when Twilio refuses a text with `TWILIO_UNSUBSCRIBED`. */
  readonly stopped: (number: string, at: Instant) => void;
}

/** The options of the map of a message to a text. */
export interface TwilioTextMapOptions {
  /** The registered Twilio number that sends the texts, in E.164 form. The private configuration gives it at run time. */
  readonly from: string;
}

/**
 * This function gives the text of a message, or the reason that the channel does not send it.
 *
 * - A text plays the tone of the phone. Thus a quiet message gets no text.
 * - A message that expired gets no text.
 * - The address has the fields of `TWILIO_CALL_ADDRESS`: `addressProblems` of the core examines it. A refusal names the field, not its value.
 */
export function twilioTextOf(message: Message, address: Address, at: Instant, options: TwilioTextMapOptions): TwilioText | Refusal {
  if (message.quiet) return { refused: "A text plays the tone of the phone, thus a quiet message gets no text." };
  if (message.expires !== undefined && message.expires <= at) return { refused: "The message expired before the send." };
  const problems = addressProblems(address, twilioTextDescriptor());
  const to = address["to"];
  if (problems.length > 0 || to === undefined) return { refused: problems.join(" ") };
  const body = messageTextOf(message, TWILIO_TEXT_LIMIT);
  if (body === "") return { refused: "The message has no text." };
  return { to, from: options.from, body };
}

/**
 * This function gives the state of a text from a read of it.
 *
 * - A text that the carrier delivered is `delivered`. It is not `acknowledged`, because a person did not answer it.
 * - A text that did not go, or that the carrier did not deliver, is `failed`. The reason has the error code of Twilio, and no number.
 * - Each other text is `accepted`. Some carriers give no receipt, so a text can stay `accepted`.
 */
export function textStatusOf(read: TwilioTextRead, at: Instant): DeliveryStatus {
  switch (read.state) {
    case "delivered":
      return { state: "delivered", at: read.updatedAt ?? at, reason: "The carrier delivered the text." };
    case "failed":
      return { state: "failed", at: read.updatedAt ?? at, reason: `The text did not reach the phone (${read.status}${read.errorCode === undefined ? "" : `, Twilio error ${String(read.errorCode)}`}).` };
    case "pending":
      return { state: "accepted", at };
  }
}

/** The options of the Twilio text channel. */
export interface TwilioTextChannelOptions extends TwilioTextMapOptions {
  /** The credentials of the Twilio account. The private configuration gives them at run time. */
  readonly credentials: TwilioCredentials;
  /** The fetch of each request. */
  readonly fetch: TwilioFetch;
  /** The time limit of one request. The default is 10 seconds. */
  readonly timeoutMs?: number | undefined;
  /** This function gives the time in milliseconds since the epoch. The default is `Date.now`. */
  readonly now?: (() => Instant) | undefined;
  /** The cap of the spend, with the units of one text. Without it, the channel sends each text. */
  readonly spend?: TwilioSpendGates | undefined;
  /** The opt-in of the numbers. The channel sends only to a number with the opt-in. */
  readonly optIn: TextOptIn;
}

/**
 * This function makes the procedures of the Twilio text channel.
 *
 * - `send` does not throw. A text that Twilio accepted gives the receipt `{ text: <the message SID> }`.
 * - `send` gives `consent` for a number with no opt-in. Then it takes no units, and Twilio gets no request.
 * - `send` takes the units of the text from the gate of its level before the send. A text that Twilio refused, did not authorize or limited gives its units back.
 * - A refusal of Twilio with `TWILIO_UNSUBSCRIBED` records the STOP of the number, and `send` gives `consent`.
 * - `status` does not throw. A receipt that the channel cannot read keeps the state `accepted`.
 * - `cancel` does nothing.
 */
export function createTwilioTextChannel(options: TwilioTextChannelOptions): ChannelProcedures {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? TWILIO_TEXT_TIMEOUT_MS;
  const descriptor = twilioTextDescriptor();
  const spend = options.spend;
  if (spend !== undefined && !(Number.isInteger(spend.units) && spend.units > 0)) throw new Error("The units of one text in the cap of the spend are not a whole count above 0.");

  /** One request. */
  const text = (request: TwilioRequest): Promise<TwilioTextRead | TwilioFailure> => callTwilio(options.fetch, request, extractTwilioText, { timeoutMs });

  return {
    describe: () => descriptor,

    async send({ message, address }): Promise<SendOutcome> {
      const at = now();
      if (!TWILIO_ACCOUNT_SID.test(options.credentials.accountSid)) return { ok: false, kind: "auth", message: "The account SID is not AC and 32 hexadecimal digits." };
      const mapped = twilioTextOf(message, address, at, options);
      if ("refused" in mapped) return { ok: false, kind: "refused", message: mapped.refused };
      if (!options.optIn.has(mapped.to, at)) return { ok: false, kind: "consent", message: "The number is not on the opt-in list, or it replied STOP. The channel sent no text." };
      let request: TwilioRequest;
      try {
        request = twilioTextRequest(options.credentials, mapped);
      } catch (error) {
        return { ok: false, kind: "refused", message: `The text breaks a rule of the Twilio API: ${errorMessage(error)}` };
      }
      const taken = takeSpend(spend, message.level, at);
      if (!taken.ok) return taken.refusal;
      const result = await text(request);
      // Twilio sends no text for these answers. A network fault, a time-out and a server error can come after the send.
      const notSent = !result.ok && (result.kind === "auth" || result.kind === "refused" || result.kind === "rate-limited");
      if (notSent) taken.giveBack();
      if (!result.ok && result.code === TWILIO_UNSUBSCRIBED) {
        options.optIn.stopped(mapped.to, at);
        return { ok: false, kind: "consent", message: `The number replied STOP, and Twilio refuses each text to it (Twilio error ${String(TWILIO_UNSUBSCRIBED)}).` };
      }
      if (!result.ok) return callFailureOf(result, [mapped.to, options.from]);
      return { ok: true, receipt: { text: result.sid }, accepted: at };
    },

    async status({ receipt }) {
      const at = now();
      const sid = receipt["text"];
      if (sid === undefined) return { state: "accepted", at, reason: "The receipt has no message SID." };
      let request: TwilioRequest;
      try {
        request = twilioTextStatusRequest(options.credentials, sid);
      } catch (error) {
        return { state: "accepted", at, reason: `The receipt is not valid: ${errorMessage(error)}` };
      }
      const result = await text(request);
      if (!result.ok) return { state: "accepted", at, reason: `The text was not read: ${callFailureOf(result, [options.from]).message}` };
      return textStatusOf(result, at);
    },

    // A text does not repeat, and Twilio cannot cancel a text in its queue.
    cancel: async () => undefined,
  };
}
