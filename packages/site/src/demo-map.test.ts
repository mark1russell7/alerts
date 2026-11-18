import { MAP_FORMAT, type PlaceId } from "@mark1russell7/alerts";
import { bboxOfGeoJson } from "@mark1russell7/geo";
import { describe, expect, it } from "vitest";
import { COVERAGE_KINDS, FETCHES, FIRST_FETCH, PEOPLE, PLACES, SOURCES, STEPS, ZONES } from "./demo.ts";
import { DEMO_BASEMAP, DEMO_PLACES, demoShape, frameMap, zonesOfCode } from "./demo-map.ts";
import { areaKind, globeParts, incidentRecord, REGION_RANK, regionOf, regionRecord, STATUS_RANK, statusKind, ZONE_KIND } from "./globe-view.ts";
import { mapNodes } from "./map-view.ts";
import { replay, topLevel } from "./replay.ts";
import { shownStatuses } from "./status.ts";

const frames = replay(STEPS, PEOPLE, PLACES, { sources: SOURCES, fetches: FETCHES, start: FIRST_FETCH, kinds: COVERAGE_KINDS });
const maps = frames.map(frameMap);

/** The index of the step at which the API stops, of the step at which it is back, and of the step with the test message. */
const STOPS = 5;
const BACK = 6;
const TEST = 7;

const names = (code: { system: string; code: string }): string[] => zonesOfCode(code).map((zone) => zone.name);
const levels = (index: number): string[] => maps[index]!.view.places.map((place) => `${place.label} ${place.level}`);

describe("the shapes of the made-up world", () => {
  it("gives the zone of a zone code, and each zone of a county by its UGC code or its SAME code", () => {
    expect(names({ system: "ugc", code: "XXZ003" })).toEqual(["Valley"]);
    expect(names({ system: "ugc", code: "XXC001" })).toEqual(["Lake Shore", "Harbor"]);
    expect(names({ system: "same", code: "099002" })).toEqual(["Valley", "Ridge"]);
  });

  it("gives no zone and no shape for a code of a different world", () => {
    expect(names({ system: "ugc", code: "KSZ083" })).toEqual([]);
    expect(names({ system: "iso3166", code: "XXZ003" })).toEqual([]);
    expect(demoShape({ system: "ugc", code: "KSZ083" })).toBeUndefined();
    expect(demoShape({ system: "same", code: "XXC001" })).toBeUndefined();
  });

  it("gives one polygon for a zone and two polygons for a county, each with a ring that closes on its first position", () => {
    expect(demoShape({ system: "ugc", code: "XXZ001" })).toHaveLength(1);
    expect(demoShape({ system: "ugc", code: "XXC002" })).toHaveLength(2);
    for (const zone of ZONES) {
      const [shape] = demoShape({ system: "ugc", code: zone.code }) ?? [];
      if (shape?.type !== "polygon") throw new Error(`The zone ${zone.code} has no polygon.`);
      const [ring] = shape.rings;
      expect(shape.rings).toHaveLength(1);
      expect(ring).toHaveLength(zone.ring.length + 1);
      expect(ring?.at(-1)).toEqual(ring?.[0]);
      expect(ring?.slice(0, -1)).toEqual(zone.ring);
    }
  });

  it("has each zone as a region of the basemap, with its name and a shape that the globe accepts", () => {
    expect(DEMO_BASEMAP.map((region) => [region.code.system, region.code.code, region.name])).toEqual(ZONES.map((zone) => ["ugc", zone.code, zone.name]));
    // The world is near the point 0, 0: from 0 to 1 east, and from 0 to 0.6 north.
    const box = bboxOfGeoJson({ type: "GeometryCollection", geometries: DEMO_BASEMAP.flatMap((region) => region.shapes.map(regionOf)) });
    expect(box).toEqual({ west: 0, south: 0, east: 1, north: 0.6 });
  });

  it("has each home as a place with its short name, its position and its codes", () => {
    expect(DEMO_PLACES.map((place) => [place.id, place.label])).toEqual([
      ["home-a", "Home of A"],
      ["home-b", "Home of B"],
    ]);
    expect(DEMO_PLACES.map((place) => [place.at, place.codes, place.bufferKm])).toEqual(PLACES.map((place) => [place.at, place.codes, place.bufferKm]));
  });
});

