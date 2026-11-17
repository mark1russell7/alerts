import { addHistory, NO_HISTORIES, type HistoryPayload } from "@mark1russell7/alerts";
import { replayOf, replaySeek } from "@mark1russell7/visuals";
import { describe, expect, it } from "vitest";
import { ANCHORS, EMPTY_FIXTURE, HISTORY_FIXTURE, MAP_FIXTURE } from "./map-view.fixture.ts";
import { atPresent, NOW_TEXT, scrubKey, scrubLabels, scrubPayload, scrubRange, scrubText, scrubWords, SHORTEST_RANGE_MS, timeForm } from "./scrub.ts";

const KEPT = addHistory(NO_HISTORIES, HISTORY_FIXTURE);
const utc = (clock: string): number => Date.parse(`2026-11-15T${clock}:00Z`);
const PRESENT = utc("21:00");
/** The clock time in UTC, so the tests do not read the time zone of the computer. */
const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);
const RANGE = scrubRange(MAP_FIXTURE, KEPT);
if (RANGE === undefined) throw new Error("The fixture has a range.");
const at = (time: string) => replaySeek(replayOf(RANGE.span), utc(time));

describe("the range of the scrubber", () => {
  it("goes from the oldest change to the present, with each time at which the map changed", () => {
    expect(RANGE.span).toEqual({ from: utc("15:00"), to: PRESENT });
    // 16:00 is the expiry of the fog advisory, which no report ends. The runtime gives a change at that time.
    expect(RANGE.times.map(clock)).toEqual(["15:00", "16:00", "16:10", "16:40", "17:25", "17:30", "18:05", "18:40", "19:20", "19:45"]);
  });

  it("is one hour long at least", () => {
    const short: HistoryPayload = { ...HISTORY_FIXTURE, incidents: HISTORY_FIXTURE.incidents.filter((incident) => incident.anchor === ANCHORS.tornado) };
    const range = scrubRange(MAP_FIXTURE, addHistory(NO_HISTORIES, short));
    expect(range?.span).toEqual({ from: utc("19:20"), to: PRESENT });
    const newest: HistoryPayload = { ...short, incidents: short.incidents.map((incident) => ({ ...incident, changes: incident.changes.slice(1).map((change) => ({ ...change, at: utc("20:50") })) })) };
    expect(scrubRange(MAP_FIXTURE, addHistory(NO_HISTORIES, newest))).toEqual({ span: { from: PRESENT - SHORTEST_RANGE_MS, to: PRESENT }, times: [utc("20:50")] });
  });

  it("ends at the newer time of the map and of the history", () => {
    expect(scrubRange({ ...MAP_FIXTURE, at: utc("21:02") }, KEPT)?.span.to).toBe(utc("21:02"));
    expect(scrubRange(MAP_FIXTURE, { ...KEPT, at: utc("21:03") })?.span.to).toBe(utc("21:03"));
    expect(scrubRange({ ...MAP_FIXTURE, at: null }, KEPT)?.span.to).toBe(PRESENT);
  });

  it("gives no scrubber before the first pass, and with no change before the present", () => {
    expect(scrubRange(EMPTY_FIXTURE, NO_HISTORIES)).toBeUndefined();
    expect(scrubRange(MAP_FIXTURE, NO_HISTORIES)).toBeUndefined();
    // Each change of this history is after the present of the page.
    expect(scrubRange({ ...MAP_FIXTURE, at: utc("14:00") }, { ...KEPT, at: utc("14:00") })).toBeUndefined();
  });
});

