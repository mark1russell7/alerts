import { knownKind } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";

import {
  COW_MARGIN_MS,
  COW_PHENOMENA,
  COW_QUERY_PHENOMENA,
  COW_UNVERIFIED,
  COW_UNVERIFIED_PHENOMENA,
  cowQuery,
  cowSettings,
  cowWindows,
  phenomenonKind,
  readCow,
  splitWindow,
  tallyCow,
  type CowWarning,
} from "./cow.ts";

/** A synthetic Cow answer, with the structure of the real answers. */
interface Event {
  readonly id: string;
  readonly phenomena: string;
  readonly issue: string;
  readonly verify: boolean;
  readonly stormreports: string;
  readonly significance?: string;
}

const answer = (events: readonly Event[], reports: Readonly<Record<string, string>>, stats?: { events_total: number; events_verified: number }): string =>
  JSON.stringify({
    generated_at: "2026-11-15T00:00:00Z",
    params: { wfo: [], phenomena: ["TO", "SV"], begints: "2024-04-30T00:00:00Z", endts: "2024-06-02T00:00:00Z", lsrbuffer: 15 },
    stats: stats ?? { events_total: events.length, events_verified: events.filter((event) => event.verify).length },
    events: {
      type: "FeatureCollection",
      features: events.map(({ id, ...properties }) => ({ type: "Feature", id, properties: { significance: "W", ...properties }, geometry: null })),
    },
    stormreports: {
      type: "FeatureCollection",
      features: Object.entries(reports).map(([id, lsrtype]) => ({ type: "Feature", id, properties: { lsrtype }, geometry: null })),
    },
  });

const may: { start: number; end: number } = { start: Date.UTC(2024, 4, 1), end: Date.UTC(2024, 5, 1) };

describe("the windows and queries of Cow", () => {
  it("gives one window for each month of the years", () => {
    const windows = cowWindows(2023, 2024);
    expect(windows).toHaveLength(24);
    expect(windows[0]).toEqual({ start: Date.UTC(2023, 0, 1), end: Date.UTC(2023, 1, 1) });
    expect(windows[23]).toEqual({ start: Date.UTC(2024, 11, 1), end: Date.UTC(2025, 0, 1) });
    for (let index = 1; index < windows.length; index += 1) expect(windows[index]?.start).toBe(windows[index - 1]?.end);
    expect(() => cowWindows(2025, 2024)).toThrow(RangeError);
  });

  it("asks for the phenomena of the shares and the unverified phenomena, with a margin of one day, with no office and no state", () => {
    const query = cowQuery(may);
    expect(query).toBe("?begints=2024-04-30T00:00:00Z&endts=2024-06-02T00:00:00Z&phenomena=TO&phenomena=SV&phenomena=FF&phenomena=MA&phenomena=SQ&phenomena=EW");
    expect(query).not.toMatch(/wfo|state|ugc/i);
    expect(COW_MARGIN_MS).toBe(86_400_000);
  });

  it("gives a kind of the taxonomy for each phenomenon", () => {
    for (const phenomenon of COW_QUERY_PHENOMENA) expect(knownKind(phenomenonKind(phenomenon).kind), phenomenon).toBe(true);
    expect(phenomenonKind("TO")).toEqual({ kind: "met.tornado", label: "Tornado" });
  });

  it("keeps the extreme wind warning out of the shares, with its reason, its evidence and the value in its place", () => {
    expect(COW_PHENOMENA).not.toContain("EW");
    expect(COW_UNVERIFIED_PHENOMENA).toEqual(["EW"]);
    expect(COW_QUERY_PHENOMENA).toEqual([...COW_PHENOMENA, ...COW_UNVERIFIED_PHENOMENA]);
    for (const phenomenon of COW_UNVERIFIED_PHENOMENA) {
      const { reason, sources, instead } = COW_UNVERIFIED[phenomenon];
      expect(reason.length).toBeGreaterThan(0);
      expect(instead.length).toBeGreaterThan(0);
      expect(sources.length).toBeGreaterThan(0);
    }
  });

  it("cuts a window in two halves at a whole day, down to one day", () => {
    expect(splitWindow(may)).toEqual([
      { start: Date.UTC(2024, 4, 1), end: Date.UTC(2024, 4, 16) },
      { start: Date.UTC(2024, 4, 16), end: Date.UTC(2024, 5, 1) },
    ]);
    expect(splitWindow({ start: Date.UTC(2024, 4, 1), end: Date.UTC(2024, 4, 3) })).toEqual([
      { start: Date.UTC(2024, 4, 1), end: Date.UTC(2024, 4, 2) },
      { start: Date.UTC(2024, 4, 2), end: Date.UTC(2024, 4, 3) },
    ]);
    expect(splitWindow({ start: Date.UTC(2024, 4, 1), end: Date.UTC(2024, 4, 2) })).toBeUndefined();
  });

  it("removes the window from the parameters", () => {
    expect(cowSettings({ begints: "a", endts: "b", wfo: [], lsrbuffer: 15 })).toEqual({ wfo: [], lsrbuffer: 15 });
  });
});

