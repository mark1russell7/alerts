import { describe, expect, it } from "vitest";
import { COVERAGE_KIND, DEFAULT_ASSESS_POLICY, HEALTH_KIND, LIFE_SAFETY_KINDS } from "./assess.ts";
import { DEFAULT_COVERAGE_POLICY } from "./coverage.ts";
import { CATEGORIES, CATEGORY_LABELS, categoryOf, knownKind, TAXONOMY, UNKNOWN_KIND, unknownKinds } from "./taxonomy.ts";

const CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

describe("the taxonomy", () => {
  const codes = Object.keys(TAXONOMY);

  it("is a tree: each code has the form of a code, a category as its root, a parent in the taxonomy and a plain name", () => {
    for (const code of codes) {
      expect(code, code).toMatch(CODE);
      const parts = code.split(".");
      expect(Object.hasOwn(CATEGORY_LABELS, parts[0]!), code).toBe(true);
      for (let end = 1; end < parts.length; end += 1) expect(Object.hasOwn(TAXONOMY, parts.slice(0, end).join(".")), code).toBe(true);
      const label = TAXONOMY[code]!;
      expect(label.trim(), code).toBe(label);
      expect(label.length, code).toBeGreaterThan(0);
    }
  });

  it("has the categories as roots, with the 12 categories of CAP 1.2 first", () => {
    expect(CATEGORIES.slice(0, 12)).toEqual(["geo", "met", "safety", "security", "rescue", "fire", "health", "env", "transport", "infra", "cbrne", "other"]);
    expect(CATEGORIES.filter((category) => !Object.hasOwn(TAXONOMY, category))).toEqual([]);
    expect(codes.filter((code) => !code.includes(".")).sort()).toEqual([...CATEGORIES].sort());
  });

  it("gives the category of a code from its first part, and other for a part that is not a category", () => {
    expect(categoryOf("met.flood.flash")).toBe("met");
    expect(categoryOf("cbrne")).toBe("cbrne");
    expect(categoryOf("weather.tornado")).toBe("other");
    expect(categoryOf("constructor.x")).toBe("other");
    expect(categoryOf("")).toBe("other");
  });

  it("knows the codes of the core: the unknown kind, each health kind and the coverage of each code that is not a code of the system", () => {
    expect(knownKind(UNKNOWN_KIND)).toBe(true);
    for (const state of ["unknown", "healthy", "slow", "failing", "silent", "changed", "late"]) expect(knownKind(`${HEALTH_KIND}.${state}`), state).toBe(true);
    expect(knownKind(`${HEALTH_KIND}.broken`)).toBe(false);
    expect(knownKind(`${COVERAGE_KIND}.met.tornado`)).toBe(true);
    expect(knownKind(`${COVERAGE_KIND}.met`)).toBe(true);
    expect(knownKind(COVERAGE_KIND)).toBe(true);
    expect(knownKind(`${COVERAGE_KIND}.met.tornadoes`)).toBe(false);
    expect(knownKind(`${COVERAGE_KIND}.${HEALTH_KIND}.failing`)).toBe(false);
    expect(knownKind(`${COVERAGE_KIND}.`)).toBe(false);
  });

  it("does not take a part of a code or a code with a typo", () => {
    expect(knownKind("met.tornado")).toBe(true);
    expect(knownKind("met.tornadoes")).toBe(false);
    expect(knownKind("met.tornado.")).toBe(false);
    expect(knownKind("Met.Tornado")).toBe(false);
    expect(knownKind("toString")).toBe(false);
  });

  it("gives the unknown codes sorted and each one time", () => {
    expect(unknownKinds(["met.x", "met.tornado", "geo.y", "met.x"])).toEqual(["geo.y", "met.x"]);
    expect(unknownKinds([])).toEqual([]);
  });

  it("knows each kind that the first policies name", () => {
    expect(unknownKinds(LIFE_SAFETY_KINDS)).toEqual([]);
    expect(unknownKinds(DEFAULT_ASSESS_POLICY.classes.flatMap((entry) => entry.kinds))).toEqual([]);
    expect(unknownKinds(DEFAULT_COVERAGE_POLICY.needs.flatMap((need) => need.kinds))).toEqual([]);
  });
});
