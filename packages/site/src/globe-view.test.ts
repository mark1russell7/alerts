import { ASSESSED_LEVELS } from "@mark1russell7/alerts";
import { bboxOfGeoJson } from "@mark1russell7/geo";
import { regionSurface } from "@mark1russell7/visuals/globe";
import { describe, expect, it } from "vitest";
import { areaKind, GAP_KIND, GAP_SIZE, globeParts, GRID_STEPS, gridOf, incidentRecord, outlineKind, PIN_SIZE, pinKind, placeRecord, regionOf, ZONE_KIND } from "./globe-view.ts";
import { ANCHORS, box, EMPTY_FIXTURE, MAP_FIXTURE } from "./map-view.fixture.ts";

const parts = globeParts(MAP_FIXTURE);
const kinds = (list: readonly { readonly kind: string }[]): string[] => list.map((one) => one.kind);

describe("regionOf", () => {
  it("gives a polygon with the rings of the shape", () => {
    const region = regionOf(box(-98, 37, -97, 38));
    expect(region.type).toBe("Polygon");
    expect(region.coordinates).toEqual([
      [
        [-98, 37],
        [-97, 37],
        [-97, 38],
        [-98, 38],
        [-98, 37],
      ],
    ]);
  });

  it("gives a circle on the ground as a polygon around its center", () => {
    const region = regionOf({ type: "circle", center: [-98.1, 37.95], radiusKm: 25 });
    const found = bboxOfGeoJson(region);
    // 25 km is 0.225 degrees of latitude, and 0.285 degrees of longitude at this latitude.
    expect(found?.north).toBeCloseTo(37.95 + 0.225, 2);
    expect(found?.south).toBeCloseTo(37.95 - 0.225, 2);
    expect(found?.east).toBeCloseTo(-98.1 + 0.285, 2);
    expect(found?.west).toBeCloseTo(-98.1 - 0.285, 2);
  });

  it("gives a region that the globe accepts, for each order of the ring", () => {
    for (const clockwise of [false, true]) {
      const surface = regionSurface(regionOf(box(-98, 37, -97, 38, clockwise)), 2);
      expect(surface.triangles.length).toBeGreaterThan(0);
    }
  });
});