describe("the reader of a Cow answer", () => {
  const events: Event[] = [
    { id: "2024TEST1TOW1", phenomena: "TO", issue: "2024-05-03T20:00:00Z", verify: true, stormreports: "1,2" },
    { id: "2024TEST2SVW1", phenomena: "SV", issue: "2024-05-10T20:00:00Z", verify: true, stormreports: "2" },
    { id: "2024TEST3SVW1", phenomena: "SV", issue: "2024-05-11T20:00:00Z", verify: false, stormreports: "" },
    { id: "2024TEST4MAW1", phenomena: "MA", issue: "2024-05-12T20:00:00Z", verify: true, stormreports: "3" },
    { id: "2024TEST5TOW1", phenomena: "TO", issue: "2024-04-30T22:00:00Z", verify: true, stormreports: "1" },
    { id: "2024TEST6TOW1", phenomena: "TO", issue: "2024-06-01T01:00:00Z", verify: false, stormreports: "" },
    { id: "2024TEST7TOA1", phenomena: "TO", issue: "2024-05-05T01:00:00Z", verify: false, stormreports: "", significance: "A" },
  ];
  const reports = { "1": "TO", "2": "SV", "3": "TO" };

  it("keeps the warnings that start in the window, and finds the reports of the own hazard", () => {
    const read = readCow(answer(events, reports), may);
    expect(read.total).toBe(7);
    expect(read.params["lsrbuffer"]).toBe(15);
    expect(read.warnings).toEqual([
      { id: "2024TEST1TOW1", phenomenon: "TO", issue: Date.parse("2024-05-03T20:00:00Z"), verified: true, verifiedOwn: true },
      { id: "2024TEST2SVW1", phenomenon: "SV", issue: Date.parse("2024-05-10T20:00:00Z"), verified: true, verifiedOwn: true },
      { id: "2024TEST3SVW1", phenomenon: "SV", issue: Date.parse("2024-05-11T20:00:00Z"), verified: false, verifiedOwn: false },
      { id: "2024TEST4MAW1", phenomenon: "MA", issue: Date.parse("2024-05-12T20:00:00Z"), verified: true, verifiedOwn: false },
    ]);
  });

  it("throws an error when the stats do not agree with the events", () => {
    expect(() => readCow(answer(events, reports, { events_total: 7, events_verified: 2 }), may)).toThrow(/do not agree/);
    expect(() => readCow(answer(events, reports, { events_total: 6, events_verified: 4 }), may)).toThrow(/do not agree/);
  });

  it("throws an error for a report that the answer does not have, or a bad structure", () => {
    expect(() => readCow(answer(events, { "1": "TO", "2": "SV" }), may)).toThrow(/storm report 3/);
    expect(() => readCow(JSON.stringify({ params: {}, stats: {} }), may)).toThrow(/no feature list "stormreports"/);
    expect(() => readCow(JSON.stringify({ params: {} }), may)).toThrow(/no params or no stats/);
    expect(() => readCow(answer([{ ...events[0], issue: "soon" } as Event], reports), may)).toThrow(/bad issue time/);
    expect(() => readCow(answer([{ ...events[0], verify: "yes" } as unknown as Event], reports, { events_total: 1, events_verified: 0 }), may)).toThrow(/does not have the fields/);
  });
});

describe("the counts of the warnings", () => {
  const warning = (id: string, phenomenon: CowWarning["phenomenon"], year: number, verified: boolean, verifiedOwn: boolean): CowWarning => ({
    id,
    phenomenon,
    issue: Date.UTC(year, 5, 1),
    verified,
    verifiedOwn,
  });

  it("counts each phenomenon and each year, and each id one time", () => {
    const tally = tallyCow([
      warning("a", "TO", 2023, true, true),
      warning("a", "TO", 2023, true, true),
      warning("b", "TO", 2024, false, false),
      warning("c", "SV", 2024, true, false),
    ]);
    expect(tally.TO).toEqual({ warnings: 2, verified: 1, verifiedOwn: 1, byYear: { "2023": { warnings: 1, verified: 1, verifiedOwn: 1 }, "2024": { warnings: 1, verified: 0, verifiedOwn: 0 } } });
    expect(tally.SV).toEqual({ warnings: 1, verified: 1, verifiedOwn: 0, byYear: { "2024": { warnings: 1, verified: 1, verifiedOwn: 0 } } });
    expect(tally.EW).toEqual({ warnings: 0, verified: 0, verifiedOwn: 0, byYear: {} });
  });
});
