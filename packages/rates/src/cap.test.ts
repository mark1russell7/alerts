import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CAP_DAYS,
  CAP_FORMAT,
  CAP_ORIGIN,
  CAP_SKIPS,
  capCount,
  capCounts,
  capFile,
  capGaps,
  capQuery,
  capSummary,
  CapTally,
  capWindow,
  nextPath,
  readCapFile,
  readCapPage,
  type CapAlert,
  type CapRun,
} from "./cap.ts";

// Made-up alerts. The offices, the numbers and the times are not real.
const TORNADO = "/O.NEW.KTOP.TO.W.0042.261118T2100Z-261118T2145Z/";
const FLOOD = "/O.NEW.KICT.FF.W.0007.261118T2200Z-261119T0100Z/";

const alert = (fields: Partial<CapAlert> = {}): CapAlert => ({
  id: "urn:oid:test.1",
  sent: "2026-11-14T15:00:00-06:00",
  status: "Actual",
  messageType: "Alert",
  severity: "Extreme",
  urgency: "Immediate",
  certainty: "Observed",
  vtec: [TORNADO],
  ...fields,
});

const day = (text: string): number => Date.parse(`${text}T00:00:00Z`);
const zeros = Object.fromEntries(CAP_SKIPS.map((skip) => [skip, 0])) as CapRun["skipped"];

const run = (start: string, end: string, months: CapRun["months"] = {}): CapRun => ({
  start: `${start}T00:00:00Z`,
  end: `${end}T00:00:00Z`,
  pages: 1,
  read: 0,
  counted: 0,
  skipped: zeros,
  days: {},
  months,
});

describe("the window of a run", () => {
  it("is the whole UTC days before the day of the run", () => {
    const now = Date.parse("2026-11-18T10:30:00Z");
    expect(capWindow(now)).toEqual({ start: day("2026-11-12"), end: day("2026-11-18") });
    expect(CAP_DAYS).toBe(6);
  });

  it("starts at the end of the last run of the file, and is absent when no whole day is new", () => {
    const file = capFile(undefined, run("2026-11-09", "2026-11-15"));
    expect(capWindow(Date.parse("2026-11-18T10:30:00Z"), file)).toEqual({ start: day("2026-11-15"), end: day("2026-11-18") });
    expect(capWindow(Date.parse("2026-11-15T23:59:00Z"), file)).toBeUndefined();
  });

  it("reads at most the days of the API after a long break", () => {
    const file = capFile(undefined, run("2026-09-01", "2026-09-07"));
    expect(capWindow(Date.parse("2026-11-18T10:30:00Z"), file)).toEqual({ start: day("2026-11-12"), end: day("2026-11-18") });
  });
});

describe("the pages of the NWS API", () => {
  it("asks for the alerts of the window, with the most alerts on each page", () => {
    expect(capQuery({ start: day("2026-11-12"), end: day("2026-11-18") })).toBe("/alerts?start=2026-11-12T00%3A00%3A00Z&end=2026-11-18T00%3A00%3A00Z&limit=500");
  });

  it("follows a link of the same origin and refuses a link to another host", () => {
    expect(nextPath(`${CAP_ORIGIN}/alerts?cursor=abc&limit=500`)).toBe("/alerts?cursor=abc&limit=500");
    expect(() => nextPath("https://example.org/alerts?cursor=abc")).toThrow(/example\.org/);
  });

  it("reads the fields of each alert and the link of the next page", () => {
    const body = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          properties: {
            id: "urn:oid:test.1",
            sent: "2026-11-14T15:00:00-06:00",
            status: "Actual",
            messageType: "Alert",
            severity: "Extreme",
            urgency: "Immediate",
            certainty: "Observed",
            parameters: { VTEC: [TORNADO], AWIPSidentifier: ["TORTOP"] },
          },
        },
        { properties: { id: "urn:oid:test.2", status: "Test" } },
      ],
      pagination: { next: `${CAP_ORIGIN}/alerts?cursor=abc` },
    });
    const page = readCapPage(body);
    expect(page.next).toBe(`${CAP_ORIGIN}/alerts?cursor=abc`);
    expect(page.alerts).toEqual([alert(), { id: "urn:oid:test.2", sent: "", status: "Test", messageType: "", severity: "", urgency: "", certainty: "", vtec: [] }]);
    expect(readCapPage(JSON.stringify({ features: [] }))).toEqual({ alerts: [] });
  });

  it("refuses a text that is not a collection of alerts with ids", () => {
    expect(() => readCapPage(JSON.stringify({ title: "Not Found" }))).toThrow(/no list features/);
    expect(() => readCapPage(JSON.stringify({ features: [{ properties: {} }] }))).toThrow(/alert 0/);
  });
});