describe("the map of a frame", () => {
  it("gives the payload of the map route at the time of the step, with the basemap of the world", () => {
    maps.forEach((payload, index) => {
      expect(payload.format).toBe(MAP_FORMAT);
      expect(payload.at).toBe(frames[index]!.step.at);
      expect(payload.basemap).toBe(DEMO_BASEMAP);
      expect(payload.view.unshaped).toEqual([]);
    });
  });

  it("has each live incident of the frame, of the source and of the system reports, and no ended incident", () => {
    maps.forEach((payload, index) => {
      const frame = frames[index]!;
      const live = [...frame.incidents, ...frame.sources.incidents].filter((incident) => incident.live).map((incident) => incident.anchor);
      expect(payload.view.incidents.map((incident) => incident.anchor).sort()).toEqual([...live].sort());
    });
    expect(maps.map((payload) => payload.view.incidents.length)).toEqual([0, 1, 2, 2, 2, 5, 3, 3, 1, 0]);
  });

  it("gives each incident the highest level that the frame gives to a person", () => {
    maps.forEach((payload, index) => {
      const frame = frames[index]!;
      const assessments = [...frame.assessments, ...frame.sources.assessments];
      for (const incident of payload.view.incidents) {
        expect(incident.level).toBe(topLevel(assessments.filter((assessment) => assessment.incident === incident.anchor)));
      }
    });
  });

  it("gives each home the highest level of its live incidents", () => {
    expect(levels(0)).toEqual(["Home of A none", "Home of B none"]);
    expect(levels(1)).toEqual(["Home of A none", "Home of B notice"]);
    expect(levels(2)).toEqual(["Home of A life-safety", "Home of B notice"]);
    expect(levels(4)).toEqual(["Home of A life-safety", "Home of B life-safety"]);
    expect(levels(8)).toEqual(["Home of A none", "Home of B notice"]);
    expect(levels(9)).toEqual(levels(0));
  });

  it("draws the polygon of the flood and the zones of its codes", () => {
    const flood = maps[2]!.view.incidents.find((incident) => incident.kind.code === "met.flood.flash");
    const own = frames[2]!.incidents.find((incident) => incident.kind.code === "met.flood.flash");
    const rings = (own?.areas ?? []).flatMap((area) => (area.type === "polygon" ? [area.rings] : []));
    expect(rings.length).toBeGreaterThan(0);
    const drawn = (flood?.shapes ?? []).flatMap((shape) => (shape.type === "polygon" ? [shape.rings] : []));
    for (const one of rings) expect(drawn).toContainEqual(one);
    for (const code of ["XXZ003", "XXZ004"]) expect(flood?.shapes).toContain(demoShape({ system: "ugc", code })?.[0]);
    expect(flood?.places).toEqual(["home-a"]);
  });

  it("marks a gap at each home while the API is stopped, and no gap after it is back", () => {
    const gaps = (index: number): (readonly string[])[] => maps[index]!.view.places.map((place) => place.gaps);
    expect(gaps(STOPS - 1)).toEqual([[], []]);
    expect(gaps(STOPS)).toEqual([["met.flood.flash"], ["met.flood.flash"]]);
    expect(gaps(BACK)).toEqual([[], []]);
  });

  it("has the system reports of the stopped API as incidents with no shape", () => {
    const system = maps[STOPS]!.view.incidents.filter((incident) => incident.kind.code.startsWith("system."));
    expect(system.map((incident) => [incident.kind.code, incident.level, incident.shapes.length, incident.places])).toEqual([
      ["system.coverage.met.flood.flash", "urgent", 0, ["home-a" as PlaceId]],
      ["system.coverage.met.flood.flash", "urgent", 0, ["home-b" as PlaceId]],
      ["system.health.failing", "notice", 0, []],
    ]);
  });

  it("has the test message as an incident over the four zones, with no level for a person", () => {
    const test = maps[TEST]!.view.incidents.find((incident) => incident.kind.code === "system.test");
    expect(test?.level).toBe("none");
    expect(new Set(test?.shapes)).toEqual(new Set(DEMO_BASEMAP.flatMap((region) => region.shapes)));
  });
});

