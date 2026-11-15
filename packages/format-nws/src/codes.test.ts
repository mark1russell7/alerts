import { describe, expect, it } from "vitest";
import { isSameCode, isUgcCode } from "./codes.ts";

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
