import { describe, expect, it } from "vitest";

import { distanceKm, EARTH_MEAN_RADIUS_KM } from "@mark1russell7/geo";

import { GEOMAGNETIC_POLES, POLEWARD_BY_LEVEL, polarCaps } from "./index.ts";

const point = ([lon, lat]: readonly [number, number]): { lat: number; lon: number } => ({ lat, lon });

describe("the polar caps", () => {
  it("has two poles that are antipodes", () => {
    const [north, south] = GEOMAGNETIC_POLES;
    expect(distanceKm(point(north!), point(south!))).toBeCloseTo(Math.PI * EARTH_MEAN_RADIUS_KM, 3);
  });

  it("gives one circle at each pole, with the arc from the pole to the latitude", () => {
    const caps = polarCaps(60);
    expect(caps.map((cap) => (cap.type === "circle" ? cap.center : undefined))).toEqual(GEOMAGNETIC_POLES);
    for (const cap of caps) expect(cap.type === "circle" ? cap.radiusKm : 0).toBeCloseTo((30 * Math.PI * EARTH_MEAN_RADIUS_KM) / 180, 6);
  });

  it("puts the block on each cap only when it is given", () => {
    expect(polarCaps(55, "caps").every((cap) => cap.type === "circle" && cap.block === "caps")).toBe(true);
    expect(polarCaps(55).every((cap) => !("block" in cap))).toBe(true);
  });

  it("has a lower latitude for each higher level", () => {
    for (let level = 1; level < POLEWARD_BY_LEVEL.length; level++) expect(POLEWARD_BY_LEVEL[level]!).toBeLessThan(POLEWARD_BY_LEVEL[level - 1]!);
  });
});
