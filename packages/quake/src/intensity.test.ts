import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_LAW,
  bandDiscs,
  FELT_INTENSITY,
  feltRadiusKm,
  INTENSITY_BANDS,
  intensityAt,
  lawAt,
  MAX_RADIUS_KM,
  severityOfIntensity,
  STABLE_BOX,
  STABLE_LAW,
  type IntensityLaw,
} from "./intensity.ts";

/** One curve of a DYFI plot: the MMI at each hypocentral distance in kilometers. */
interface Curve {
  readonly legend: string;
  readonly data: readonly { readonly x: number; readonly y: number }[];
}

const curvesOf = (name: string): readonly Curve[] => (JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as { datasets: Curve[] }).datasets;
const curve = (curves: readonly Curve[], legend: string): Curve => {
  const found = curves.find((each) => each.legend === legend);
  if (found === undefined) throw new Error(`no curve ${legend}`);
  return found;
};

/** The DYFI plot of the M5.4 event `us70005dj8` (depth 25 km), with the 2007 laws. */
const PLOT_2007 = curvesOf("dyfi-atten-us70005dj8.json");
/** The DYFI plot of the M5.5 event `us7000ki5u` (depth 13.116 km), with the 2014 laws. */
const PLOT_2014 = curvesOf("dyfi-atten-us7000ki5u.json");

/** This function gives the distance where a curve first falls below a level, by a line between two points. */
const crossing = (data: Curve["data"], level: number): number => {
  for (let index = 1; index < data.length; index += 1) {
    const [a, b] = [data[index - 1], data[index]];
    if (a !== undefined && b !== undefined && a.y >= level && b.y < level) return a.x + ((level - a.y) * (b.x - a.x)) / (b.y - a.y);
  }
  throw new Error("the curve does not cross the level");
};

describe("intensityAt", () => {
  it("gives each point of the two DYFI curves of the 2007 laws, to 1e-4", () => {
    const pairs: [string, IntensityLaw][] = [
      ["Atkinson-Wald 2007 Calif.", ACTIVE_LAW],
      ["Atkinson-Wald 2007 Cent/EUS", STABLE_LAW],
    ];
    for (const [legend, law] of pairs) {
      const { data } = curve(PLOT_2007, legend);
      expect(data.length).toBeGreaterThan(20);
      for (const point of data) expect(Math.abs(intensityAt(law, 5.4, point.x) - point.y)).toBeLessThan(1e-4);
    }
  });

  it("gives less shaking at a farther distance, near the felt level", () => {
    fc.assert(
      fc.property(fc.constantFrom(ACTIVE_LAW, STABLE_LAW), fc.double({ min: 4, max: 8, noNaN: true }), fc.double({ min: 0, max: 500, noNaN: true }), (law, magnitude, distance) => {
        expect(intensityAt(law, magnitude, distance + 1)).toBeLessThan(intensityAt(law, magnitude, distance));
      }),
    );
  });
});

describe("feltRadiusKm", () => {
  it("gives the edge of the felt level to 0.01 km", () => {
    fc.assert(
      fc.property(fc.constantFrom(ACTIVE_LAW, STABLE_LAW), fc.double({ min: 3, max: 8, noNaN: true }), fc.double({ min: 0, max: 60, noNaN: true }), (law, magnitude, depth) => {
        const radius = feltRadiusKm(law, magnitude, depth);
        const at = (x: number): number => intensityAt(law, magnitude, Math.hypot(x, depth));
        // The radius is the edge less 0.01 km at most, so the shaking at 0.02 km more is below the level.
        if (radius > 0) expect(at(radius)).toBeGreaterThanOrEqual(FELT_INTENSITY);
        expect(at(radius + 0.02)).toBeLessThan(FELT_INTENSITY);
      }),
    );
  });

  it("grows with the magnitude and falls with the depth", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(ACTIVE_LAW, STABLE_LAW),
        fc.double({ min: 2.5, max: 9, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        (law, magnitude, more, depth, deeper) => {
          expect(feltRadiusKm(law, magnitude + more, depth)).toBeGreaterThanOrEqual(feltRadiusKm(law, magnitude, depth));
          expect(feltRadiusKm(law, magnitude, depth + deeper)).toBeLessThanOrEqual(feltRadiusKm(law, magnitude, depth));
        },
      ),
    );
  });

  it("gives the radii of the felt level at a depth of 10 km", () => {
    const radii = (law: IntensityLaw): number[] => [4, 5, 6, 7].map((magnitude) => Math.round(feltRadiusKm(law, magnitude, 10)));
    expect(radii(ACTIVE_LAW)).toEqual([22, 73, 169, 334]);
    expect(radii(STABLE_LAW)).toEqual([65, 360, 713, 1115]);
  });

  it("gives 0 at magnitude 2.5, so the feed of magnitude 2.5 or more misses no felt event", () => {
    for (const law of [ACTIVE_LAW, STABLE_LAW]) {
      expect(feltRadiusKm(law, 2.5, 0)).toBe(0);
      expect(feltRadiusKm(law, 2.5, -1)).toBe(0);
    }
  });

  it("gives MAX_RADIUS_KM at most, and the radius of a different level", () => {
    expect(feltRadiusKm(STABLE_LAW, 9.5, 0)).toBeLessThanOrEqual(MAX_RADIUS_KM);
    expect(feltRadiusKm(STABLE_LAW, 9.5, 0, 1)).toBe(MAX_RADIUS_KM);
    expect(feltRadiusKm(ACTIVE_LAW, 6, 10, 6)).toBeLessThan(feltRadiusKm(ACTIVE_LAW, 6, 10));
  });

  it("holds the difference of the 2007 laws from the 2014 laws of DYFI at magnitude 5.5", () => {
    const depth = 13.116;
    const ratio = (law: IntensityLaw, legend: string): number => {
      const hypocentral = crossing(curve(PLOT_2014, legend).data, FELT_INTENSITY);
      return feltRadiusKm(law, 5.5, depth) / Math.sqrt(hypocentral ** 2 - depth ** 2);
    };
    expect(ratio(ACTIVE_LAW, "AWW2014 West NA")).toBeCloseTo(0.8, 2);
    expect(ratio(STABLE_LAW, "AWW2014 East NA")).toBeCloseTo(1.28, 2);
  });
});

