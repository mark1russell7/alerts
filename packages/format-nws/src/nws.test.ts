import { describe, expect, it } from "vitest";
import { NWS_ORIGIN, vtecOffice } from "./nws.ts";

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
