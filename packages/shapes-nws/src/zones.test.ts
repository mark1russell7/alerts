import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareCodes, listPath, readList, readZone, stateCode, zoneKindOf, zoneOfCode, zonePath, type ZoneKey } from "./zones.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const SEDGWICK: ZoneKey = { kind: "county", id: "KSC173" };
const GALVESTON: ZoneKey = { kind: "county", id: "TXC167" };

/** This function gives a fixture as an object, with a change. */
const changed = (name: string, change: (value: Record<string, unknown>) => void): string => {
  const value = JSON.parse(fixture(name)) as Record<string, unknown>;
  change(value);
  return JSON.stringify(value);
};

describe("the codes", () => {
  it("gives the kind of a county and of a forecast zone, and none for a marine zone", () => {
    expect(zoneKindOf("KSC173")).toBe("county");
    expect(zoneKindOf(" ksz083 ")).toBe("forecast");
    expect(zoneKindOf("GMZ250")).toBeUndefined();
    expect(zoneKindOf("KSC17")).toBeUndefined();
  });

  it("gives the zone of a UGC code and of a SAME code", () => {
    expect(zoneOfCode({ system: "ugc", code: "ksz083" })).toEqual({ kind: "forecast", id: "KSZ083" });
    expect(zoneOfCode({ system: "same", code: "020173" })).toEqual(SEDGWICK);
    // A part of a county gives the full county.
    expect(zoneOfCode({ system: "same", code: "120173" })).toEqual(SEDGWICK);
  });

  it.each([
    { system: "same", code: "020000" },
    { system: "ugc", code: "PKZ414" },
    { system: "state", code: "KS" },
    { system: "fips", code: "20173" },
  ])("gives no zone for $system $code", (code) => {
    expect(zoneOfCode(code)).toBeUndefined();
  });

  it("gives the postal code of a state", () => {
    expect(stateCode(" ks ")).toBe("KS");
    expect(stateCode("XX")).toBeUndefined();
    expect(stateCode("toString")).toBeUndefined();
  });

  it("gives the paths of the zone service", () => {
    expect(listPath("KS", "county")).toBe("/zones?area=KS&type=county");
    expect(zonePath({ kind: "forecast", id: "KSZ083" })).toBe("/zones/forecast/KSZ083");
  });

  it("orders codes by code units, as the default sort does", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (codes) => {
        expect([...codes].sort(compareCodes)).toEqual([...codes].sort());
      }),
    );
  });
});

describe("readList", () => {
  it("reads the codes of a real list of counties and of forecast zones", () => {
    expect(readList(fixture("zones-KS-county.json"), "KS", "county")).toEqual({ ok: true, ids: ["KSC015", "KSC079", "KSC173"], complete: true, problems: [] });
    expect(readList(fixture("zones-KS-forecast.json"), "KS", "forecast")).toEqual({ ok: true, ids: ["KSZ069", "KSZ070", "KSZ083"], complete: true, problems: [] });
  });

  it("refuses a list of a different state or kind, because its rows are not correct", () => {
    expect(readList(fixture("zones-KS-county.json"), "TX", "county")).toMatchObject({ ok: false });
    expect(readList(fixture("zones-KS-county.json"), "KS", "forecast")).toMatchObject({ ok: false });
  });

  it("skips a row with a problem and a row two times, and then the list is not complete", () => {
    const body = changed("zones-KS-county.json", (value) => {
      const features = value["features"] as Record<string, unknown>[];
      value["features"] = [...features, features[0], { type: "Feature", properties: { id: "GMZ250", type: "county" } }, null];
    });
    const read = readList(body, "KS", "county");
    expect(read).toMatchObject({ ok: true, ids: ["KSC015", "KSC079", "KSC173"], complete: false });
    expect(read.ok && read.problems).toHaveLength(3);
  });

  it("marks a list with more pages as not complete", () => {
    const body = changed("zones-KS-county.json", (value) => {
      value["pagination"] = { next: "https://api.weather.gov/zones?cursor=2" };
    });
    expect(readList(body, "KS", "county")).toMatchObject({ ok: true, complete: false });
  });

  it.each([
    ["not JSON", "<html>"],
    ["no features", JSON.stringify({ type: "FeatureCollection" })],
    ["an empty list", JSON.stringify({ type: "FeatureCollection", features: [] })],
    ["a Feature", fixture("zone-county-KSC173.json")],
  ])("refuses %s", (_name, body) => {
    expect(readList(body, "KS", "county")).toMatchObject({ ok: false });
  });
});

describe("readZone", () => {
  it("reads a real county as one polygon, with its name", () => {
    const read = readZone(fixture("zone-county-KSC173.json"), SEDGWICK);
    expect(read).toMatchObject({ ok: true, name: "Sedgwick" });
    const [shape, ...more] = read.ok ? read.shapes : [];
    expect(more).toEqual([]);
    expect(shape?.type).toBe("polygon");
    const ring = shape?.type === "polygon" ? shape.rings[0] : undefined;
    expect(ring?.length).toBeGreaterThan(4);
    expect(ring?.at(0)).toEqual(ring?.at(-1));
    // Each position is in Kansas: the longitude first.
    expect(ring?.every(([lon, lat]) => lon > -103 && lon < -94 && lat > 36 && lat < 41)).toBe(true);
  });

  it("reads a real forecast zone", () => {
    expect(readZone(fixture("zone-forecast-KSZ083.json"), { kind: "forecast", id: "KSZ083" })).toMatchObject({ ok: true, name: "Sedgwick" });
  });

  it("gives one shape for each part of a county with islands", () => {
    const read = readZone(fixture("zone-county-TXC167-parts.json"), GALVESTON);
    expect(read.ok && read.shapes.map((shape) => shape.type)).toEqual(["polygon", "polygon", "polygon"]);
  });

  it("removes the altitude of a position, and keeps the polygons of a collection", () => {
    const body = changed("zone-county-KSC173.json", (value) => {
      const ring = [
        [-97, 37, 400],
        [-96, 37, 400],
        [-96, 38, 400],
        [-97, 37, 400],
      ];
      value["geometry"] = { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [-97, 37] }, { type: "Polygon", coordinates: [ring] }] };
    });
    const read = readZone(body, SEDGWICK);
    expect(read.ok && read.shapes).toEqual([{ type: "polygon", rings: [[[-97, 37], [-96, 37], [-96, 38], [-97, 37]]] }]);
  });

  it("refuses a ring that is not closed, with the code and the path of geo", () => {
    const body = changed("zone-county-KSC173.json", (value) => {
      const geometry = value["geometry"] as { coordinates: number[][][] };
      geometry.coordinates[0]!.pop();
    });
    const read = readZone(body, SEDGWICK);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toMatch(/ring-not-closed at /);
  });

  it.each([
    ["the answer of a different zone", fixture("zone-county-KSC173.json"), GALVESTON],
    ["no geometry", changed("zone-county-KSC173.json", (value) => void (value["geometry"] = null)), SEDGWICK],
    ["a geometry with no polygon", changed("zone-county-KSC173.json", (value) => void (value["geometry"] = { type: "Point", coordinates: [-97, 37] })), SEDGWICK],
    ["a list", fixture("zones-KS-county.json"), SEDGWICK],
    ["not JSON", "", SEDGWICK],
  ])("refuses %s", (_name, body, key) => {
    expect(readZone(body, key)).toMatchObject({ ok: false });
  });
});