describe("lawAt", () => {
  it("gives the stable law in the box, and the active law outside it", () => {
    expect(lawAt([-97.5, 38.5])).toBe(STABLE_LAW);
    expect(lawAt([STABLE_BOX.west, STABLE_BOX.south])).toBe(STABLE_LAW);
    expect(lawAt([STABLE_BOX.east, STABLE_BOX.north])).toBe(STABLE_LAW);
    expect(lawAt([-118.2, 34])).toBe(ACTIVE_LAW);
    expect(lawAt([-150, 61.2])).toBe(ACTIVE_LAW);
    expect(lawAt([35.95, 37.58])).toBe(ACTIVE_LAW);
    expect(lawAt([STABLE_BOX.west - 0.01, 38])).toBe(ACTIVE_LAW);
  });
});

describe("bandDiscs", () => {
  it("gives the bands at the edges of the rounded MMI, from the strongest", () => {
    expect(INTENSITY_BANDS.map((band) => [band.severity, band.from])).toEqual([
      ["extreme", 7.5],
      ["severe", 6.5],
      ["moderate", 5.5],
      ["minor", FELT_INTENSITY],
    ]);
    for (const band of INTENSITY_BANDS) expect(severityOfIntensity(band.from)).toBe(band.severity);
  });

  it("gives the felt disc as the last disc, and only the bands that the epicenter reaches", () => {
    const discs = bandDiscs(ACTIVE_LAW, 6, 10);
    expect(discs.at(-1)).toEqual({ severity: "minor", from: FELT_INTENSITY, radiusKm: feltRadiusKm(ACTIVE_LAW, 6, 10) });
    const strongest = intensityAt(ACTIVE_LAW, 6, 10);
    expect(discs.map((disc) => disc.severity)).toEqual(INTENSITY_BANDS.filter((band) => strongest >= band.from).map((band) => band.severity));
    expect(bandDiscs(ACTIVE_LAW, 2.5, 10)).toEqual([]);
  });

  it("moves each edge by the bias, so the epicenter has the measured shaking", () => {
    const strongest = intensityAt(ACTIVE_LAW, 5.5, 10);
    const discs = bandDiscs(ACTIVE_LAW, 5.5, 10, 6.4 - strongest);
    expect(discs.map((disc) => disc.severity)).toEqual(["moderate", "minor"]);
    expect(discs[0]?.radiusKm).toBe(feltRadiusKm(ACTIVE_LAW, 5.5, 10, 5.5 - (6.4 - strongest)));
    expect(bandDiscs(ACTIVE_LAW, 5.5, 10, 8.1 - strongest)[0]?.severity).toBe("extreme");
  });

  it("gives nested discs, and the smallest disc that holds a place has the severity of the shaking at the place", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(ACTIVE_LAW, STABLE_LAW),
        fc.double({ min: 3, max: 8.5, noNaN: true }),
        fc.double({ min: 0, max: 60, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 1500, noNaN: true }),
        (law, magnitude, depth, bias, distance) => {
          const discs = bandDiscs(law, magnitude, depth, bias);
          for (let index = 1; index < discs.length; index += 1) expect(discs[index]?.radiusKm).toBeGreaterThanOrEqual(discs[index - 1]?.radiusKm ?? 0);
          // The edges have a precision of 0.01 km, so a place at 0.02 km or less from an edge can fall in either band.
          if (discs.some((disc) => Math.abs(disc.radiusKm - distance) <= 0.02)) return;
          const shaking = intensityAt(law, magnitude, Math.hypot(distance, depth)) + bias;
          const holder = discs.find((disc) => distance <= disc.radiusKm);
          expect(holder?.severity).toBe(shaking >= FELT_INTENSITY ? severityOfIntensity(shaking) : undefined);
        },
      ),
    );
  });
});

describe("severityOfIntensity", () => {
  it("gives the severity of the rounded MMI value", () => {
    const table: [number, string][] = [
      [1, "minor"],
      [5.49, "minor"],
      [5.5, "moderate"],
      [6.49, "moderate"],
      [6.5, "severe"],
      [7.49, "severe"],
      [7.5, "extreme"],
      [10, "extreme"],
      [Number.NaN, "unknown"],
      [Number.POSITIVE_INFINITY, "unknown"],
    ];
    for (const [mmi, severity] of table) expect(severityOfIntensity(mmi)).toBe(severity);
  });
});