describe("globeParts", () => {
  it("has the regions of the basemap first, then the incidents from the lowest level, then the outlines of the places", () => {
    expect(kinds(parts.areas)).toEqual([
      ZONE_KIND,
      ZONE_KIND,
      ZONE_KIND,
      ZONE_KIND,
      areaKind("digest"),
      areaKind("notice"),
      areaKind("urgent"),
      areaKind("life-safety"),
      outlineKind("digest"),
    ]);
  });

  it("gives each shape of one record the name of the record", () => {
    const side = parts.areas.filter((area) => area.record === "region:ugc:KSZ991");
    expect(side).toHaveLength(2);
    expect(side.map((area) => area.value)).toEqual([
      { type: "region", words: "Side Plains (KSZ991)", code: "KSZ991" },
      { type: "region", words: "Side Plains (KSZ991)", code: "KSZ991" },
    ]);
  });

  it("gives the anchor of an incident to a pick of its area", () => {
    const tornado = parts.areas.find((area) => area.record === incidentRecord(ANCHORS.tornado));
    expect(tornado?.value).toEqual({ type: "incident", words: "Tornado warning: Life-safety", anchor: ANCHORS.tornado });
    expect(tornado?.kind).toBe("level-life-safety");
  });

  it("has no area for an incident with no shape", () => {
    expect(parts.areas.some((area) => area.record === incidentRecord(ANCHORS.air))).toBe(false);
    expect(parts.incidents.get(ANCHORS.air)).toEqual([]);
  });

  it("has one point for each place with a position, and a gap ring below the point of a place with a short coverage", () => {
    const farm = { type: "place", words: "Farm: Life-safety.", id: "place:farm", incident: ANCHORS.tornado };
    const shop = parts.points[1]?.value;
    expect(parts.points).toEqual([
      { record: placeRecord("place:farm"), place: { lat: 37.64, lon: -97.42 }, kind: pinKind("life-safety"), value: farm, size: PIN_SIZE },
      { record: placeRecord("place:shop"), place: { lat: 37.52, lon: -97.22 }, kind: GAP_KIND, value: shop, size: GAP_SIZE },
      { record: placeRecord("place:shop"), place: { lat: 37.52, lon: -97.22 }, kind: pinKind("urgent"), value: shop, size: PIN_SIZE },
    ]);
    expect(kinds(parts.points)).toEqual(["pin-life-safety", "gap", "pin-urgent"]);
    expect(GAP_SIZE).toBeGreaterThan(PIN_SIZE);
  });

  it("gives the first incident of a place to a pick of the place: the incident of the highest level", () => {
    const shop = parts.points[1]?.value;
    expect(shop).toMatchObject({ type: "place", id: "place:shop", incident: ANCHORS.flood });
    expect(shop?.words).toContain("Shop: Urgent. The coverage is short for:");
  });

  it("draws a place with no position as the outline of its region, and the outline takes no pick", () => {
    const cabin = parts.areas.filter((area) => area.record === placeRecord("place:cabin"));
    expect(cabin).toHaveLength(1);
    expect(cabin[0]?.kind).toBe("outline-digest");
    expect(cabin[0]?.pick).toBe(false);
    expect(cabin[0]?.value.words).toBe("Cabin: Digest.");
    // Each other area takes a pick.
    expect(parts.areas.filter((area) => area.pick === false)).toHaveLength(1);
  });

  it("has each area and a circle around each place with a position in the regions of the first view", () => {
    expect(parts.regions).toHaveLength(parts.areas.length + 2);
    const found = bboxOfGeoJson({ type: "GeometryCollection", geometries: [...parts.regions] });
    // The wind advisory is the part that is the farthest west and north.
    expect(found?.west).toBeLessThan(-98.3);
    expect(found?.east).toBeGreaterThan(-96.53);
    expect(found?.north).toBeGreaterThan(38.17);
    expect(found?.south).toBeLessThan(37.4);
  });

  it("has the regions of each incident by its anchor", () => {
    expect(parts.incidents.get(ANCHORS.tornado)).toHaveLength(1);
    expect([...parts.incidents.keys()]).toHaveLength(5);
  });

  it("gives no part for the empty payload", () => {
    const empty = globeParts(EMPTY_FIXTURE);
    expect(empty.areas).toEqual([]);
    expect(empty.points).toEqual([]);
    expect(empty.regions).toEqual([]);
    expect(empty.grid).toBe(15);
  });

  it("gives a region that the globe accepts for each area of the fixture", () => {
    for (const area of parts.areas) expect(regionSurface(area.region, 2).triangles.length).toBeGreaterThan(0);
  });

  it("has a different name of a style for each level", () => {
    const names = [ZONE_KIND, GAP_KIND, ...ASSESSED_LEVELS.flatMap((level) => [areaKind(level), outlineKind(level), pinKind(level)])];
    expect(new Set(names).size).toBe(2 + 3 * ASSESSED_LEVELS.length);
  });
});

describe("gridOf", () => {
  const wide = (degrees: number): number => gridOf([regionOf(box(-100, 30, -100 + degrees, 30.5))]);

  it("gives the smallest step for a small picture, and the step of the fixture", () => {
    expect(wide(0.2)).toBe(1);
    expect(parts.grid).toBe(1);
  });

  it("gives a larger step for a larger picture, with four lines or more across it", () => {
    expect(wide(8)).toBe(2);
    expect(wide(25)).toBe(5);
    expect(wide(50)).toBe(10);
    expect(wide(120)).toBe(15);
    for (const degrees of [8, 25, 50, 120]) expect(degrees / wide(degrees)).toBeGreaterThanOrEqual(4);
  });

  it("uses the height of a picture that is higher than wide", () => {
    expect(gridOf([regionOf(box(-100, 10, -99, 50))])).toBe(10);
  });

  it("measures a picture across the antimeridian on its short side", () => {
    expect(gridOf([regionOf(box(175, 10, 179, 11)), regionOf(box(-179, 10, -175, 11))])).toBe(2);
  });

  it("gives a step of the list", () => {
    for (const degrees of [0.1, 3, 17, 90, 300]) expect(GRID_STEPS).toContain(wide(degrees));
  });
});
