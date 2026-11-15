import { describe, expect, it } from "vitest";
import type { Position } from "./contracts.ts";
import type { MapRegion } from "./map.ts";
import { regionDistanceKm, regionsNear } from "./shapes.ts";

// Two squares of one degree with a shared edge at the longitude -95, and a circle to the south.
const square = (west: number): Position[] => [
  [west, 38],
  [west + 1, 38],
  [west + 1, 39],
  [west, 39],
  [west, 38],
];
const county: MapRegion = { code: { system: "ugc", code: "KSC173" }, name: "A county", shapes: [{ type: "polygon", rings: [square(-96)] }] };
const zone: MapRegion = { code: { system: "ugc", code: "KSZ083" }, name: "A zone", shapes: [{ type: "polygon", rings: [square(-95)] }] };
const circle: MapRegion = { code: { system: "ugc", code: "KSZ090" }, name: "A circle", shapes: [{ type: "circle", center: [-95.5, 36], radiusKm: 10 }] };
const empty: MapRegion = { code: { system: "ugc", code: "KSZ001" }, name: "No shape", shapes: [] };
const refused: MapRegion = { code: { system: "ugc", code: "KSZ002" }, name: "A bad ring", shapes: [{ type: "polygon", rings: [[[-95, 38], [-94, 38], [-95, 38]]] }] };
const regions = [zone, county, circle, empty, refused];

describe("regionDistanceKm", () => {
  it("gives 0 in a shape, and the distance to the nearest shape out of it", () => {
    expect(regionDistanceKm(county, [-95.5, 38.5])).toBe(0);
    const distance = regionDistanceKm(zone, [-95.5, 38.5]);
    // Half of a degree of longitude at the latitude 38.5 is 43.6 kilometers.
    expect(distance).toBeGreaterThan(43);
    expect(distance).toBeLessThan(44.2);
  });

  it("takes the nearest of two shapes", () => {
    const both: MapRegion = { ...zone, shapes: [...zone.shapes, ...county.shapes] };
    expect(regionDistanceKm(both, [-95.5, 38.5])).toBe(0);
  });

  it("gives no distance for a region with no shape that geo reads", () => {
    expect(regionDistanceKm(empty, [-95.5, 38.5])).toBeUndefined();
    expect(regionDistanceKm(refused, [-95.5, 38.5])).toBeUndefined();
  });
});

describe("regionsNear", () => {
  it("gives only the regions that contain the position with no buffer", () => {
    expect(regionsNear(regions, [-95.5, 38.5], 0).map((near) => near.region.code.code)).toEqual(["KSC173"]);
  });

  it("gives the nearest region first, with its distance", () => {
    const near = regionsNear(regions, [-95.5, 38.5], 50);
    expect(near.map((entry) => entry.region.code.code)).toEqual(["KSC173", "KSZ083"]);
    expect(near[0]?.distanceKm).toBe(0);
    expect(near[1]?.distanceKm).toBeGreaterThan(43);
  });

  it("gives the regions at one distance in the order of the code", () => {
    // A position on the shared edge is in the two squares.
    expect(regionsNear(regions, [-95, 38.5], 0).map((near) => near.region.code.code)).toEqual(["KSC173", "KSZ083"]);
  });

  it("measures a circle from its edge", () => {
    // The center of the circle is 44.5 kilometers south of the position, and the radius is 10 kilometers.
    expect(regionsNear(regions, [-95.5, 36.4], 40).map((near) => near.region.code.code)).toEqual(["KSZ090"]);
    expect(regionsNear(regions, [-95.5, 36.4], 30)).toEqual([]);
  });

  it("gives more regions, never fewer, for a larger buffer", () => {
    const at: Position = [-95.7, 38.2];
    let before: string[] = [];
    for (const bufferKm of [0, 10, 30, 60, 120, 250]) {
      const near = regionsNear(regions, at, bufferKm);
      for (const entry of near) expect(entry.distanceKm).toBeLessThanOrEqual(bufferKm);
      const codes = near.map((entry) => entry.region.code.code);
      for (const code of before) expect(codes).toContain(code);
      before = codes;
    }
    expect(before).toEqual(["KSC173", "KSZ083", "KSZ090"]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses the buffer %s", (bufferKm) => {
    expect(() => regionsNear(regions, [-95.5, 38.5], bufferKm)).toThrow(RangeError);
  });
});