describe("the count of one alert", () => {
  it("gives the UTC month, the VTEC code and the CAP fields of the first message of an actual alert", () => {
    expect(capCount(alert())).toEqual({ month: "2026-11", code: "TO.W", key: "extreme/immediate/observed" });
    expect(capCount(alert({ severity: "Unknown", urgency: "Future", certainty: "Possible" }))).toEqual({ month: "2026-11", code: "TO.W", key: "unknown/future/possible" });
    // The local time is in October, and the UTC time is in November.
    expect(capCount(alert({ sent: "2026-10-31T20:30:00-06:00" }))).toMatchObject({ month: "2026-11" });
  });

  it("gives the reason that an alert does not count", () => {
    expect(capCount(alert({ status: "Test" }))).toEqual({ skip: "status" });
    expect(capCount(alert({ messageType: "Update" }))).toEqual({ skip: "message type" });
    expect(capCount(alert({ vtec: [] }))).toEqual({ skip: "no new VTEC" });
    expect(capCount(alert({ vtec: [TORNADO.replace("NEW", "CON")] }))).toEqual({ skip: "no new VTEC" });
    expect(capCount(alert({ vtec: [TORNADO.replace("/O.", "/T.")] }))).toEqual({ skip: "no new VTEC" });
    expect(capCount(alert({ vtec: [TORNADO, FLOOD] }))).toEqual({ skip: "several codes" });
    expect(capCount(alert({ severity: "Bad" }))).toEqual({ skip: "fields" });
    expect(capCount(alert({ sent: "" }))).toEqual({ skip: "fields" });
  });

  it("counts an alert with two VTEC strings of one code one time", () => {
    expect(capCount(alert({ vtec: [TORNADO, TORNADO.replace("0042", "0043")] }))).toMatchObject({ code: "TO.W" });
  });
});

describe("the tally of a run", () => {
  it("counts each alert one time, in its month, with the months, the codes and the keys in their order", () => {
    const tally = new CapTally();
    tally.add(alert({ id: "a", vtec: [FLOOD], severity: "Severe", urgency: "Expected", certainty: "Likely" }));
    tally.add(alert({ id: "b" }));
    tally.add(alert({ id: "c", certainty: "Likely", sent: "2026-10-31T23:00:00Z" }));
    tally.add(alert({ id: "b" }));
    tally.add(alert({ id: "d", status: "Exercise" }));
    const result = tally.run({ start: day("2026-10-28"), end: day("2026-11-03") }, 2);
    expect(result).toEqual({
      start: "2026-10-28T00:00:00Z",
      end: "2026-11-03T00:00:00Z",
      pages: 2,
      read: 5,
      counted: 3,
      skipped: { ...zeros, repeat: 1, status: 1 },
      days: { "2026-10-31": 1, "2026-11-14": 3 },
      months: {
        "2026-10": { "TO.W": { "extreme/immediate/likely": 1 } },
        "2026-11": { "FF.W": { "severe/expected/likely": 1 }, "TO.W": { "extreme/immediate/observed": 1 } },
      },
    });
    expect(Object.keys(result.months)).toEqual(["2026-10", "2026-11"]);
    expect(Object.keys(result.skipped)).toEqual([...CAP_SKIPS]);
  });
});

