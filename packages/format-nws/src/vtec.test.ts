import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatVtec, formatVtecTime, mainVtec, NO_TIME, parseVtec, vtecEventKey, vtecKey, vtecTime, type Vtec, type VtecClass } from "./vtec.ts";

/** The seeds of the property tests. `SEED=17` or `SEED=1-50` replays or widens a run. */
const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5]);
const CASES = 400;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${LETTERS}0123456789`;
const word = (draw: Random, alphabet: string, length: number): string =>
  Array.from({ length }, () => alphabet.charAt(draw.below(alphabet.length))).join("");

/** A time to the minute from 2000 to 2099, or no time. */
const time = (draw: Random): number | undefined =>
  draw.chance(0.2) ? undefined : Date.UTC(2000, 0, 1) + draw.below(100 * 365 * 24 * 60) * 60_000;

/** One VTEC value in the domain of `formatVtec`. */
function vtecOf(draw: Random): Vtec {
  const start = time(draw);
  const end = time(draw);
  return {
    productClass: draw.pick<VtecClass>(["O", "T", "E", "X"]),
    action: word(draw, LETTERS, 3),
    office: word(draw, ALNUM, 4),
    phenomenon: word(draw, LETTERS, 2),
    significance: word(draw, LETTERS, 1),
    eventNumber: draw.below(10_000),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
}

/**
 * A VTEC text whose times are real times, the zero time, or fields a little past their ranges: a
 * month to 19, a day to 39, an hour to 29 and a minute to 69. Thus part of the times are not real dates.
 */
function looseText(draw: Random): string {
  const two = (below: number): string => String(draw.below(below)).padStart(2, "0");
  const loose = (): string => {
    const choice = draw.next();
    if (choice < 0.1) return NO_TIME;
    if (choice < 0.55) return formatVtecTime(Date.UTC(2000, 0, 1) + draw.below(100 * 365 * 24 * 60) * 60_000);
    return `${two(100)}${two(20)}${two(40)}T${two(30)}${two(70)}Z`;
  };
  return formatVtec(vtecOf(draw)).replace(/\d{6}T\d{4}Z-\d{6}T\d{4}Z/, `${loose()}-${loose()}`);
}

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

  it("gives undefined for a time that is not a real date", () => {
    expect(parseVtec("/O.NEW.KTOP.TO.W.0001.261315T0300Z-261117T0700Z/")).toBeUndefined();
    expect(parseVtec("/O.NEW.KTOP.TO.W.0001.261115T0300Z-260230T0700Z/")).toBeUndefined();
  });

  it("does not throw for any text", () => {
    fc.assert(fc.property(fc.string(), (text) => parseVtec(text) === undefined || typeof parseVtec(text)?.office === "string"));
  });
});

describe("vtecTime", () => {
  it("gives undefined for the zero time, a bad form and a date that does not exist", () => {
    expect(vtecTime(NO_TIME)).toBeUndefined();
    expect(vtecTime("26111T0300Z")).toBeUndefined();
    expect(vtecTime("261315T0300Z")).toBeUndefined();
    expect(vtecTime("261131T0300Z")).toBeUndefined();
    expect(vtecTime("261115T2400Z")).toBeUndefined();
    expect(vtecTime("261115T0360Z")).toBeUndefined();
    expect(vtecTime("280229T0000Z")).toBe(Date.UTC(2028, 1, 29));
  });

  it("is the inverse of formatVtecTime", () => {
    expect(formatVtecTime(undefined)).toBe(NO_TIME);
    expect(formatVtecTime(Date.UTC(2027, 0, 2, 3, 4))).toBe("270102T0304Z");
  });
});

describe("formatVtec and parseVtec", () => {
  for (const seed of SEEDS) {
    it(`parseVtec(formatVtec(v)) is v (seed ${String(seed)})`, () => {
      const draw = random(seed);
      for (let index = 0; index < CASES; index += 1) {
        const vtec = vtecOf(draw);
        expect(parseVtec(formatVtec(vtec)), `seed ${String(seed)} case ${String(index)}`).toEqual(vtec);
      }
    });

    it(`formatVtec(parseVtec(s)) is s for each text that parses (seed ${String(seed)})`, () => {
      const draw = random(seed).fork("loose");
      let parsed = 0;
      for (let index = 0; index < CASES; index += 1) {
        const text = looseText(draw);
        const vtec = parseVtec(text);
        if (vtec === undefined) continue;
        parsed += 1;
        expect(formatVtec(vtec), `seed ${String(seed)} case ${String(index)}`).toBe(text);
      }
      // The loose times are real dates in part of the cases only. The test must see some of each.
      expect(parsed).toBeGreaterThan(0);
      expect(parsed).toBeLessThan(CASES);
    });
  }
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

describe("vtecEventKey", () => {
  it("gives the key of vtecKey from the parts of the event", () => {
    const vtec = parseVtec("/O.NEW.KEWX.FF.W.0108.261108T1923Z-261108T2315Z/") as Vtec;
    const key = vtecEventKey({ office: "KEWX", phenomenon: "FF", significance: "W", eventNumber: 108, year: 2026 });
    expect(key).toEqual({ system: "vtec", id: "KEWX.FF.W.0108.2026" });
    expect(vtecKey(vtec, Date.UTC(2026, 10, 8, 19, 23))).toEqual(key);
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
