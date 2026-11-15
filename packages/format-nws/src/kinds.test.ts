import { describe, expect, it } from "vitest";
import {
  categoryOf,
  EVENT_CODES,
  fromEventCode,
  fromEventName,
  fromPhenomenon,
  hasVtec,
  PHENOMENA,
  resolveKind,
  SIGNIFICANCE,
  UNKNOWN_KIND,
} from "./kinds.ts";
import { parseVtec, type Vtec } from "./vtec.ts";

describe("the kind tables", () => {
  it("start each code with a category of the system", () => {
    for (const hazard of [...Object.values(PHENOMENA), ...Object.values(EVENT_CODES)]) {
      expect(categoryOf(hazard.code), hazard.code).not.toBe("other");
      expect(hazard.code).toMatch(/^[a-z]+(\.[a-z0-9-]+)+$/);
    }
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