describe("the picture of the scrubber", () => {
  it("is the live payload at the present, and with no scrubber", () => {
    expect(atPresent(undefined)).toBe(true);
    expect(atPresent(replayOf(RANGE.span))).toBe(true);
    expect(atPresent(at("20:59"))).toBe(false);
    expect(scrubPayload(MAP_FIXTURE, KEPT, undefined)).toBe(MAP_FIXTURE);
    expect(scrubPayload(MAP_FIXTURE, KEPT, replayOf(RANGE.span))).toBe(MAP_FIXTURE);
  });

  it("is the map of a past time from the histories, with the basemap of the live payload", () => {
    const shown = scrubPayload(MAP_FIXTURE, KEPT, at("17:00"));
    expect(shown.at).toBe(utc("17:00"));
    expect(shown.basemap).toBe(MAP_FIXTURE.basemap);
    // The fog advisory expired at 16:00. The storm ends at 17:25, and the statement comes at 17:30.
    expect(shown.view.incidents.map((incident) => [incident.anchor, incident.level])).toEqual([
      [ANCHORS.storm, "urgent"],
      [ANCHORS.wind, "notice"],
    ]);
    expect(scrubPayload(MAP_FIXTURE, KEPT, at("17:25")).view.incidents.map((incident) => incident.anchor)).toEqual([ANCHORS.wind]);
    // The tornado warning starts with a lower level and a smaller area.
    const [early] = scrubPayload(MAP_FIXTURE, KEPT, at("19:30")).view.incidents;
    const [late] = scrubPayload(MAP_FIXTURE, KEPT, at("19:50")).view.incidents;
    expect([early?.anchor, early?.level, late?.anchor, late?.level]).toEqual([ANCHORS.tornado, "urgent", ANCHORS.tornado, "life-safety"]);
    expect(early?.shapes).not.toEqual(late?.shapes);
    expect(late?.shapes).toEqual(MAP_FIXTURE.view.incidents[0]?.shapes);
  });

  it("gives each place of the live payload its level and its incidents at the past time, with no gap", () => {
    const places = (time: string) => scrubPayload(MAP_FIXTURE, KEPT, at(time)).view.places.map((place) => [place.label, place.level, place.incidents, place.gaps]);
    // The live map has a gap of the coverage at the shop. The history has no coverage.
    expect(MAP_FIXTURE.view.places.map((place) => place.gaps.length)).toEqual([0, 1, 0]);
    expect(places("19:50")).toEqual([
      ["Farm", "life-safety", [ANCHORS.tornado, ANCHORS.flood], []],
      ["Shop", "urgent", [ANCHORS.flood], []],
      ["Cabin", "digest", [ANCHORS.statement], []],
    ]);
    // Before the second report of the tornado, the farm has the level of the first report.
    expect(places("19:30")[0]).toEqual(["Farm", "urgent", [ANCHORS.tornado, ANCHORS.flood], []]);
    // The fog advisory is on the zone of the farm and of the shop until 16:00.
    expect(places("15:30")).toEqual([
      ["Farm", "notice", [ANCHORS.fog], []],
      ["Shop", "notice", [ANCHORS.fog], []],
      ["Cabin", "none", [], []],
    ]);
    expect(places("16:05")).toEqual([
      ["Farm", "none", [], []],
      ["Shop", "none", [], []],
      ["Cabin", "none", [], []],
    ]);
    const shown = scrubPayload(MAP_FIXTURE, KEPT, at("19:50"));
    expect(shown.view.places.map((place) => place.at)).toEqual(MAP_FIXTURE.view.places.map((place) => place.at));
  });

  it("has one key between two changes, and a key of its own for the present", () => {
    expect(scrubKey(undefined, RANGE.times)).toBe(-1);
    expect(scrubKey(replayOf(RANGE.span), RANGE.times)).toBe(-1);
    expect(scrubKey(at("17:00"), RANGE.times)).toBe(4);
    expect(scrubKey(at("17:24"), RANGE.times)).toBe(4);
    expect(scrubKey(at("17:25"), RANGE.times)).toBe(5);
    // After the last change, the past map has no level for a place. So it is not the picture of the present.
    expect(scrubKey(at("20:59"), RANGE.times)).toBe(RANGE.times.length);
  });
});

describe("the words of the scrubber", () => {
  it("names the present, and gives the clock time of a past time", () => {
    const replay = at("17:00");
    expect(scrubText(replay.at, replay, clock)).toBe("17:00");
    expect(scrubText(PRESENT, replayOf(RANGE.span), clock)).toBe(NOW_TEXT);
    expect(NOW_TEXT).toBe("Now");
  });

  it("puts a label at each end of the axis: the start time and the present", () => {
    expect(scrubLabels(RANGE.span, clock)).toEqual([
      { at: utc("15:00"), text: "15:00" },
      { at: PRESENT, text: "Now" },
    ]);
  });

  it("gives the clock a present, so a time of a different day gets its day", () => {
    const day = (time: number): string => new Date(time).toISOString().slice(0, 10);
    expect(timeForm(utc("00:00"), PRESENT, day)).toBe("time");
    expect(timeForm(Date.parse("2026-11-14T23:59:00Z"), PRESENT, day)).toBe("weekday");
    expect(timeForm(Date.parse("2026-11-09T21:00:01Z"), PRESENT, day)).toBe("weekday");
    expect(timeForm(Date.parse("2026-11-09T21:00:00Z"), PRESENT, day)).toBe("date");
    const seen: number[] = [];
    scrubText(utc("17:00"), at("17:00"), (time, present) => {
      seen.push(time, present);
      return "";
    });
    expect(seen).toEqual([utc("17:00"), PRESENT]);
  });

  it("tells the time in the two headings and in a note for a past time only", () => {
    expect(scrubWords(undefined, clock)).toEqual({ map: "Map", list: "Live incidents", past: undefined });
    expect(scrubWords(replayOf(RANGE.span), clock)).toEqual({ map: "Map", list: "Live incidents", past: undefined });
    expect(scrubWords(at("17:00"), clock)).toEqual({
      map: "Map at 17:00",
      list: "Incidents at 17:00",
      past: "The map shows the incidents, their areas and the level of each place at 17:00. It does not show the coverage of that time.",
    });
  });
});
