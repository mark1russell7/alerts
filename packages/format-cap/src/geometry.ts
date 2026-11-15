/**
 * The areas of a CAP message as areas of the core. CAP gives each point as `lat,lon` (WGS 84). The
 * core uses GeoJSON positions: `[lon, lat]`. This module is the one place that changes the order.
 */

import type { Area, Position, ProblemSink } from "@mark1russell7/alerts";

/** A decimal number with an optional sign. CAP uses decimal degrees, with no exponent. */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** This function reads a decimal number. A text that is not a plain decimal number gives `undefined`. */
function decimalOf(text: string): number | undefined {
  return DECIMAL.test(text) ? Number(text) : undefined;
}

/**
 * This function reads one CAP point, `lat,lon`, as a core position, `[lon, lat]`. A bad point, or a
 * point out of range, gives `undefined`.
 */
export function capPosition(text: string): Position | undefined {
  const parts = text.split(",");
  if (parts.length !== 2) return undefined;
  const lat = decimalOf((parts[0] as string).trim());
  const lon = decimalOf((parts[1] as string).trim());
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return [lon, lat];
}

const samePosition = (a: Position, b: Position): boolean => a[0] === b[0] && a[1] === b[1];

/**
 * This function reads a CAP polygon: points with spaces between them. CAP 1.2 asks for 4 points or more,
 * and the last point is the first point. A ring that does not close is a note, and the function closes
 * it. A bad point, or fewer than 4 points, is a lossy problem, and the function gives no area.
 */
export function capPolygon(text: string, path: string, problems: ProblemSink): Area | undefined {
  const ring: Position[] = [];
  for (const point of text.trim().split(/\s+/)) {
    if (point === "") continue;
    const position = capPosition(point);
    if (position === undefined) {
      problems.add(path, `the point ${JSON.stringify(point)} is not a point "lat,lon" in range`);
      return undefined;
    }
    ring.push(position);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first !== undefined && last !== undefined && !samePosition(first, last)) {
    problems.add(path, "the polygon does not close: the map adds its first point at the end", "note");
    ring.push(first);
  }
  if (ring.length < 4) {
    problems.add(path, `the polygon has ${String(ring.length)} points: CAP asks for 4 or more`);
    return undefined;
  }
  return { type: "polygon", rings: [ring] };
}

/**
 * This function reads a CAP circle: a point, a space and a radius in kilometers. A bad circle is a
 * problem, and the function gives no area.
 */
export function capCircle(text: string, path: string, problems: ProblemSink): Area | undefined {
  const parts = text.trim().split(/\s+/);
  const center = parts.length === 2 ? capPosition(parts[0] as string) : undefined;
  const radiusKm = parts.length === 2 ? decimalOf(parts[1] as string) : undefined;
  if (center === undefined || radiusKm === undefined || radiusKm < 0) {
    problems.add(path, `the circle ${JSON.stringify(text)} is not "lat,lon radius" with a radius in kilometers`);
    return undefined;
  }
  return { type: "circle", center, radiusKm };
}
