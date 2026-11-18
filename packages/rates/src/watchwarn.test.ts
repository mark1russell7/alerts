import { PHENOMENA } from "@mark1russell7/alerts-format-nws";
import { describe, expect, it } from "vitest";

import {
  ALERT_PHENOMENA,
  ALERT_SIGNIFICANCES,
  alertKey,
  AlertTally,
  alertWindows,
  MARINE_PHENOMENA,
  NATIONAL_NUMBERS,
  nationalNumber,
  numberingDoubts,
  readWatchwarn,
  WATCHWARN_PARAMS,
  watchwarnQuery,
  watchwarnTime,
  type AlertRow,
} from "./watchwarn.ts";

/** The header of the CSV text of the service, with the column of the forecaster. The fixtures keep it empty. */
const HEADER =
  "wfo,utc_issue,utc_expire,utc_prodissue,utc_init_expire,phenomena,gtype,significance,eventid,status,ugc,area2d,utc_updated,is_emergency,utc_polygon_begin,utc_polygon_end,windtag,hailtag,tornadotag,damagetag,product_id,fcster,vtec_year";

interface Line {
  readonly wfo?: string;
  readonly issue?: string;
  readonly expire?: string;
  readonly phenomenon?: string;
  readonly gtype?: string;
  readonly significance?: string;
  readonly eventId?: string;
  readonly ugc?: string;
  readonly year?: string;
}

/** A synthetic row of the CSV text, in Kansas, with the 23 fields of the header. */
const line = ({ wfo = "TOP", issue = "2024-05-06 22:10", expire = "2024-05-06 23:00", phenomenon = "TO", gtype = "C", significance = "W", eventId = "12", ugc = "KSC173", year = "2024" }: Line): string => {
  const fields = [wfo, issue, expire, issue, expire, phenomenon, gtype, significance, eventId, "NEW", ugc, "1000.5", issue, "f", "", "", "", "", "", "", "202405062210-KTOP-WFUS53-TORTOP", "", year];
  expect(fields).toHaveLength(HEADER.split(",").length);
  return fields.join(",");
};

const text = (lines: readonly Line[]): string => [HEADER, ...lines.map(line)].join("\n") + "\n";

/** A row of the reader. */
const row = (fields: Partial<AlertRow> = {}): AlertRow => ({
  wfo: "TOP",
  phenomenon: "TO",
  significance: "W",
  eventId: 12,
  year: 2024,
  ugc: "KSC173",
  issue: Date.UTC(2024, 4, 6, 22, 10),
  expire: Date.UTC(2024, 4, 6, 23),
  ...fields,
});

