import type { MapPayload, MapView, Status } from "@mark1russell7/alerts";
import { bboxCenter, bboxOfGeoJson } from "@mark1russell7/geo";
import { describe, expect, it } from "vitest";
import { areaKind, globeParts, incidentRecord, levelRank, regionOf, REGION_RANK, STATUS_RANK, statusKind } from "./globe-view.ts";
import { ANCHORS, MAP_FIXTURE } from "./map-view.fixture.ts";
import { incidentTitle, MAP_HEIGHT, MAP_WIDTH, mapNodes, type MapNode } from "./map-view.ts";
import { dashText, OTHER_STATUSES, shownStatuses, STATUS_LOOKS, statusLook } from "./status.ts";

/** This function gives the view of the fixture with a different status for some incidents, by their anchors. */
const viewWith = (statuses: Readonly<Record<string, Status>>): MapView => ({
  ...MAP_FIXTURE.view,
  incidents: MAP_FIXTURE.view.incidents.map((incident) => ({ ...incident, status: statuses[incident.anchor] ?? incident.status })),
});

// The wind is a test, the statement is an exercise, and the air alert with no shape is a draft. The tornado and the flood stay actual.
const VIEW = viewWith({ [ANCHORS.wind]: "test", [ANCHORS.statement]: "exercise", [ANCHORS.air]: "draft" });
const PAYLOAD: MapPayload = { ...MAP_FIXTURE, view: VIEW };

const all = (root: MapNode): MapNode[] => [root, ...root.children.flatMap((child) => (typeof child === "string" ? [] : all(child)))];
const byClass = (root: MapNode, name: string): MapNode[] => all(root).filter((one) => String(one.attrs["class"] ?? "").split(" ").includes(name));
const incidentOf = (root: MapNode, anchor: string): MapNode => {
  const found = byClass(root, "incident").find((one) => one.attrs["data-anchor"] === anchor);
  if (found === undefined) throw new Error(`the map has no incident ${anchor}`);
  return found;
};
const areasOf = (incident: MapNode): MapNode[] => incident.children.flatMap((child) => (typeof child !== "string" && child.tag === "path" ? [child] : []));

describe("the look of each status", () => {
  it("has a word and a dash of its own for each status other than actual", () => {
    expect([...OTHER_STATUSES].sort()).toEqual(["draft", "exercise", "system", "test"]);
    const looks = OTHER_STATUSES.map((status) => STATUS_LOOKS[status]);
    expect(new Set(looks.map((look) => look.word)).size).toBe(looks.length);
    expect(new Set(looks.map(dashText)).size).toBe(looks.length);
    for (const look of looks) {
      expect(look.word).toMatch(/^[A-Z][a-z]+$/);
      expect(look.dash.every((length) => length > 0)).toBe(true);
    }
    expect(dashText(STATUS_LOOKS.test)).toBe("6 4");
  });

  it("gives no look to the status actual", () => {
    expect(statusLook("actual")).toBeUndefined();
    for (const status of OTHER_STATUSES) expect(statusLook(status)).toBe(STATUS_LOOKS[status]);
  });

  it("puts the word of the status before the words of an incident", () => {
    const [tornado] = MAP_FIXTURE.view.incidents;
    if (tornado === undefined) throw new Error("the fixture has an incident");
    expect(incidentTitle(tornado)).toBe("Tornado warning: Life-safety");
    expect(incidentTitle({ ...tornado, status: "exercise" })).toBe("Exercise. Tornado warning: Life-safety");
    expect(incidentTitle({ ...tornado, status: "test", level: "none" })).toBe("Test. Tornado warning: No message");
  });
});

describe("shownStatuses", () => {
  it("gives each status other than actual of an incident with a shape, one time, in the order of the legend", () => {
    expect(shownStatuses(MAP_FIXTURE.view)).toEqual([]);
    // The draft has no shape, so the map does not show it.
    expect(shownStatuses(VIEW)).toEqual(["test", "exercise"]);
    expect(shownStatuses(viewWith({ [ANCHORS.tornado]: "system", [ANCHORS.flood]: "test", [ANCHORS.wind]: "test", [ANCHORS.statement]: "draft" }))).toEqual(["test", "draft", "system"]);
  });
});

