import { describe, expect, it } from "vitest";
import type { Report } from "@mark1russell7/alerts";
import { NWS_ORIGIN, nwsEvent, vtecOffice } from "./nws.ts";

describe("NWS_ORIGIN", () => {
  it("is the origin of the NWS messages in each source", () => {
    expect(NWS_ORIGIN).toBe("nws");
  });
});

describe("vtecOffice", () => {
  it("adds K to an office of the contiguous states", () => {
    expect(vtecOffice("EWX")).toBe("KEWX");
    expect(vtecOffice("TOP")).toBe("KTOP");
  });

  it("gives the own ids of the offices of Alaska, Hawaii, Guam and Puerto Rico", () => {
    expect(["AFC", "AFG", "AJK", "HFO", "GUM", "SJU"].map(vtecOffice)).toEqual(["PAFC", "PAFG", "PAJK", "PHFO", "PGUM", "TJSJ"]);
  });

  it.each(["", "ewx", "KEWX", "EW", "E1X", " EWX"])("refuses %j", (id) => {
    expect(vtecOffice(id)).toBeUndefined();
  });
});

describe("nwsEvent", () => {
  // Only the parameters and the kind change the result, so the test gives only these fields.
  const report = (parameters: Report["parameters"]): Report => ({ parameters, kind: { code: "met.flood", label: "Flood" } }) as unknown as Report;

  it("gives the SAME code first", () => {
    expect(nwsEvent(report({ "eventCode.SAME": ["FFW"], "eventCode.NationalWeatherService": ["FFW2"] }))).toBe("FFW");
  });

  it("gives the NWS code when the message has no SAME code", () => {
    expect(nwsEvent(report({ "eventCode.NationalWeatherService": ["FLS"] }))).toBe("FLS");
  });

  it("gives the code of the kind when the message has no event code", () => {
    expect(nwsEvent(report({}))).toBe("met.flood");
  });
});
