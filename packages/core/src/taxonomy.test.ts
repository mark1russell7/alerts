import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COVERAGE_KIND, DEFAULT_ASSESS_POLICY, HEALTH_KIND, LIFE_SAFETY_KINDS } from "./assess.ts";
import { DEFAULT_COVERAGE_POLICY } from "./coverage.ts";
import {
  canonicalKind,
  CATEGORIES,
  CATEGORY_LABELS,
  categoryOf,
  KIND_ALIASES,
  kindLabel,
  knownKind,
  parentKind,
  TAXONOMY,
  UNKNOWN_KIND,
  unknownKinds,
} from "./taxonomy.ts";

const CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

describe("the taxonomy", () => {
  const codes = Object.keys(TAXONOMY);

  it("is a tree: each code has the form of a code, a category as its root, a parent in the taxonomy, a plain name and a summary", () => {
    for (const code of codes) {
      expect(code, code).toMatch(CODE);
      const parts = code.split(".");
      expect(Object.hasOwn(CATEGORY_LABELS, parts[0]!), code).toBe(true);
      for (let end = 1; end < parts.length; end += 1) expect(Object.hasOwn(TAXONOMY, parts.slice(0, end).join(".")), code).toBe(true);
      const { label, summary } = TAXONOMY[code]!;
      expect(label.trim(), code).toBe(label);
      expect(label.length, code).toBeGreaterThan(0);
      // The summary is plain text that starts with a capital letter or a number and ends with a full stop.
      expect(summary, code).toMatch(/^[A-Z0-9][^\n]*\.$/);
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

  it("gives the parent of a code from its parts, and null for a category", () => {
    expect(parentKind("met.flood.flash")).toBe("met.flood");
    expect(parentKind("met")).toBeNull();
    for (const code of codes) {
      const parent = parentKind(code);
      expect(parent === null ? CATEGORIES.includes(code as never) : Object.hasOwn(TAXONOMY, parent), code).toBe(true);
    }
  });

  it("gives the plain name of a code, and the code itself for a code that it does not have", () => {
    expect(kindLabel("met.flood.flash")).toBe("Flash flood");
    expect(kindLabel("met")).toBe(CATEGORY_LABELS.met);
    expect(kindLabel("system.coverage.met.tornado")).toBe("system.coverage.met.tornado");
    expect(kindLabel("toString")).toBe("toString");
  });

  it("knows each kind that the first policies name", () => {
    expect(unknownKinds(LIFE_SAFETY_KINDS)).toEqual([]);
    expect(unknownKinds(DEFAULT_ASSESS_POLICY.classes.flatMap((entry) => entry.kinds))).toEqual([]);
    expect(unknownKinds(DEFAULT_COVERAGE_POLICY.needs.flatMap((need) => need.kinds))).toEqual([]);
  });
});

// The lock holds each code that the taxonomy has or had. A stored kind, a configuration or an atlas can name each one.
describe("the lock of the codes", () => {
  const lock = JSON.parse(readFileSync(new URL("./taxonomy.lock.json", import.meta.url), "utf8")) as string[];
  const isCode = (code: string): boolean => Object.hasOwn(TAXONOMY, code);

  it("keeps each locked code: it stays in the taxonomy, or an alias maps it to a code of the taxonomy", () => {
    expect(lock.filter((code) => !isCode(code) && !(Object.hasOwn(KIND_ALIASES, code) && isCode(KIND_ALIASES[code] ?? "")))).toEqual([]);
  });

  it("holds each code of the taxonomy and each old code, sorted and each one time, so a new code comes into the lock in its pull request", () => {
    expect(lock).toEqual([...new Set([...Object.keys(TAXONOMY), ...Object.keys(KIND_ALIASES)])].sort());
  });

  it("has an alias only for an old code, and each alias goes to a code of the taxonomy", () => {
    for (const [old, next] of Object.entries(KIND_ALIASES)) {
      expect(isCode(old), old).toBe(false);
      expect(isCode(next), old).toBe(true);
    }
  });

  it("maps an old code and the coverage of an old code to the new code, and keeps each other code", () => {
    const aliases = { "met.twister": "met.tornado" };
    expect(canonicalKind("met.twister", aliases)).toBe("met.tornado");
    expect(canonicalKind(`${COVERAGE_KIND}.met.twister`, aliases)).toBe(`${COVERAGE_KIND}.met.tornado`);
    expect(canonicalKind("met.tornado", aliases)).toBe("met.tornado");
    expect(canonicalKind("met.twisters", aliases)).toBe("met.twisters");
    expect(canonicalKind("toString", aliases)).toBe("toString");
    expect(canonicalKind(`${COVERAGE_KIND}.toString`, aliases)).toBe(`${COVERAGE_KIND}.toString`);
    expect(canonicalKind("met.twister")).toBe("met.twister");
  });
});
