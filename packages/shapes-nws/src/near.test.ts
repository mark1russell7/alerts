import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { regionDistanceKm, type MapRegion, type Position } from "@mark1russell7/alerts";
import { zoneCodesNear } from "./near.ts";
import { readZone, type ZoneKey } from "./zones.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

/** This function reads the outline of a fixture as a region. */
function region(name: string, key: ZoneKey): MapRegion {
  const read = readZone(fixture(name), key);
  if (!read.ok) throw new Error(read.problem);
  return { code: { system: "ugc", code: key.id }, name: read.name, shapes: read.shapes };
}

const county = region("zone-county-KSC173.json", { kind: "county", id: "KSC173" });
const zone = region("zone-forecast-KSZ083.json", { kind: "forecast", id: "KSZ083" });
const galveston = region("zone-county-TXC167-parts.json", { kind: "county", id: "TXC167" });
// A marine zone and a region of another system give no code, also with the outline of the county.
const marine: MapRegion = { ...county, code: { system: "ugc", code: "GMZ250" } };
const other: MapRegion = { ...county, code: { system: "fips", code: "20173" } };
const regions = [galveston, zone, marine, other, county];

// The center of Wichita is in the county and in the forecast zone. The second position is east of the county.
const WICHITA: Position = [-97.3375, 37.6872];
const EAST: Position = [-97.0, 37.65];

describe("zoneCodesNear", () => {
  it("gives the codes of the county and the forecast zone that contain a position", () => {
    expect(zoneCodesNear(regions, WICHITA, 0)).toEqual([
      { system: "same", code: "020173" },
      { system: "state", code: "KS" },
      { system: "ugc", code: "KSC173" },
      { system: "ugc", code: "KSZ083" },
    ]);
  });

  it("gives the codes of a zone in the buffer only", () => {
    expect(zoneCodesNear(regions, EAST, 0)).toEqual([]);
    expect(zoneCodesNear(regions, EAST, 20).map((code) => code.code)).toEqual(["020173", "KS", "KSC173", "KSZ083"]);
  });

  it("gives a code of each state once, and the codes of a far county with a large buffer", () => {
    const codes = zoneCodesNear(regions, WICHITA, 1200);
    expect(codes.filter((code) => code.system === "state").map((code) => code.code)).toEqual(["KS", "TX"]);
    expect(codes.map((code) => code.code)).toContain("048167");
    expect(new Set(codes.map((code) => `${code.system}:${code.code}`)).size).toBe(codes.length);
  });

  it("gives each code once for two regions with one code in two forms", () => {
    const lower: MapRegion = { ...county, code: { system: "ugc", code: " ksc173 " } };
    expect(zoneCodesNear([lower, county], WICHITA, 0).map((code) => code.code)).toEqual(["020173", "KS", "KSC173"]);
  });

  it("gives more codes, never fewer, for a larger buffer, and only the codes of near zones", () => {
    const position = fc.tuple(fc.double({ min: -98.2, max: -96.6, noNaN: true }), fc.double({ min: 37.1, max: 38.2, noNaN: true }));
    const buffer = fc.double({ min: 0, max: 60, noNaN: true });
    fc.assert(
      fc.property(position, buffer, buffer, ([lon, lat], a, b) => {
        const at: Position = [lon, lat];
        const [small, large] = a <= b ? [a, b] : [b, a];
        const inSmall = zoneCodesNear(regions, at, small).map((code) => `${code.system}:${code.code}`);
        const inLarge = zoneCodesNear(regions, at, large).map((code) => `${code.system}:${code.code}`);
        for (const code of inSmall) expect(inLarge).toContain(code);
        for (const found of [county, zone]) {
          const near = (regionDistanceKm(found, at) ?? Number.POSITIVE_INFINITY) <= large;
          expect(inLarge.includes(`ugc:${found.code.code}`)).toBe(near);
        }
      }),
      { numRuns: 60 },
    );
  });
});