describe("the requests of the alerts", () => {
  it("asks for each pair of a phenomenon that is not marine and a significance, in order", () => {
    const params = new URLSearchParams(WATCHWARN_PARAMS);
    expect(params.get("accept")).toBe("csv");
    expect(params.get("limitps")).toBe("yes");
    const phenomena = (params.get("phenomena") ?? "").split(",");
    const significances = (params.get("significance") ?? "").split(",");
    expect(phenomena).toHaveLength(ALERT_PHENOMENA.length * ALERT_SIGNIFICANCES.length);
    expect(significances).toHaveLength(phenomena.length);
    expect(phenomena.slice(0, 4)).toEqual([ALERT_PHENOMENA[0], ALERT_PHENOMENA[0], ALERT_PHENOMENA[0], ALERT_PHENOMENA[0]]);
    expect(significances.slice(0, 5)).toEqual(["W", "A", "Y", "S", "W"]);
    expect(ALERT_PHENOMENA).toEqual(expect.arrayContaining(["TO", "SV", "FF", "RP", "HT", "EH", "XH", "WS"]));
  });

  it("does not ask for a marine phenomenon, and the list of the marine phenomena has each marine kind", () => {
    for (const phenomenon of MARINE_PHENOMENA) {
      expect(PHENOMENA[phenomenon], phenomenon).toBeDefined();
      expect(ALERT_PHENOMENA, phenomenon).not.toContain(phenomenon);
    }
    for (const [phenomenon, hazard] of Object.entries(PHENOMENA)) {
      if (hazard.code.startsWith("met.marine.") || hazard.code.endsWith("marine")) expect(MARINE_PHENOMENA, phenomenon).toContain(phenomenon);
    }
    expect([...ALERT_PHENOMENA, ...MARINE_PHENOMENA].sort()).toEqual(Object.keys(PHENOMENA).sort());
  });

  it("gives the query of a window, with no office and no state", () => {
    const query = watchwarnQuery({ start: Date.UTC(2024, 4, 1), end: Date.UTC(2024, 5, 1) });
    expect(query.startsWith("?sts=2024-05-01T00:00:00Z&ets=2024-06-01T00:00:00Z&accept=csv&")).toBe(true);
    expect(query).not.toMatch(/wfo|state|ugc/);
  });

  it("gives one window for each month, and the month before the first year", () => {
    const windows = alertWindows({ first: 2024, last: 2025 });
    expect(windows).toHaveLength(25);
    expect(windows[0]).toEqual({ start: Date.UTC(2023, 11, 1), end: Date.UTC(2024, 0, 1) });
    expect(windows.at(-1)?.end).toBe(Date.UTC(2026, 0, 1));
    for (let index = 1; index < windows.length; index += 1) expect(windows[index]?.start).toBe(windows[index - 1]?.end);
    expect(() => alertWindows({ first: 2025, last: 2024 })).toThrow(RangeError);
  });
});

describe("the reader of the CSV text", () => {
  it("reads the times of the service", () => {
    expect(watchwarnTime("2024-07-01 23:58")).toBe(Date.UTC(2024, 6, 1, 23, 58));
    expect(watchwarnTime("202407012358")).toBe(Date.UTC(2024, 6, 1, 23, 58));
    expect(watchwarnTime("2024-02-30 10:00")).toBeUndefined();
    expect(watchwarnTime("2024-07-01 24:00")).toBeUndefined();
    expect(watchwarnTime("")).toBeUndefined();
  });

  it("keeps the fields of the key, the area and the times, and no other field", () => {
    const read = readWatchwarn(
      text([
        {},
        { ugc: "KSZ083", phenomenon: "WS", significance: "W", eventId: "3", year: "2025", issue: "2025-01-04 09:00", expire: "2025-01-06 00:00" },
        { gtype: "P", ugc: "" },
      ]),
    );
    expect(read.faults).toEqual({});
    expect(read.rows).toEqual([
      row(),
      row({ phenomenon: "WS", eventId: 3, year: 2025, ugc: "KSZ083", issue: Date.UTC(2025, 0, 4, 9), expire: Date.UTC(2025, 0, 6) }),
      row({ ugc: "" }),
    ]);
    expect(JSON.stringify(read)).not.toMatch(/WFUS53|NEW|1000/);
  });

  it("skips a row with no key, and keeps a row with a bad area or time with its fault", () => {
    const read = readWatchwarn(text([{ wfo: "" }, { eventId: "x" }, { year: "24" }, { ugc: "KS173" }, { expire: "" }, { issue: "bad", expire: "bad" }]));
    expect(read.faults).toEqual({ key: 3, ugc: 1, issue: 1, expire: 2 });
    expect(read.rows.map((item) => [item.ugc, item.issue, item.expire])).toEqual([
      ["", Date.UTC(2024, 4, 6, 22, 10), Date.UTC(2024, 4, 6, 23)],
      ["KSC173", Date.UTC(2024, 4, 6, 22, 10), undefined],
      ["KSC173", undefined, undefined],
    ]);
  });

  it("throws an error for a pair that the query did not ask for, a missing column or an empty text", () => {
    expect(() => readWatchwarn(text([{ phenomenon: "MA" }]))).toThrow(/did not ask/);
    expect(() => readWatchwarn(text([{ significance: "O" }]))).toThrow(/did not ask/);
    expect(() => readWatchwarn("wfo,phenomena\nTOP,TO\n")).toThrow(/no column utc_issue/);
    expect(() => readWatchwarn("")).toThrow(/empty/);
  });
});

