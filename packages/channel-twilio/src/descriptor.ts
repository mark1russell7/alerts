/**
 * The descriptors of the Twilio voice call channel and of the Twilio text channel, and the form of the phone number of a person.
 */

import { WHY_LIMITS, type AddressField, type ChannelDescriptor, type ChannelId } from "@mark1russell7/alerts";

/** The id of the channel. */
export const CHANNEL_ID = "twilio-call" as ChannelId;

/** The channel makes one call at a time. Thus two calls do not ring the same phone together. */
export const TWILIO_CALL_MAX_IN_FLIGHT = 1;

/**
 * The cost of one call in the United States: 2 minutes at 0.014 US dollars, and 0.0075 for the machine
 * detection, rounded up. The prices are on the voice price page of Twilio.
 */
export const TWILIO_CALL_COST_USD = 0.04;

/**
 * The form of a phone number in E.164 form: a plus sign, the country code and the number, 15 digits or fewer.
 *
 * - A phone number of the North American plan (`+1`) has exactly 10 digits after `+1`.
 * - Its area code and its exchange do not start with 0 or 1.
 * - Thus a number with a missing digit or an extra digit stops the start. A wrong call is the worst silent fault of this channel.
 * - Each number of this form is also a number that `@procedures/notify/twilio` accepts.
 */
export const TWILIO_PHONE_PATTERN = "\\+1[2-9][0-9]{2}[2-9][0-9]{6}|\\+[2-9][0-9]{1,14}";

/** The id of the text channel. */
export const TEXT_CHANNEL_ID = "twilio-text" as ChannelId;

/**
 * The most code points of one text. A text of GSM-7 characters with no extension is one segment. Another text of
 * 160 code points or fewer is at most 3 segments of UCS-2 (67 code points each).
 */
export const TWILIO_TEXT_LIMIT = 160;

/**
 * The cost of one text in the United States, rounded up. A text has at most 3 segments. Each segment costs 0.0083 US dollars,
 * and a carrier fee of 0.005 or less. The prices are on the SMS price page of Twilio. Thus a text costs no more than a call.
 */
export const TWILIO_TEXT_COST_USD = 0.04;

/** The fields of the address of a person on the channel: the phone number to call. */
export const TWILIO_CALL_ADDRESS: readonly AddressField[] = [
  { name: "to", required: true, pattern: TWILIO_PHONE_PATTERN, form: "a phone number in E.164 form: a plus sign, the country code and the number" },
];

/** The address of a text: the phone number of a call, with the opt-in. A text goes only to a phone on the opt-in list. */
export const TWILIO_TEXT_ADDRESS: readonly AddressField[] = TWILIO_CALL_ADDRESS.map((field) => ({ ...field, optIn: true }));

/**
 * This function gives the descriptor of the channel.
 *
 * - A call rings through silent mode and Do Not Disturb on an iPhone only when the contact of the Twilio number has Emergency Bypass on.
 * - The channel has no acknowledgment of its own (`ack` is `none`). An acknowledgment in another channel stops the next calls.
 * - The channel is exclusive: a phone takes one call at a time. Thus a copy with a rank above 0 waits the rank floor before its call.
 */
export function twilioCallDescriptor(): ChannelDescriptor {
  return {
    id: CHANNEL_ID,
    title: "Twilio voice call",
    dependsOn: ["provider:twilio", "provider:carrier"],
    services: ["domain:twilio.com"],
    uses: ["internet", "dns", "power"],
    breaksThrough: true,
    repeats: false,
    ack: "none",
    maxTitle: 200,
    maxBody: 600,
    costUsd: TWILIO_CALL_COST_USD,
    maxInFlight: TWILIO_CALL_MAX_IN_FLIGHT,
    exclusive: true,
    why: WHY_LIMITS.call,
    address: TWILIO_CALL_ADDRESS,
  };
}

/**
 * This function gives the descriptor of the text channel. A text goes to the same phone number as a call.
 *
 * - A text plays the tone of the phone. It rings through silent mode only when its contact has Emergency Bypass on.
 * - The channel has no acknowledgment of its own (`ack` is `none`). An acknowledgment in another channel stops the next steps.
 * - A text needs a registered sender in the United States: the phone of a 10DLC campaign or a verified toll-free phone.
 * - A text goes only to a phone on the opt-in list (`TWILIO_TEXT_ADDRESS`).
 */
export function twilioTextDescriptor(): ChannelDescriptor {
  return {
    id: TEXT_CHANNEL_ID,
    title: "Twilio text message",
    dependsOn: ["provider:twilio", "provider:carrier"],
    services: ["domain:twilio.com"],
    uses: ["internet", "dns", "power"],
    breaksThrough: false,
    repeats: false,
    ack: "none",
    maxTitle: TWILIO_TEXT_LIMIT,
    maxBody: TWILIO_TEXT_LIMIT,
    costUsd: TWILIO_TEXT_COST_USD,
    why: WHY_LIMITS.text,
    address: TWILIO_TEXT_ADDRESS,
  };
}