describe("a status on the flat map", () => {
  const map = mapNodes(VIEW, { basemap: MAP_FIXTURE.basemap, regionNames: true });
  const plain = mapNodes(MAP_FIXTURE.view, { basemap: MAP_FIXTURE.basemap, regionNames: true });

  it("gives an incident the classes of its level and of its status", () => {
    expect(byClass(map, "incident").map((one) => one.attrs["class"])).toEqual([
      "incident level-none status status-draft",
      "incident level-digest status status-exercise",
      "incident level-notice status status-test",
      "incident level-urgent",
      "incident level-life-safety",
    ]);
    expect(String(incidentOf(mapNodes(VIEW, { selected: ANCHORS.wind }), ANCHORS.wind).attrs["class"])).toBe("incident level-notice status status-test selected");
  });

  it("draws the edge of each area with the dash of the status, in pixels of the screen", () => {
    for (const [anchor, status] of [
      [ANCHORS.wind, "test"],
      [ANCHORS.statement, "exercise"],
    ] as const) {
      const areas = areasOf(incidentOf(map, anchor));
      expect(areas.length).toBeGreaterThan(0);
      for (const area of areas) {
        expect(area.attrs["stroke-dasharray"]).toBe(dashText(STATUS_LOOKS[status]));
        expect(area.attrs["vector-effect"]).toBe("non-scaling-stroke");
      }
    }
  });

  it("draws an actual incident with no dash", () => {
    for (const anchor of [ANCHORS.tornado, ANCHORS.flood]) {
      for (const area of areasOf(incidentOf(map, anchor))) expect(Object.keys(area.attrs).sort()).toEqual(["class", "d"]);
    }
    // A view with only actual incidents has no part of a status.
    expect(byClass(plain, "status")).toEqual([]);
    expect(byClass(plain, "status-label")).toEqual([]);
    expect(all(plain).some((one) => "stroke-dasharray" in one.attrs)).toBe(false);
  });

  it("writes the word of the status on each incident with a shape: above the incidents, in the view box", () => {
    const words = byClass(map, "status-label");
    // The incidents go from the lowest level up. The draft has no shape, so it has no word.
    expect(words.map((one) => [one.attrs["data-status"], one.children[0]])).toEqual([
      ["exercise", "Exercise"],
      ["test", "Test"],
    ]);
    for (const word of words) {
      const [x, y] = [Number(word.attrs["x"]), Number(word.attrs["y"])];
      expect(x >= 0 && x <= MAP_WIDTH && y >= 0 && y <= MAP_HEIGHT).toBe(true);
    }
    const order = map.children.flatMap((child) => (typeof child === "string" ? [] : [String(child.attrs["class"]).split(" ")[0]]));
    expect(order.lastIndexOf("incident")).toBeLessThan(order.indexOf("status-word"));
    expect(order.lastIndexOf("status-word")).toBeLessThan(order.indexOf("region-label"));
  });

  it("puts the word in a box that has the width of its letters, with its middle at the word", () => {
    const groups = byClass(map, "status-word");
    expect(groups.map((one) => [one.attrs["class"], one.attrs["data-status"]])).toEqual([
      ["status-word", "exercise"],
      ["status-word", "test"],
    ]);
    for (const group of groups) {
      const [box, word] = group.children.flatMap((child) => (typeof child === "string" ? [] : [child]));
      expect([box?.tag, box?.attrs["class"], word?.tag, word?.attrs["class"]]).toEqual(["rect", "status-box", "text", "status-label"]);
      const length = Number(word?.attrs["textLength"]);
      // A longer word has a wider box, and the text fills the box less a space at each side.
      expect(length / String(word?.children[0]).length).toBe(13);
      expect(Number(box?.attrs["width"])).toBe(length + 20);
      expect(Number(box?.attrs["x"]) + Number(box?.attrs["width"]) / 2).toBeCloseTo(Number(word?.attrs["x"]), 1);
      expect(Number(box?.attrs["y"]) + Number(box?.attrs["height"]) / 2).toBeCloseTo(Number(word?.attrs["y"]), 1);
    }
  });

  it("makes the word dim with its incident, when a person selected a different incident", () => {
    const classes = (selected: string): unknown[] => byClass(mapNodes(VIEW, { selected }), "status-word").map((one) => one.attrs["class"]);
    expect(classes(ANCHORS.wind)).toEqual(["status-word dim", "status-word"]);
    expect(classes(ANCHORS.tornado)).toEqual(["status-word dim", "status-word dim"]);
  });

  it("tells the status in the title of an incident, and in its label when the incident takes a click", () => {
    expect(incidentOf(map, ANCHORS.wind).children[0]).toEqual({ tag: "title", attrs: {}, children: ["Test. Wind advisory: Notice"] });
    expect(incidentOf(map, ANCHORS.flood).children[0]).toEqual({ tag: "title", attrs: {}, children: ["Flash flood warning: Urgent"] });
    const selectable = mapNodes(VIEW, { selectable: true });
    expect(incidentOf(selectable, ANCHORS.statement).attrs["aria-label"]).toBe("Exercise. Special weather statement: Digest");
    expect(incidentOf(selectable, ANCHORS.tornado).attrs["aria-label"]).toBe("Tornado warning: Life-safety");
  });
});

