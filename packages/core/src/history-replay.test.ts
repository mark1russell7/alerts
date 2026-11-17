/**
 * The reader of the history against the map. A reader keeps the answers of the history route, and it makes the view
 * of a past time from them. At each time, this view is the view that the map route gave at that time.
 */
import { describe, expect, it } from "vitest";
import type { EndMark, Instant, MergeState, ObservationId, PersonId, PersonWatch, PlaceId, RegionCode, Report, ReportId, SourceId } from "./contracts.ts";
import { historyPayload, type HistoryInput } from "./history.ts";
import { addHistory, historyTimes, historyView, NO_HISTORIES, type Histories } from "./history-reader.ts";
import { reportId } from "./ids.ts";
import { compareMapIncidents, mapPayload, type MapPlaceInput, type MapShape, type MapView, type ShapeLookup } from "./map.ts";
import { EMPTY_STATE, incidents } from "./merge.ts";

const MINUTE = 60_000;
const T0 = 1_763_157_600_000;
const END = T0 + 120 * MINUTE;
const zone: RegionCode = { system: "ugc", code: "KSZ083" };
const county: RegionCode = { system: "ugc", code: "KSC173" };
const north: RegionCode = { system: "ugc", code: "KSZ990" };
const far: RegionCode = { system: "ugc", code: "TXZ205" };
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
  ["ugc KSZ990", [square(-97.5, 37.9)]],
]);
const shape: ShapeLookup = (code) => SHAPES.get(`${code.system} ${code.code}`);
const HOME: MapPlaceInput = { id: "place:a" as PlaceId, label: "Place A", at: [-97.45, 37.65], codes: [county, zone], bufferKm: 0 };
const WORK: MapPlaceInput = { id: "place:b" as PlaceId, label: "Place B", codes: [north], bufferKm: 0 };
const AWAY: MapPlaceInput = { id: "place:c" as PlaceId, label: "Place C", codes: [far], bufferKm: 0 };
const places = [HOME, WORK, AWAY];
// The second person gets a lower level at the home. Thus the level of a place is the highest level over two people.
const people: readonly PersonWatch[] = [
  { person: "person:a" as PersonId, places: [HOME.id, WORK.id], rules: [] },
  { person: "person:b" as PersonId, places: [HOME.id], rules: [{ max: "notice" }] },
];

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
    expires: sent + 600 * MINUTE,
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

// A tornado warning on the zone of the home. An update adds the county and raises the severity.
const tornado = report({ key: "t1" });
const larger = report({ key: "t2", sent: T0 + 10 * MINUTE, op: "update", references: ["t1"], severity: "extreme", areas: [{ type: "code", ...zone }, { type: "code", ...county }] });
// A flood warning with a polygon and a code with no shape. No report ends it: it leaves the map at its expiry.
const FLOOD = { code: "hydro.flood", significance: "warning", label: "Flood Warning" } as const;
const flood = report({ key: "f1", sent: T0 + 20 * MINUTE, kind: FLOOD, severity: "moderate", expires: T0 + 45 * MINUTE, areas: [square(-98.5, 29.4), { type: "code", ...far }] });
// A wind advisory on the zone of the work place. Its source ends it before its expiry.
const WIND = { code: "met.wind", significance: "advisory", label: "Wind Advisory" } as const;
const wind = report({ key: "w1", sent: T0 + 30 * MINUTE, kind: WIND, severity: "minor", urgency: "expected", areas: [{ type: "code", ...north }] });
const ended: EndMark = { report: wind.id, at: T0 + 50 * MINUTE, ended: true };
// A second tornado warning comes after the end of the first one, as an incident of its own.
const second = report({ key: "t9", sent: T0 + 70 * MINUTE, expires: T0 + 100 * MINUTE });

const REPORTS = [tornado, larger, flood, wind, second];
const ENDS = [{ report: larger.id, at: T0 + 60 * MINUTE, ended: true }, ended];
/** The merge state that the runtime had at a time: the reports and the end marks that came in at that time or before. */
const stateAt = (at: Instant): MergeState => ({ ...EMPTY_STATE, reports: REPORTS.filter((each) => each.received <= at), ends: ENDS.filter((mark) => mark.at <= at) });
const input = (at: Instant, since: Instant | null = null): HistoryInput => ({ at, since, merge: stateAt(at), people, places, shape });