describe("the gaps of a run", () => {
  it("are the UTC days of the window with no alert", () => {
    const days = { "2026-11-13": 400, "2026-11-14": 380, "2026-11-16": 2 };
    expect(capGaps({ ...run("2026-11-12", "2026-11-17"), days })).toEqual(["2026-11-12", "2026-11-15"]);
    expect(capGaps({ ...run("2026-11-13", "2026-11-15"), days })).toEqual([]);
  });
});

describe("the file of the CAP fields", () => {
  const first = run("2026-10-27", "2026-11-02", {
    "2026-10": { "TO.W": { "extreme/immediate/observed": 2 } },
    "2026-11": { "TO.W": { "extreme/immediate/likely": 1 } },
  });
  const second = run("2026-11-02", "2026-11-08", { "2026-11": { "TO.W": { "extreme/immediate/observed": 1 }, "FF.W": { "severe/expected/likely": 4 } } });

  it("keeps the record of each run in the order of the windows, and adds the counts of each month", () => {
    const file = capFile(capFile(undefined, second), first);
    expect(file.format).toBe(CAP_FORMAT);
    expect(file.runs.map((each) => each.start)).toEqual([first.start, second.start]);
    expect(file.runs[0]).not.toHaveProperty("months");
    expect(file.months).toEqual({
      "2026-10": { "TO.W": { "extreme/immediate/observed": 2 } },
      "2026-11": { "FF.W": { "severe/expected/likely": 4 }, "TO.W": { "extreme/immediate/likely": 1, "extreme/immediate/observed": 1 } },
    });
  });

  it("refuses a run whose window overlaps a run of the file", () => {
    const file = capFile(undefined, first);
    expect(() => capFile(file, run("2026-11-01", "2026-11-04"))).toThrow(/overlaps/);
    expect(() => capFile(file, first)).toThrow(/overlaps/);
  });

  it("is committed in its format, with the windows in order and with no overlap", () => {
    const committed = readCapFile(readFileSync(new URL("../data/cap.json", import.meta.url), "utf8"));
    expect(committed.origin).toBe(CAP_ORIGIN);
    committed.runs.forEach((each, index) => {
      const before = committed.runs[index - 1];
      if (before !== undefined) expect(Date.parse(each.start)).toBeGreaterThanOrEqual(Date.parse(before.end));
    });
  });

  it("reads its own text and refuses another format", () => {
    const file = capFile(capFile(undefined, first), second);
    expect(readCapFile(JSON.stringify(file))).toEqual(file);
    expect(() => readCapFile(JSON.stringify({ ...file, format: "alerts-cap/0" }))).toThrow(/alerts-cap\/1/);
    expect(() => readCapFile(JSON.stringify({ format: CAP_FORMAT, runs: [] }))).toThrow(/alerts-cap\/1/);
  });

  it("sums the keys of a code over the months, or over the given months", () => {
    const file = capFile(capFile(undefined, first), second);
    expect(capCounts(file.months, "TO.W")).toEqual({ alerts: 4, keys: { "extreme/immediate/likely": 1, "extreme/immediate/observed": 3 } });
    expect(capCounts(file.months, "TO.W", ["2026-10"])).toEqual({ alerts: 2, keys: { "extreme/immediate/observed": 2 } });
    expect(capCounts(file.months, "SV.W")).toEqual({ alerts: 0, keys: {} });
  });

  it("gives a summary with the most frequent key of each code of the run", () => {
    const file = capFile(capFile(undefined, first), second);
    const text = capSummary(file, second);
    expect(text).toContain("The file has 2 runs over 2 months.");
    expect(text).toContain("These days of the window have no alert: 2026-11-02, 2026-11-03, 2026-11-04, 2026-11-05, 2026-11-06, 2026-11-07.");
    expect(text).toContain("| FF.W | 4 | 4 | severe/expected/likely | 1.00 |");
    expect(text).toContain("| TO.W | 1 | 4 | extreme/immediate/observed | 0.75 |");
    expect(text.indexOf("| FF.W")).toBeLessThan(text.indexOf("| TO.W"));
  });
});
