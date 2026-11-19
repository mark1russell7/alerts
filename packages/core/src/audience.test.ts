import { describe, expect, it } from "vitest";
import { audienceKey, audienceOf, inAudience, isPrivate } from "./audience.ts";
import type { PersonId } from "./contracts.ts";

// The audience of a report or an incident: public with no addresses, else the sorted set of its addresses (AL-92).

const a = "person-a" as PersonId;
const b = "person-b" as PersonId;

describe("the audience of a report", () => {
  it("is public with no addresses, and private with addresses", () => {
    expect(isPrivate({})).toBe(false);
    expect(isPrivate({ addresses: undefined })).toBe(false);
    expect(isPrivate({ addresses: [a] })).toBe(true);
  });

  it("gives each address one time, in the order of the code units", () => {
    expect(audienceOf([b, a, b])).toEqual([a, b]);
    expect(audienceOf([])).toEqual([]);
  });

  it("gives one key for each audience, and the same key for the same addresses in any order", () => {
    expect(audienceKey({})).toBe("public");
    expect(audienceKey({ addresses: [b, a] })).toBe(audienceKey({ addresses: [a, b, a] }));
    expect(audienceKey({ addresses: [a] })).not.toBe(audienceKey({ addresses: [b] }));
    expect(audienceKey({ addresses: [a] })).not.toBe(audienceKey({}));
  });

  it("holds each person for a public item, and only its addresses for a private item", () => {
    expect(inAudience({}, a)).toBe(true);
    expect(inAudience({ addresses: [a] }, a)).toBe(true);
    expect(inAudience({ addresses: [a] }, b)).toBe(false);
  });
});
