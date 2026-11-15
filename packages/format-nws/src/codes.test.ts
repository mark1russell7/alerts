import { describe, expect, it } from "vitest";
import { isSameCode, isUgcCode, parseSameLocation, STATE_FIPS, STATE_POSTAL, stateOfSame, stateOfUgc } from "./codes.ts";

describe("isUgcCode", () => {
  it.each(["KSZ001", "TXC123", "GMZ250", "PKZ414"])("accepts %s", (code) => {
    expect(isUgcCode(code)).toBe(true);
  });

  it.each(["", "ksz001", "KSX001", "KS-Z-001", "KSZ01", "KSZ0011", " KSZ001", "020001"])("refuses %j", (code) => {
    expect(isUgcCode(code)).toBe(false);
  });
});

describe("isSameCode", () => {
  it.each(["020001", "048019", "077250", "199001"])("accepts %s", (code) => {
    expect(isSameCode(code)).toBe(true);
  });

  it.each(["", "48019", "0480190", "04801A", " 048019", "KSZ001"])("refuses %j", (code) => {
    expect(isSameCode(code)).toBe(false);
  });
});

describe("parseSameLocation", () => {
  it("reads the part, the state and the county", () => {
    expect(parseSameLocation("048019")).toEqual({ part: "0", state: "48", county: "019" });
    expect(parseSameLocation(" 320173 ")).toEqual({ part: "3", state: "20", county: "173" });
  });

  it("refuses a text that is not six digits", () => {
    for (const text of ["", "48019", "0480190", "04801a", "TXC019"]) expect(parseSameLocation(text), text).toBeUndefined();
  });
});

describe("the state codes", () => {
  it("give one postal code for each FIPS code, both ways", () => {
    const codes = Object.values(STATE_FIPS);
    expect(new Set(codes).size).toBe(codes.length);
    for (const [postal, fips] of Object.entries(STATE_FIPS)) expect(STATE_POSTAL[fips]).toBe(postal);
  });

  it("have the 50 states, the District of Columbia and 6 territories", () => {
    expect(Object.keys(STATE_FIPS)).toHaveLength(57);
    expect(STATE_FIPS["TX"]).toBe("48");
    expect(STATE_FIPS["KS"]).toBe("20");
  });

  it("give the state of a UGC code, and no state for a marine zone", () => {
    expect(stateOfUgc("KSZ083")).toBe("KS");
    expect(stateOfUgc("txc019")).toBe("TX");
    expect(stateOfUgc("GMZ250")).toBeUndefined();
    expect(stateOfUgc("KS")).toBeUndefined();
  });

  it("give the state of a SAME code, and no state for an unknown FIPS code", () => {
    expect(stateOfSame("020173")).toBe("KS");
    expect(stateOfSame("048000")).toBe("TX");
    expect(stateOfSame("003001")).toBeUndefined();
  });
});
