import { categoryOf, knownKind, LIFE_SAFETY_KINDS, hasKind, UNKNOWN_KIND, unknownKinds } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  categoryOf as movedCategoryOf,
  EVENT_CODES,
  fromEventCode,
  fromEventName,
  fromPhenomenon,
  hasVtec,
  KIND_PREFIXES,
  NAME_ALIASES,
  PHENOMENA,
  resolveKind,
  SIGNIFICANCE,
  VTEC_KIND_PREFIXES,
} from "./kinds.ts";
import { parseVtec, type Vtec } from "./vtec.ts";

describe("the kind tables", () => {
  it("start each code with a category of the system", () => {
    for (const hazard of [...Object.values(PHENOMENA), ...Object.values(EVENT_CODES)]) {
      expect(categoryOf(hazard.code), hazard.code).not.toBe("other");
      expect(hazard.code).toMatch(/^[a-z]+(\.[a-z0-9-]+)+$/);
    }
  });

  // The gate of the taxonomy: a code with a typo does not match the life-safety class.
  const tableCodes = [...Object.values(PHENOMENA), ...Object.values(EVENT_CODES), ...Object.values(NAME_ALIASES)].map((hazard) => hazard.code);

  it("give only codes of the taxonomy of the core", () => {
    expect(unknownKinds(tableCodes)).toEqual([]);
    expect(knownKind(UNKNOWN_KIND)).toBe(true);
  });

  it("give a code of the taxonomy for each input, also for an input that no table knows", () => {
    const codes = [...Object.keys(EVENT_CODES), ...Object.keys(PHENOMENA).flatMap((phenomenon) => Object.keys(SIGNIFICANCE).map((letter) => phenomenon + letter))];
    const names = [...Object.keys(NAME_ALIASES), ...Object.values(EVENT_CODES).map((event) => event.label)];
    const text = (known: readonly string[]): fc.Arbitrary<string> => fc.oneof(fc.constantFrom(...known), fc.string());
    const facts = fc.record({ nwsCode: text(codes), sameCode: text([...codes, "NWS"]), name: text(names) }, { requiredKeys: [] });
    fc.assert(fc.property(facts, (input) => knownKind(resolveKind(input).kind.code)));
  });

  it("keep the moved categoryOf as the function of the core", () => {
    expect(movedCategoryOf).toBe(categoryOf);
  });

  it("reach each kind of the life-safety class", () => {
    for (const prefix of LIFE_SAFETY_KINDS) expect(tableCodes.filter((code) => hasKind([prefix], code)), prefix).not.toEqual([]);
  });

  it("calculate a code of phenomenon and significance", () => {
    expect(fromPhenomenon("TO", "W")).toEqual({ code: "met.tornado", label: "Tornado Warning", significance: "warning" });
    expect(fromPhenomenon("FA", "A")).toEqual({ code: "met.flood.areal", label: "Areal Flood Watch", significance: "watch" });
    expect(fromPhenomenon("QQ", "W")).toBeUndefined();
    expect(fromPhenomenon("TO", "Q")).toBeUndefined();
  });

  it("read three-letter codes from the table first, then as phenomenon and significance", () => {
    expect(fromEventCode("TOR")?.code).toBe("met.tornado");
    expect(fromEventCode("ffa")?.significance).toBe("watch");
    expect(fromEventCode("GLW")).toEqual({ code: "met.marine.gale", label: "Gale Warning", significance: "warning" });
    expect(fromEventCode("ZZZ")).toBeUndefined();
  });

  it("find each calculated event name: the same code, or a broader one for a shared name", () => {
    for (const phenomenon of Object.keys(PHENOMENA)) {
      for (const letter of Object.keys(SIGNIFICANCE)) {
        const event = fromPhenomenon(phenomenon, letter);
        if (event === undefined) continue;
        const found = fromEventName(event.label)?.code ?? "";
        expect(event.code === found || event.code.startsWith(`${found}.`), `${event.label}: ${found}`).toBe(true);
      }
    }
    expect(fromEventName("Flash Flood Watch")?.code).toBe("met.flood.flash");
    expect(fromEventName("Flood Warning")?.code).toBe("met.flood");
    expect(fromEventName("  red   FLAG warning ")?.code).toBe("fire.weather");
  });
});

describe("resolveKind", () => {
  const vtec = [parseVtec("/O.CON.KPSR.FA.W.0044.000000T0000Z-261117T1800Z/") as Vtec];

  it("prefers the VTEC to the codes and the name", () => {
    expect(resolveKind({ vtec, nwsCode: "FLW", sameCode: "FLS", name: "Flood Warning" })).toEqual({
      kind: { code: "met.flood.areal", significance: "warning", label: "Flood Warning" },
      known: true,
    });
  });

  it("uses the NWS code, then the SAME code, then the name", () => {
    expect(resolveKind({ nwsCode: "SPS", name: "Special Weather Statement" }).kind.code).toBe("met.special");
    expect(resolveKind({ sameCode: "CEM", name: "Civil Emergency Message" }).kind.code).toBe("safety.civil-emergency");
    expect(resolveKind({ sameCode: "NWS", name: "Tornado Warning" }).kind.code).toBe("met.tornado");
  });

  it("keeps the name of an unknown event and says so", () => {
    expect(resolveKind({ name: "Volcanic Haze Notice" })).toEqual({ kind: { code: UNKNOWN_KIND, label: "Volcanic Haze Notice" }, known: false });
    expect(resolveKind({})).toEqual({ kind: { code: UNKNOWN_KIND, label: "Unknown event" }, known: false });
  });
});

describe("hasVtec", () => {
  it("is true for the code of each phenomenon and significance, in any case", () => {
    for (const [phenomenon, significance] of [["BZ", "W"], ["TO", "W"], ["FF", "W"], ["SC", "Y"], ["CF", "S"], ["HW", "A"]] as const) {
      expect(hasVtec(`${phenomenon}${significance}`)).toBe(true);
      expect(hasVtec(` ${phenomenon.toLowerCase()}${significance.toLowerCase()} `)).toBe(true);
    }
  });

  it("is false for the outlook, the civil messages, the tests and the statements with no VTEC", () => {
    for (const code of ["HWO", "FRW", "LEW", "SPS", "TST", "ADR", "EAN", "CDW", "EVI", "NWS", "", "BZWX"]) expect(hasVtec(code)).toBe(false);
  });

  it("agrees with fromPhenomenon for each pair of the tables", () => {
    for (const phenomenon of Object.keys(PHENOMENA)) {
      for (const significance of Object.keys(SIGNIFICANCE)) {
        const code = `${phenomenon}${significance}`;
        if (["HWO", "FRW", "LEW"].includes(code)) continue;
        expect(hasVtec(code)).toBe(code.length === 3);
      }
    }
  });
});

describe("the kind prefixes", () => {
  it("gives the first part of each code of the VTEC phenomena, in the prefixes of all kinds", () => {
    const first = (code: string): string => code.split(".", 1)[0] ?? "";
    expect(new Set(VTEC_KIND_PREFIXES)).toEqual(new Set(Object.values(PHENOMENA).map((hazard) => first(hazard.code))));
    for (const prefix of VTEC_KIND_PREFIXES) expect(KIND_PREFIXES).toContain(prefix);
    expect([...VTEC_KIND_PREFIXES].sort()).toEqual(VTEC_KIND_PREFIXES);
  });
});