/** The view of the map route at a time: the incidents of the reports that the runtime knew, at that time. */
const mapAt = (at: Instant): MapView => mapPayload({ at, incidents: incidents(stateAt(at), at), coverage: [], people, places, shape, basemap: [] }).view;

/**
 * This function gives a view with the anchors of the present. An incident of a past time has the anchor of that time,
 * and the history names each incident by its anchor at the time of the read. The order of the view counts the anchor.
 */
function withAnchors(view: MapView, kept: Histories): MapView {
  const now = new Map<ReportId, ReportId>(kept.incidents.flatMap((history) => history.reports.map((id) => [id, history.anchor])));
  const list = view.incidents.map((incident) => ({ ...incident, anchor: now.get(incident.anchor) ?? incident.anchor })).sort(compareMapIncidents);
  return { ...view, incidents: list, places: view.places.map((place) => ({ ...place, incidents: list.filter((incident) => incident.places.includes(place.id)).map((incident) => incident.anchor) })) };
}

/** The times of a check: each change, one millisecond before and after it, each fifth minute, and the time of the read. */
const checkTimes = (kept: Histories, to: Instant): Instant[] => {
  const steps = Array.from({ length: 26 }, (_, index) => T0 - 5 * MINUTE + index * 5 * MINUTE);
  return [...new Set([...historyTimes(kept).flatMap((time) => [time - 1, time, time + 1]), ...steps, to])].filter((time) => time <= to).sort((a, b) => a - b);
};

describe("the reader of the history against the map", () => {
  const kept = addHistory(NO_HISTORIES, historyPayload(input(END)));

  it("has a change at each time at which the map changes: an entry, an end mark and an expiry", () => {
    expect(historyTimes(kept).map((time) => (time - T0) / MINUTE)).toEqual([0, 10, 20, 30, 45, 50, 60, 70, 100]);
    // The second tornado warning names no earlier report, so the histories have four incidents.
    expect(kept.incidents.map((history) => history.reports.length).sort()).toEqual([1, 1, 1, 2]);
  });

  it("gives at each time the view that the map route gave at that time", () => {
    const times = checkTimes(kept, END);
    expect(times.length).toBeGreaterThan(40);
    for (const time of times) {
      const live = mapAt(time);
      expect(historyView(kept, time, live.places), `at ${String((time - T0) / MINUTE)} minutes`).toEqual(withAnchors(live, kept));
    }
    // The views of the check are not empty, and they change: the map has from zero to three incidents.
    expect(new Set(times.map((time) => mapAt(time).incidents.length))).toEqual(new Set([0, 1, 2, 3]));
    // The level of the home is the highest level over the two people, and the work place gets a level of its own.
    const levels = (minutes: number) => historyView(kept, T0 + minutes * MINUTE, mapAt(END).places).places.map((place) => place.level);
    expect(levels(35)).toEqual([mapAt(T0 + 35 * MINUTE).places[0]?.level, mapAt(T0 + 35 * MINUTE).places[1]?.level, "none"]);
    expect(levels(35)[0]).not.toBe("none");
    expect(levels(35)[1]).not.toBe("none");
    expect(levels(65)).toEqual(["none", "none", "none"]);
  });

  it("gives the same view from many reads with since as from one read of each incident", () => {
    // A reader reads at each fifth minute. Each read after the first asks only for the incidents with a later change.
    let reader = NO_HISTORIES;
    let asked = 0;
    for (let at = T0 - 5 * MINUTE; at <= END; at += 5 * MINUTE) {
      const payload = historyPayload(input(at, reader.since));
      asked += payload.incidents.length;
      reader = addHistory(reader, payload);
      // At the time of each read, the reader has the live map and each earlier map.
      for (const time of checkTimes(reader, at)) {
        const live = mapAt(time);
        expect(historyView(reader, time, live.places), `read at ${String((at - T0) / MINUTE)}, view at ${String((time - T0) / MINUTE)} minutes`).toEqual(withAnchors(live, reader));
      }
    }
    expect(reader).toEqual(kept);
    // The flip: the reads with since gave fewer histories than a read of each incident each time.
    expect(asked).toBeLessThan(26 * kept.incidents.length);
  });
});