describe("a status on the globe", () => {
  const parts = globeParts(PAYLOAD);
  const plain = globeParts(MAP_FIXTURE);
  const areasOfRecord = (anchor: string): string[] => parts.areas.filter((area) => area.record === incidentRecord(anchor)).map((area) => area.kind);

  it("gives the area of an incident the style of its status and its level", () => {
    expect(areaKind("notice")).toBe("level-notice");
    expect(areaKind("notice", "actual")).toBe("level-notice");
    expect(areaKind("notice", "test")).toBe("status-test-notice");
    expect(areasOfRecord(ANCHORS.wind)).toEqual(["status-test-notice"]);
    expect(areasOfRecord(ANCHORS.statement)).toEqual(["status-exercise-digest"]);
    expect(areasOfRecord(ANCHORS.tornado)).toEqual(["level-life-safety"]);
    // The area takes a pick, as the area of an actual incident does.
    expect(parts.areas.filter((area) => area.record === incidentRecord(ANCHORS.wind)).every((area) => area.pick !== false)).toBe(true);
  });

  it("names each style of a status one time over the levels and the statuses", () => {
    const kinds = OTHER_STATUSES.flatMap((status) => (["none", "digest", "notice", "urgent", "life-safety"] as const).map((level) => areaKind(level, status)));
    expect(new Set(kinds).size).toBe(OTHER_STATUSES.length * 5);
    for (const status of OTHER_STATUSES) expect(areaKind("none", status).startsWith(`${statusKind(status)}-`)).toBe(true);
  });

  it("has the word of the status as a name at the middle of the incident, between a region and a place in rank", () => {
    const words = parts.names.filter((name) => name.kind.startsWith("status-"));
    expect(words.map((name) => [name.text, name.kind, name.record, name.rank, name.size])).toEqual([
      ["Exercise", "status-exercise", incidentRecord(ANCHORS.statement), STATUS_RANK, 0],
      ["Test", "status-test", incidentRecord(ANCHORS.wind), STATUS_RANK, 0],
    ]);
    const wind = VIEW.incidents.find((incident) => incident.anchor === ANCHORS.wind);
    const box = bboxOfGeoJson({ type: "GeometryCollection", geometries: (wind?.shapes ?? []).map(regionOf) });
    if (box === undefined) throw new Error("the wind has a shape");
    expect(words[1]?.place).toEqual(bboxCenter(box));
    expect(STATUS_RANK).toBeGreaterThan(REGION_RANK);
    expect(STATUS_RANK).toBeLessThan(levelRank("none"));
  });

  it("tells the status in the words of the incident", () => {
    const words = (anchor: string): string | undefined => parts.areas.find((area) => area.record === incidentRecord(anchor))?.value.words;
    expect(words(ANCHORS.wind)).toBe("Test. Wind advisory: Notice");
    expect(words(ANCHORS.tornado)).toBe("Tornado warning: Life-safety");
  });

  it("adds no name and changes no area for a view with only actual incidents", () => {
    expect(plain.names.some((name) => name.kind.startsWith("status-"))).toBe(false);
    expect(plain.areas.some((area) => area.kind.startsWith("status-"))).toBe(false);
    // The status changes only the style and the words of an incident, and adds its word.
    expect(parts.areas.map((area) => [area.record, area.region])).toEqual(plain.areas.map((area) => [area.record, area.region]));
    expect(parts.names.filter((name) => !name.kind.startsWith("status-"))).toEqual(plain.names);
    expect(parts.points).toEqual(plain.points);
  });
});
