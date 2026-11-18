import { getCountries } from "libphonenumber-js/max";
import { describe, expect, it } from "vitest";
import { phoneRegion, senderType, twilioCallServices, twilioRegion, TWILIO_REGIONS, twilioTextServices, type TwilioRegion } from "./carrier.ts";

// Each number is in a range for fiction: 555-01xx of North America, 020 7946 0xxx of the United Kingdom, and
// 0491 570 156 of Australia. Thus no test names a real phone.
const US = "+12025550143";
const CANADA = "+14165550123";
const PUERTO_RICO = "+17875550123";
const JAMAICA = "+18765550123";
const UK = "+442079460000";
const AUSTRALIA = "+61491570156";
const TOLL_FREE = "+18005550100";
const NO_COUNTRY = ["+15555550123", "+999123", "12345", "", "not a phone"];

describe("the region of the carrier network", () => {
  it("gives each country of libphonenumber-js one region, and the table has no other country", () => {
    const listed = Object.values(TWILIO_REGIONS).flat();
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...getCountries()].sort());
  });

  it("gives the region of each phone, with the United States territories in North America and Jamaica in Latin America", () => {
    const regions: Record<string, TwilioRegion | undefined> = Object.fromEntries([US, CANADA, PUERTO_RICO, JAMAICA, UK, AUSTRALIA].map((phone) => [phone, phoneRegion(phone)]));
    expect(regions).toEqual({ [US]: "north-america", [CANADA]: "north-america", [PUERTO_RICO]: "north-america", [JAMAICA]: "latin-america", [UK]: "europe", [AUSTRALIA]: "apac" });
    expect(["ZA", "AE", "TR", "MX", "XX"].map(twilioRegion)).toEqual(["middle-east-africa", "middle-east-africa", "europe", "latin-america", undefined]);
  });

  it("gives no region for a number with no country, and does not throw", () => {
    for (const phone of [...NO_COUNTRY, undefined]) expect(phoneRegion(phone)).toBeUndefined();
  });
});

describe("the type of the sender", () => {
  it("gives a short code, a toll-free number and a long code, and no type for a number that is not valid", () => {
    expect(["12345", "123456", TOLL_FREE, US, UK, "1234", "+15555550123", "not a phone"].map(senderType)).toEqual([
      "short-code",
      "short-code",
      "toll-free",
      "long-code",
      "long-code",
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("the carrier services of a contact", () => {
  it("gives the voice node of the region of a call", () => {
    expect(twilioCallServices({ to: US })).toEqual(["provider-region:twilio/north-america/voice"]);
    expect(twilioCallServices({ to: JAMAICA })).toEqual(["provider-region:twilio/latin-america/voice"]);
    expect(twilioCallServices({ to: AUSTRALIA })).toEqual(["provider-region:twilio/apac/voice"]);
  });

  it("adds the type of the sender to a text in North America, for each of the three types", () => {
    const text = (from?: string) => twilioTextServices({ to: CANADA }, from);
    expect([text("12345"), text(TOLL_FREE), text(US)]).toEqual([
      ["provider-region:twilio/north-america/sms/short-code"],
      ["provider-region:twilio/north-america/sms/toll-free"],
      ["provider-region:twilio/north-america/sms/long-code"],
    ]);
    // With no sender, or a sender that is not valid, the node is the SMS of North America.
    expect([text(), text("not a phone")]).toEqual([["provider-region:twilio/north-america/sms"], ["provider-region:twilio/north-america/sms"]]);
  });

  it("gives the SMS node of the other regions with no type", () => {
    expect(twilioTextServices({ to: UK }, TOLL_FREE)).toEqual(["provider-region:twilio/europe/sms"]);
    expect(twilioTextServices({ to: JAMAICA }, US)).toEqual(["provider-region:twilio/latin-america/sms"]);
  });

  it("gives an empty list for an address with no phone of a known country", () => {
    for (const to of NO_COUNTRY) {
      expect(twilioCallServices({ to })).toEqual([]);
      expect(twilioTextServices({ to }, US)).toEqual([]);
    }
    expect(twilioCallServices({})).toEqual([]);
    expect(twilioTextServices({ other: US })).toEqual([]);
  });
});
