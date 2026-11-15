import { Problems, type Position } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { capCircle, capPolygon, capPosition } from "./geometry.ts";

const sink = (): Problems => new Problems();

/** This function writes a ring as a CAP polygon: `lat,lon` with spaces between the points. */
const capText = (ring: readonly Position[]): string => ring.map(([lon, lat]) => `${String(lat)},${String(lon)}`).join(" ");

/** Positions in range, with at most 6 decimals, as the sources give them. */
const position = fc
  .tuple(fc.integer({ min: -180_000_000, max: 180_000_000 }), fc.integer({ min: -90_000_000, max: 90_000_000 }))
  .map(([lon, lat]): Position => [lon / 1e6, lat / 1e6]);

/** Closed rings of 4 to 20 points. */
const ring = fc.array(position, { minLength: 3, maxLength: 19 }).map((points): Position[] => [...points, points[0] as Position]);

describe("the areas of a CAP message", () => {
  it("changes a CAP point lat,lon into a position [lon, lat]", () => {
    expect(capPosition("30.29,-100.79")).toEqual([-100.79, 30.29]);
    expect(capPosition(" -33.5 , 151.25 ")).toEqual([151.25, -33.5]);
  });

  it("refuses a point out of range or not a plain decimal", () => {
    for (const text of ["91,0", "0,181", "1e2,3", "30.29", "30.29,-100.79,5", "a,b", "", "0x10,1"]) {
      expect(capPosition(text), text).toBeUndefined();
    }
  });

  it("gives back each closed ring that a CAP text holds, in the order of the core", () => {
    fc.assert(
      fc.property(ring, (points) => {
        const problems = sink();
        expect(capPolygon(capText(points), "polygon", problems)).toEqual({ type: "polygon", rings: [points] });
        expect(problems.list).toEqual([]);
      }),
    );
  });

  it("reads the polygon of the IPAWS fixture: the first point is lon -100.79, lat 30.29", () => {
    const text = "30.29,-100.79 30.29,-99.55 30.28,-99.54 29.84,-99.18 29.63,-99.36 30.29,-100.79";
    const area = capPolygon(text, "polygon", sink());
    expect(area?.type === "polygon" && area.rings[0]?.[0]).toEqual([-100.79, 30.29]);
  });

  it("closes a ring that does not close, with a problem", () => {
    const problems = sink();
    const area = capPolygon("1,1 1,2 2,2 2,1", "p", problems);
    expect(area).toEqual({ type: "polygon", rings: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] });
    expect(problems.list).toEqual([{ path: "p", message: "the polygon does not close: the map adds its first point at the end", fatal: false }]);
    expect(problems.lossy).toBe(0);
  });

  it("gives no area for a bad point or for fewer than 4 points", () => {
    for (const text of ["1,1 1,2 1,1", "1,1 1,2 x,y 1,1", "", "1,1 200,2 2,2 1,1"]) {
      const problems = sink();
      expect(capPolygon(text, "p", problems), text).toBeUndefined();
      expect(problems.lossy, text).toBeGreaterThan(0);
    }
  });

  it("reads a circle with a radius in kilometers", () => {
    expect(capCircle("32.9,-97.0 10", "c", sink())).toEqual({ type: "circle", center: [-97, 32.9], radiusKm: 10 });
    expect(capCircle("32.9,-97.0 0", "c", sink())).toEqual({ type: "circle", center: [-97, 32.9], radiusKm: 0 });
  });

  it("gives no area for a bad circle", () => {
    for (const text of ["32.9,-97.0", "32.9,-97.0 -1", "32.9,-97.0 ten", "100,0 5"]) {
      const problems = sink();
      expect(capCircle(text, "c", problems), text).toBeUndefined();
      expect([problems.list.length, problems.lossy]).toEqual([1, 1]);
    }
  });
});
