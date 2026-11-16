/**
 * The Twilio voice call channel of the alert system. This package gives the descriptor of the channel and the
 * form of the phone number of a person. The send, status and cancel procedures come with AL-15, from
 * `@procedures/notify/twilio`.
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

/** The fields of the address of a person on the channel: the phone number to call. */
export const TWILIO_CALL_ADDRESS: readonly AddressField[] = [
  { name: "to", required: true, pattern: TWILIO_PHONE_PATTERN, form: "a phone number in E.164 form: a plus sign, the country code and the number" },
];

/**
 * This function gives the descriptor of the channel.
 *
 * - A call rings through silent mode and Do Not Disturb on an iPhone only when the contact of the Twilio number has Emergency Bypass on.
 * - The channel has no acknowledgment of its own (`ack` is `none`). An acknowledgment in another channel stops the next calls.
 */
export function twilioCallDescriptor(): ChannelDescriptor {
  return {
    id: CHANNEL_ID,
    title: "Twilio voice call",
    dependsOn: ["provider:twilio", "provider:carrier"],
    uses: ["internet", "power"],
    breaksThrough: true,
    repeats: false,
    ack: "none",
    maxTitle: 200,
    maxBody: 600,
    costUsd: TWILIO_CALL_COST_USD,
    maxInFlight: TWILIO_CALL_MAX_IN_FLIGHT,
    why: WHY_LIMITS.call,
    address: TWILIO_CALL_ADDRESS,
  };
}
