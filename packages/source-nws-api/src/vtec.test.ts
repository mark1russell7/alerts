import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mainVtec, parseVtec, vtecKey, vtecTime, type Vtec } from "./vtec.ts";

describe("parseVtec", () => {
  it("reads each part of a P-VTEC string", () => {
    expect(parseVtec("/O.EXT.KCRP.FL.W.0029.261115T0300Z-261117T0700Z/")).toEqual({
      productClass: "O",
      action: "EXT",
      office: "KCRP",
      phenomenon: "FL",
      significance: "W",
      eventNumber: 29,
      start: Date.UTC(2026, 10, 15, 3, 0),
      end: Date.UTC(2026, 10, 17, 7, 0),
    });
  });

  it("gives no start for an event that already started", () => {
    const vtec = parseVtec("/O.CON.PAFG.BZ.W.0037.000000T0000Z-261115T1600Z/");
    expect(vtec?.start).toBeUndefined();
    expect(vtec?.end).toBe(Date.UTC(2026, 10, 15, 16, 0));
  });

  it("gives undefined for a text that is not P-VTEC", () => {
    expect(parseVtec("")).toBeUndefined();
    expect(parseVtec("/O.EXT.KCRP.FL.W.29.261115T0300Z-261117T0700Z/")).toBeUndefined();
    expect(parseVtec("/1.ROU.KCRP.FL.W.0029.261115T0300Z-261117T0700Z/")).toBeUndefined();
  });

  it("does not throw for any text", () => {
    fc.assert(fc.property(fc.string(), (text) => parseVtec(text) === undefined || typeof parseVtec(text)?.office === "string"));
  });
});

describe("vtecTime", () => {
  it("gives undefined for the zero time and a bad time", () => {
    expect(vtecTime("000000T0000Z")).toBeUndefined();
    expect(vtecTime("26111T0300Z")).toBeUndefined();
  });
});

describe("vtecKey", () => {
  const sent = Date.UTC(2026, 11, 31, 22, 0);

  it("takes the year from the start of the event", () => {
    const vtec = parseVtec("/O.NEW.KBOU.WS.W.0003.270101T0600Z-270102T0000Z/") as Vtec;
    expect(vtecKey(vtec, sent)).toEqual({ system: "vtec", id: "KBOU.WS.W.0003.2027" });
  });

  it("takes the year from the sent time when the event already started", () => {
    const vtec = parseVtec("/O.CON.KBOU.WS.W.0003.000000T0000Z-270102T0000Z/") as Vtec;
    expect(vtecKey(vtec, sent)).toEqual({ system: "vtec", id: "KBOU.WS.W.0003.2026" });
  });
});

describe("mainVtec", () => {
  const parse = (text: string): Vtec => parseVtec(text) as Vtec;
  const cancel = parse("/O.CAN.KTOP.WS.A.0002.000000T0000Z-261115T1200Z/");
  const upgrade = parse("/O.UPG.KTOP.WS.A.0002.000000T0000Z-261115T1200Z/");
  const warning = parse("/O.NEW.KTOP.WS.W.0004.261115T0000Z-261115T1200Z/");
  const test = parse("/T.NEW.KTOP.TO.W.9999.261115T0000Z-261115T0100Z/");

  it("chooses the first operational VTEC that does not close its event", () => {
    expect(mainVtec([upgrade, warning])).toBe(warning);
    expect(mainVtec([test, cancel, warning])).toBe(warning);
  });

  it("gives the first operational VTEC when each one closes its event", () => {
    expect(mainVtec([cancel, upgrade])).toBe(cancel);
  });

  it("gives undefined with no operational VTEC", () => {
    expect(mainVtec([test])).toBeUndefined();
    expect(mainVtec([])).toBeUndefined();
  });
});
