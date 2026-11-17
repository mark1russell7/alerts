import { describe, expect, it } from "vitest";
import type { RegionCode, ReportId } from "./contracts.ts";
import { HISTORY_FORMAT, type HistoryChange, type HistoryIncident, type HistoryPayload, type HistoryRegion } from "./history.ts";
import { addHistory, historyTimes, NO_HISTORIES } from "./history-reader.ts";
import type { MapShape } from "./map.ts";

const MINUTE = 60_000;
const T0 = 1_763_157_600_000;
const zone: RegionCode = { system: "ugc", code: "KSZ083" };
const county: RegionCode = { system: "ugc", code: "KSC173" };
const square = (lon: number, lat: number): MapShape => ({
  type: "polygon",
  rings: [
    [
      [lon, lat],
      [lon + 0.1, lat],
      [lon + 0.1, lat + 0.1],
      [lon, lat + 0.1],
      [lon, lat],
    ],
  ],
});
const id = (text: string): ReportId => text as ReportId;

/** A change at a number of minutes after the start, with the codes of its areas. */
const change = (minutes: number, codes: readonly RegionCode[] = [zone], fields: Partial<HistoryChange> = {}): HistoryChange => ({
  at: T0 + minutes * MINUTE,
  reports: [],
  level: "urgent",
  severity: "severe",
  live: true,
  codes,
  shapes: [],
  unshaped: [],
  ...fields,
});

const incident = (anchor: string, changes: readonly HistoryChange[], reports: readonly string[] = [anchor]): HistoryIncident => ({
  anchor: id(anchor),
  reports: reports.map(id),
  status: "actual",
  kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" },
  changes,
});

const region = (code: RegionCode, lon: number): HistoryRegion => ({ code, shapes: [square(lon, 37.6)] });
const ZONE = region(zone, -97.5);
const COUNTY = region(county, -97.4);

/** An answer of the route. Its newest change is the newest change of its incidents, when the test gives no other time. */
function answer(since: number | null, incidents: readonly HistoryIncident[], regions: readonly HistoryRegion[], fields: Partial<HistoryPayload> = {}): HistoryPayload {
  const times = incidents.flatMap((one) => one.changes.map((each) => each.at));
  return { format: HISTORY_FORMAT, at: T0 + 120 * MINUTE, since, next: times.length === 0 ? null : Math.max(...times), incidents, regions, ...fields };
}

describe("addHistory", () => {
  const a = incident("a", [change(0), change(10, [county, zone])]);
  const b = incident("b", [change(5, [county])]);
  const first = addHistory(NO_HISTORIES, answer(null, [b, a], [COUNTY, ZONE]));

  it("keeps each incident of the first answer in the order of the anchors, with the query of the next read", () => {
    expect(first).toEqual({ at: T0 + 120 * MINUTE, since: T0 + 10 * MINUTE, incidents: [a, b], regions: [COUNTY, ZONE] });
    expect(NO_HISTORIES).toEqual({ at: null, since: null, incidents: [], regions: [] });
  });

  it("replaces the history of each incident of a later answer, and keeps each other history", () => {
    const grown = incident("a", [...a.changes, change(30, [zone], { live: false, level: "none" })]);
    const next = addHistory(first, answer(T0 + 10 * MINUTE, [grown], [ZONE], { at: T0 + 121 * MINUTE }));
    expect(next.incidents).toEqual([grown, b]);
    expect(next).toMatchObject({ at: T0 + 121 * MINUTE, since: T0 + 30 * MINUTE });
    // The county stays, because the history of b names it. The later answer did not give its shapes again.
    expect(next.regions).toEqual([COUNTY, ZONE]);
    // An answer with no incident changes no history.
    expect(addHistory(first, answer(T0 + 10 * MINUTE, [], [], { next: T0 + 10 * MINUTE })).incidents).toEqual([a, b]);
  });

  it("drops each history whose anchor is a report of an incident of the answer, because the incidents merged", () => {
    // A report with a smaller id links a and b. Thus the incident of the answer has a new anchor.
    const joined = incident("0", [change(0), change(5, [county, zone]), change(10, [county, zone]), change(40, [county, zone])], ["0", "a", "b"]);
    const next = addHistory(first, answer(T0 + 10 * MINUTE, [joined], [COUNTY, ZONE]));
    expect(next.incidents).toEqual([joined]);
    // The flip: an incident of the answer with other reports drops no history.
    const other = incident("c", [change(40, [county])]);
    expect(addHistory(first, answer(T0 + 10 * MINUTE, [other], [COUNTY])).incidents).toEqual([a, b, other]);
  });

  it("replaces each history by an answer to a read with no since", () => {
    // The runtime retired the incident b. Only a read of each incident tells the reader.
    const next = addHistory(first, answer(null, [a], [COUNTY, ZONE]));
    expect(next.incidents).toEqual([a]);
    expect(next.regions).toEqual([COUNTY, ZONE]);
    // An answer with no incident, and with no newest change, leaves no history.
    expect(addHistory(first, answer(null, [], []))).toEqual({ at: T0 + 120 * MINUTE, since: null, incidents: [], regions: [] });
  });

  it("keeps only the regions of its changes, with the shapes of the newest answer", () => {
    const moved = region(zone, -97.6);
    // The new history of a has only the zone, and the answer gives new shapes for the zone.
    const next = addHistory(first, answer(T0 + 10 * MINUTE, [incident("a", [change(0), change(10)]), incident("b", [change(5, [zone])])], [moved]));
    expect(next.regions).toEqual([moved]);
    // A code with no shapes in an answer or in the histories gets no region.
    const far: RegionCode = { system: "ugc", code: "TXZ205" };
    expect(addHistory(NO_HISTORIES, answer(null, [incident("f", [change(0, [far])])], [])).regions).toEqual([]);
  });

  it("asks for each incident again after a step of the clock: the newest change is below the since of the answer", () => {
    const back = addHistory(first, answer(T0 + 10 * MINUTE, [], [], { next: T0 + 4 * MINUTE }));
    expect(back.since).toBeNull();
    // The histories stay until the answer of the next read replaces them.
    expect(back.incidents).toEqual([a, b]);
    // An answer with no newest change also asks for each incident again.
    expect(addHistory(first, answer(T0 + 10 * MINUTE, [], [], { next: null })).since).toBeNull();
    // The flip: a newest change at the since of the answer keeps the query.
    expect(addHistory(first, answer(T0 + 10 * MINUTE, [], [], { next: T0 + 10 * MINUTE })).since).toBe(T0 + 10 * MINUTE);
  });
});

describe("historyTimes", () => {
  it("gives the time of each change one time, from the oldest", () => {
    const kept = addHistory(NO_HISTORIES, answer(null, [incident("b", [change(5), change(10)]), incident("a", [change(0), change(10), change(2)])], [ZONE]));
    expect(historyTimes(kept)).toEqual([0, 2, 5, 10].map((minutes) => T0 + minutes * MINUTE));
    expect(historyTimes(NO_HISTORIES)).toEqual([]);
  });
});