describe("the count of the alerts", () => {
  it("keys an alert by its office, except a national number", () => {
    expect(alertKey(row())).toBe("TOP.TO.W.12.2024");
    expect(alertKey(row({ significance: "A", eventId: 200 }))).toBe("TO.A.200.2024");
    expect(alertKey(row({ phenomenon: "HU", eventId: 1009 }))).toBe("HU.W.1009.2024");
    expect(nationalNumber("SV", "A")).toBe(true);
    expect(nationalNumber("SS", "W")).toBe(true);
    expect(nationalNumber("TR", "A")).toBe(true);
    expect(nationalNumber("SV", "W")).toBe(false);
    expect(nationalNumber("FF", "A")).toBe(false);
    for (const reason of Object.values(NATIONAL_NUMBERS)) expect(reason.length).toBeGreaterThan(20);
  });

  it("counts each alert one time in the year of its number, and the rows of each area", () => {
    const tally = new AlertTally({ first: 2024, last: 2025 });
    tally.add({
      rows: [
        row(),
        row({ ugc: "KSC177" }),
        row({ wfo: "ICT", issue: Date.UTC(2024, 6, 1) }),
        row({ year: 2023, eventId: 90 }),
        row({ significance: "A", eventId: 200, ugc: "KSC177" }),
        row({ significance: "A", eventId: 200, wfo: "ICT", ugc: "KSC173", issue: Date.UTC(2024, 4, 6, 22, 15) }),
      ],
      faults: { ugc: 1 },
    });
    tally.add({ rows: [row({ phenomenon: "RP", significance: "S", eventId: 4, year: 2025, ugc: "TXZ205", wfo: "EWX", issue: undefined })], faults: { ugc: 2, key: 1 } });
    expect(tally.counts()).toEqual({
      rows: 7,
      alerts: { "RP.S": { "2024": 0, "2025": 1 }, "TO.A": { "2024": 1, "2025": 0 }, "TO.W": { "2024": 2, "2025": 0 } },
      areas: {
        "RP.S": { counties: { "2024": 0, "2025": 0 }, zones: { "2024": 0, "2025": 1 } },
        "TO.A": { counties: { "2024": 2, "2025": 0 }, zones: { "2024": 0, "2025": 0 } },
        "TO.W": { counties: { "2024": 3, "2025": 0 }, zones: { "2024": 0, "2025": 0 } },
      },
      numbering: {
        "TO.A": { national: true, numbers: 1, shared: 1, together: 1 },
        "TO.W": { national: false, numbers: 1, shared: 1, together: 0 },
      },
      faults: { key: 1, ugc: 3 },
    });
  });

  it("counts an area one time when two rows give it, in the year of the alert", () => {
    const tally = new AlertTally({ first: 2024, last: 2025 });
    tally.add({ rows: [row(), row(), row({ ugc: "KSZ083" }), row({ year: 2025, eventId: 7 })], faults: {} });
    expect(tally.counts().areas["TO.W"]).toEqual({ counties: { "2024": 1, "2025": 1 }, zones: { "2024": 1, "2025": 0 } });
  });

  it("tells a doubt of the list of the national numbers only with enough shared numbers", () => {
    const doubts = numberingDoubts({
      "TO.A": { national: true, numbers: 50, shared: 40, together: 10 },
      "SV.A": { national: true, numbers: 50, shared: 40, together: 28 },
      "TO.W": { national: false, numbers: 900, shared: 300, together: 210 },
      "SV.W": { national: false, numbers: 900, shared: 300, together: 174 },
      "HU.W": { national: true, numbers: 5, shared: 5, together: 0 },
    });
    expect(doubts).toEqual(["TO.A has a national number, but only 10 of 40 shared numbers start together.", "TO.W has a number of each office, but 210 of 300 shared numbers start together."]);
  });
});
