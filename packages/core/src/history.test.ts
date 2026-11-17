import { describe, expect, it } from "vitest";
import { assess, reachedAssessment } from "./assess.ts";
import type { MergeState, ObservationId, PersonId, PersonWatch, PlaceId, RegionCode, Report, ReportId, SourceId } from "./contracts.ts";
import { HISTORY_FORMAT, historyPayload, OWN_ENTRY_TIMES, type EntryTimes, type HistoryInput } from "./history.ts";
import { reportId } from "./ids.ts";
import type { MapPlaceInput, MapShape, ShapeLookup } from "./map.ts";
import { EMPTY_STATE, incidents } from "./merge.ts";
import { historyPayloadSchema } from "./schemas.ts";

const MINUTE = 60_000;
const T0 = 1_763_157_600_000;
const PLACE = "place:a" as PlaceId;
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
const SHAPES = new Map<string, readonly MapShape[]>([
  ["ugc KSZ083", [square(-97.5, 37.6)]],
  ["ugc KSC173", [square(-97.4, 37.6)]],
]);
const shape: ShapeLookup = (code) => SHAPES.get(`${code.system} ${code.code}`);
const place: MapPlaceInput = { id: PLACE, label: "Place A", codes: [county, zone], bufferKm: 0 };
const person: PersonWatch = { person: "person:a" as PersonId, places: [PLACE], rules: [] };

interface Draft extends Partial<Omit<Report, "id" | "source">> {
  readonly key: string;
}

function report(draft: Draft): Report {
  const sent = draft.sent ?? T0;
  const source = "nws-api" as SourceId;
  return {
    origin: "nws",
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" },
    categories: ["met"],
    severity: "severe",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    received: sent,
    expires: sent + 60 * MINUTE,
    areas: [{ type: "code", ...zone }],
    about: [],
    sender: "NWS Topeka KS",
    headline: "Tornado Warning",
    observation: "0".repeat(64) as ObservationId,
    parameters: {},
    ...draft,
    id: reportId({ source, key: draft.key, sent }),
    source,
    sent,
  };
}

const merge = (reports: readonly Report[], fields: Partial<MergeState> = {}): MergeState => ({ ...EMPTY_STATE, reports, ...fields });
const input = (state: MergeState, fields: Partial<HistoryInput> = {}): HistoryInput => ({ at: T0 + 120 * MINUTE, merge: state, people: [person], places: [place], shape, ...fields });

// The first warning, and an update ten minutes later that adds the county and raises the severity.
const first = report({ key: "w1" });
const update = report({ key: "w2", sent: T0 + 10 * MINUTE, op: "update", references: ["w1"], severity: "extreme", areas: [{ type: "code", ...zone }, { type: "code", ...county }] });
const ids = (...reports: readonly Report[]): ReportId[] => reports.map((one) => one.id).sort();

