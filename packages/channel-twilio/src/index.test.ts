import { addressProblems, channelDescriptorSchema, WHY_LIMITS } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { CHANNEL_ID, TWILIO_CALL_COST_USD, twilioCallDescriptor } from "./index.ts";

// Fake numbers only: the country code +999 has no country, and the area codes 555 and 999 of the plan have no phones.
const FORM = "a phone number in E.164 form: a plus sign, the country code and the number";

describe("the descriptor", () => {
  it("is a valid descriptor of a voice call with no acknowledgment of its own", () => {
    const descriptor = twilioCallDescriptor();
    expect(channelDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(descriptor).toMatchObject({ id: CHANNEL_ID, breaksThrough: true, repeats: false, ack: "none", maxInFlight: 1, exclusive: true, costUsd: TWILIO_CALL_COST_USD });
    expect(descriptor.id).toBe("twilio-call");
    expect(descriptor.dependsOn).toEqual(["provider:twilio", "provider:carrier"]);
    expect(descriptor.services).toEqual(["domain:twilio.com"]);
    // A call takes the why line of the call limit: 12 words.
    expect(descriptor.why).toEqual(WHY_LIMITS.call);
  });
});

describe("the phone number of an address", () => {
  const problemsOf = (to: string): string[] => addressProblems({ to }, twilioCallDescriptor());

  it("accepts a number in E.164 form", () => {
    for (const to of ["+15555550123", "+19995550100", "+99900000001", "+999123", "+999123456789012"]) expect(problemsOf(to), to).toEqual([]);
  });

  it("refuses a number of the North American plan with a missing digit, an extra digit or a bad area code", () => {
    for (const to of ["+1555555012", "+155555501234", "+11555550123", "+15551550123", "+1555555012a"]) {
      expect(problemsOf(to), to).toEqual([`The field to of the address on twilio-call is not ${FORM}.`]);
    }
  });

  it("refuses a number with no plus sign, a space, a dash, a leading 0 or more than 15 digits", () => {
    for (const to of ["15555550123", "+1 555 555 0123", "+1-555-555-0123", "+0999123", "+9991234567890123", "+", ""]) {
      expect(problemsOf(to), to).toEqual([`The field to of the address on twilio-call is not ${FORM}.`]);
    }
  });

  it("refuses an address with no number or with a field that the channel does not read", () => {
    expect(addressProblems({}, twilioCallDescriptor())).toEqual([`The address on twilio-call has no field to. The channel needs ${FORM}.`]);
    expect(addressProblems({ to: "+15555550123", phone: "+15555550123" }, twilioCallDescriptor())).toEqual([
      "The address on twilio-call has the field phone, and the channel reads no such field.",
    ]);
  });
});