describe("the pictures of the demo map", () => {
  const payload = maps[4]!;

  it("names each zone and each home on the globe, and a home is before a zone when two names need one position", () => {
    const parts = globeParts(payload, { regionNames: true });
    expect(parts.names.map((name) => [name.text, name.kind, name.rank])).toEqual([
      ["Lake Shore", ZONE_KIND, REGION_RANK],
      ["Harbor", ZONE_KIND, REGION_RANK],
      ["Valley", ZONE_KIND, REGION_RANK],
      ["Ridge", ZONE_KIND, REGION_RANK],
      ["Home of A", "pin-life-safety", 4],
      ["Home of B", "pin-life-safety", 4],
    ]);
    expect(parts.names.slice(0, 4).map((name) => name.record)).toEqual(DEMO_BASEMAP.map(regionRecord));
  });

  it("gives the globe a part for each step of the replay", () => {
    for (const one of maps) {
      const parts = globeParts(one, { regionNames: true });
      expect(parts.areas.length).toBeGreaterThanOrEqual(DEMO_BASEMAP.length);
      expect(parts.points.length).toBeGreaterThanOrEqual(DEMO_PLACES.length);
    }
  });

  it("names each zone on the flat map", () => {
    const map = mapNodes(payload.view, { basemap: payload.basemap, regionNames: true });
    const labels = map.children.flatMap((child) => (typeof child !== "string" && child.attrs["class"] === "region-label" ? [child.children[0]] : []));
    expect(labels).toEqual(ZONES.map((zone) => zone.name));
  });
});

describe("the test message on the demo map", () => {
  const payload = maps[TEST]!;
  const test = payload.view.incidents.find((incident) => incident.kind.code === "system.test");

  it("has the status test, and the map shows a status only at the step of the test message", () => {
    expect(test?.status).toBe("test");
    // The system reports of the stopped API have no shape, so the map shows no status for them.
    expect(maps.map((map) => shownStatuses(map.view).join())).toEqual(["", "", "", "", "", "", "", "test", "", ""]);
  });

  it("draws the test on the globe with the style of a test, and writes its word in the zones and off each home", () => {
    const parts = globeParts(payload, { regionNames: true });
    const record = incidentRecord(test?.anchor ?? "");
    const areas = parts.areas.filter((area) => area.record === record);
    // The message names each zone by its zone code and by the code of its county, so each zone has two shapes.
    expect(areas.length).toBe(test?.shapes.length);
    expect(areas.length).toBeGreaterThanOrEqual(DEMO_BASEMAP.length);
    expect(new Set(areas.map((area) => area.kind))).toEqual(new Set([areaKind("none", "test")]));
    expect(areas.every((area) => area.value.words.startsWith("Test. "))).toBe(true);
    const words = parts.names.filter((name) => name.kind.startsWith("status-"));
    expect(words.map((name) => [name.text, name.kind, name.record, name.rank])).toEqual([["Test", statusKind("test"), record, STATUS_RANK]]);
    // The word is in the box of the zones, and it is not at the position of a home.
    const box = bboxOfGeoJson({ type: "GeometryCollection", geometries: DEMO_BASEMAP.flatMap((region) => region.shapes).map(regionOf) });
    const at = words[0]?.place ?? { lat: Number.NaN, lon: Number.NaN };
    expect(box !== undefined && at.lat > box.south && at.lat < box.north && at.lon > box.west && at.lon < box.east).toBe(true);
    const homes = parts.names.filter((name) => name.kind.startsWith("pin-"));
    expect(homes).toHaveLength(2);
    for (const home of homes) expect(Math.hypot(home.place.lat - at.lat, home.place.lon - at.lon)).toBeGreaterThan(0.05);
  });

  it("draws the test on the flat map with the dash of a test, and writes its word one time", () => {
    const map = mapNodes(payload.view, { basemap: payload.basemap, regionNames: true });
    const nodes = map.children.flatMap((child) => (typeof child === "string" ? [] : [child]));
    const words = nodes.filter((node) => node.attrs["class"] === "status-word").flatMap((node) => node.children.flatMap((child) => (typeof child !== "string" && child.tag === "text" ? [child] : [])));
    expect(words.map((word) => word.children[0])).toEqual(["Test"]);
    const group = nodes.find((node) => node.attrs["data-anchor"] === test?.anchor);
    expect(group?.attrs["class"]).toBe("incident level-none status status-test");
    const areas = (group?.children ?? []).flatMap((child) => (typeof child !== "string" && child.tag === "path" ? [child] : []));
    expect(areas.length).toBeGreaterThan(0);
    expect(new Set(areas.map((area) => area.attrs["stroke-dasharray"]))).toEqual(new Set(["6 4"]));
  });
});