describe("historyPayload", () => {
  it("gives one change for each time of entry, with the level, the severity and the codes at that time", () => {
    const state = merge([first, update]);
    const payload = historyPayload(input(state));
    expect(payload).toMatchObject({ format: HISTORY_FORMAT, at: T0 + 120 * MINUTE, since: null, next: T0 + 10 * MINUTE });
    expect(payload.incidents).toHaveLength(1);
    const [history] = payload.incidents;
    expect(history?.reports).toEqual(ids(first, update));
    expect(history?.changes.map((change) => [change.at, change.reports, change.severity, change.codes])).toEqual([
      [T0, [first.id], "severe", [zone]],
      [T0 + 10 * MINUTE, [update.id], "extreme", [county, zone]],
    ]);
    // The level of each change is the level of the person for the incident of the known reports at that time.
    const levelAt = (known: readonly Report[], at: number): string => reachedAssessment(assess(incidents(merge(known), at)[0]!, person, [place], undefined, at)).level;
    expect(history?.changes.map((change) => change.level)).toEqual([levelAt([first], T0), levelAt([first, update], T0 + 10 * MINUTE)]);
    expect(history?.changes[0]?.level).not.toBe("none");
    // The shapes of each code come one time, in the payload.
    expect(payload.regions).toEqual([
      { code: county, shapes: SHAPES.get("ugc KSC173") },
      { code: zone, shapes: SHAPES.get("ugc KSZ083") },
    ]);
    expect(historyPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("gives a change for an end mark, and the incident is then not live", () => {
    const ended = { report: update.id, at: T0 + 20 * MINUTE, ended: true };
    const payload = historyPayload(input(merge([first, update], { ends: [ended] })));
    const last = payload.incidents[0]?.changes.at(-1);
    expect(last).toMatchObject({ at: T0 + 20 * MINUTE, reports: [], live: false, level: "none" });
    expect(payload.next).toBe(T0 + 20 * MINUTE);
    // The flip: a mark of a report that this copy does not know yet gives no change.
    const early = { report: report({ key: "other" }).id, at: T0 + 30 * MINUTE, ended: true };
    expect(historyPayload(input(merge([first, update], { ends: [early] }))).incidents[0]?.changes).toHaveLength(2);
  });

  it("joins two parts of an incident before their merge into one change", () => {
    const a = report({ key: "a", correlation: [{ system: "x", id: "1" }] });
    const b = report({ key: "b", sent: T0 + 5 * MINUTE, severity: "moderate", areas: [{ type: "code", ...county }], correlation: [{ system: "x", id: "2" }] });
    const link = report({ key: "c", sent: T0 + 15 * MINUTE, correlation: [{ system: "x", id: "1" }, { system: "x", id: "2" }] });
    const payload = historyPayload(input(merge([a, b, link])));
    expect(payload.incidents).toHaveLength(1);
    expect(payload.incidents[0]?.changes.map((change) => [change.at, change.reports, change.severity, change.codes])).toEqual([
      [T0, [a.id], "severe", [zone]],
      // The parts of a and b give one change: the higher severity, and the codes of both.
      [T0 + 5 * MINUTE, [b.id], "severe", [county, zone]],
      [T0 + 15 * MINUTE, [link.id], "severe", [county, zone]],
    ]);
  });

  it("gives only the incidents with a change at since or later, each with each of its changes", () => {
    const other = report({ key: "o1", sent: T0 + 40 * MINUTE, kind: { code: "hydro.flood", significance: "warning", label: "Flood Warning" }, areas: [{ type: "code", ...county }] });
    const state = merge([first, update, other]);
    const all = historyPayload(input(state));
    expect(all.incidents).toHaveLength(2);
    const later = historyPayload(input(state, { since: T0 + 30 * MINUTE }));
    expect(later.incidents.map((history) => history.reports)).toEqual([[other.id]]);
    expect(later).toMatchObject({ since: T0 + 30 * MINUTE, next: T0 + 40 * MINUTE });
    // The regions hold only the codes of the payload.
    expect(later.regions.map((region) => region.code)).toEqual([county]);
    // A since at the newest change gives that incident again.
    expect(historyPayload(input(state, { since: T0 + 40 * MINUTE })).incidents).toHaveLength(1);
    expect(historyPayload(input(state, { since: T0 + 40 * MINUTE + 1 })).incidents).toEqual([]);
  });

  it("uses the time of entry on this copy, thus a late import comes after the since of a reader", () => {
    const imported = report({ key: "w3", sent: T0 + 50 * MINUTE, received: T0 + 50 * MINUTE, op: "update", references: ["w2"] });
    const state = merge([first, update, imported]);
    const own = new Map([[imported.id, T0 + 90 * MINUTE]]);
    const entered: EntryTimes = { ...OWN_ENTRY_TIMES, report: (one) => own.get(one.id) ?? one.received };
    const payload = historyPayload(input(state, { since: T0 + 60 * MINUTE, entered }));
    expect(payload.incidents[0]?.changes.at(-1)).toMatchObject({ at: T0 + 90 * MINUTE, reports: [imported.id] });
    // The flip: with the time of receipt, the import is before the since.
    expect(historyPayload(input(state, { since: T0 + 60 * MINUTE })).incidents).toEqual([]);
  });

  it("uses the time of entry of an end mark, thus the incident stays live until this copy knew the mark", () => {
    const ended = { report: update.id, at: T0 + 20 * MINUTE, ended: true };
    const state = merge([first, update], { ends: [ended] });
    const entered: EntryTimes = { ...OWN_ENTRY_TIMES, mark: (mark) => (mark === ended ? T0 + 50 * MINUTE : mark.at) };
    const changes = historyPayload(input(state, { entered })).incidents[0]?.changes ?? [];
    expect(changes.map((change) => [change.at, change.live])).toEqual([
      [T0, true],
      [T0 + 10 * MINUTE, true],
      [T0 + 50 * MINUTE, false],
    ]);
    // The flip: with the own time of the mark, the end is at 20 minutes.
    expect(historyPayload(input(state)).incidents[0]?.changes.at(-1)).toMatchObject({ at: T0 + 20 * MINUTE, live: false });
  });

  it("tells a step of the clock back: next is below since", () => {
    const payload = historyPayload(input(merge([first, update]), { since: T0 + 60 * MINUTE }));
    expect(payload.incidents).toEqual([]);
    expect(payload.next).toBeLessThan(T0 + 60 * MINUTE);
    expect(historyPayload(input(EMPTY_STATE))).toMatchObject({ next: null, incidents: [], regions: [] });
  });

  it("lists a code with no shape as unshaped, and keeps the polygons of the reports", () => {
    const far: RegionCode = { system: "ugc", code: "TXZ205" };
    const polygon = square(-98.5, 29.4);
    const odd = report({ key: "p1", areas: [{ type: "code", ...far }, polygon, { ...polygon }] });
    const change = historyPayload(input(merge([odd]))).incidents[0]?.changes[0];
    expect(change).toMatchObject({ codes: [], unshaped: [far], shapes: [polygon] });
  });

  it("refuses a payload of another format", () => {
    const payload = historyPayload(input(merge([first])));
    expect(historyPayloadSchema.safeParse({ ...payload, format: "alerts-history/0" }).success).toBe(false);
  });
});
