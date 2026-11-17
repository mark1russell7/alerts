/**
 * The tests of the shapes of an area against a position: the polygons and the circles of the core. The
 * home of geography, `@mark1russell7/geo`, gives the great-circle distances. An edge of a polygon is a
 * straight line in longitude and latitude, as in GeoJSON (RFC 7946).
 */
import { distanceKm, distanceToGeometryKm, GeoError } from "@mark1russell7/geo";
import { canonicalJson } from "@mark1russell7/rigor-generators";
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { Area, Position } from "./contracts.ts";
import type { MapRegion, MapShape } from "./map.ts";

/** This function tells if an area is a shape: a polygon or a circle. */
export function isShape(area: Area): area is MapShape {
  return area.type === "polygon" || area.type === "circle";
}

/**
 * This function gives each area one time, with no block key, in the order of the areas. The NWS and IPAWS
 * copies of one warning give equal areas in two blocks. The map and the views draw each area one time.
 */
export function areasWithoutBlocks(areas: readonly Area[]): Area[] {
  const byText = new Map<string, Area>();
  for (const area of areas) {
    const plain = withoutBlock(area);
    const text = canonicalJson(plain, { form: "json" });
    if (!byText.has(text)) byText.set(text, plain);
  }
  return [...byText.values()];
}

/**
 * This function gives each shape one time, in the order of the first. Two shapes are equal by reference or by value, with no
 * block key. A zone and a county of one message can give the same outline from the store. The map draws it one time.
 */
export function distinctShapes(shapes: readonly MapShape[]): MapShape[] {
  const seen = new Set<MapShape>();
  const texts = new Set<string>();
  const out: MapShape[] = [];
  for (const shape of shapes) {
    if (seen.has(shape)) continue;
    seen.add(shape);
    const text = canonicalJson(withoutBlock(shape), { form: "json" });
    if (texts.has(text)) continue;
    texts.add(text);
    out.push(shape);
  }
  return out;
}

function withoutBlock(area: Area): Area {
  if (area.type === "place" || area.block === undefined) return area;
  if (area.type === "polygon") return { type: "polygon", rings: area.rings };
  if (area.type === "circle") return { type: "circle", center: area.center, radiusKm: area.radiusKm };
  return { type: "code", system: area.system, code: area.code };
}

/**
 * This function gives the great-circle distance in kilometers from a position to the nearest point of a
 * shape. The distance is 0 only when the shape contains the position. The function gives `undefined`
 * when `@mark1russell7/geo` refuses the shape, for example a ring with fewer than 4 positions.
 */
export function shapeDistanceKm(shape: MapShape, at: Position): number | undefined {
  const point = { lat: at[1], lon: at[0] };
  try {
    if (shape.type === "circle") {
      const center = { lat: shape.center[1], lon: shape.center[0] };
      return Math.max(0, distanceKm(point, center) - shape.radiusKm);
    }
    return distanceToGeometryKm(point, { type: "Polygon", coordinates: shape.rings });
  } catch (error) {
    if (error instanceof GeoError) return undefined;
    throw error;
  }
}

/**
 * This function gives the great-circle distance in kilometers from a position to the nearest shape of a region. The distance
 * is 0 only when a shape contains the position. A region with no shape that `@mark1russell7/geo` reads gives `undefined`.
 */
export function regionDistanceKm(region: MapRegion, at: Position): number | undefined {
  let nearest: number | undefined;
  for (const shape of region.shapes) {
    const distance = shapeDistanceKm(shape, at);
    if (distance !== undefined && (nearest === undefined || distance < nearest)) nearest = distance;
  }
  return nearest;
}

/** A region near a position, with the great-circle distance from the position to the nearest shape of the region. */
export interface NearRegion {
  readonly region: MapRegion;
  /** The distance in kilometers. It is 0 when a shape of the region contains the position. */
  readonly distanceKm: number;
}

/**
 * This function gives the regions with a shape at `bufferKm` or less from a position. The nearest region is first. Regions at
 * one distance are in the order of the system and the code. A region with no shape that geo reads is not near. A negative
 * buffer, or a buffer that is not finite, throws a `RangeError`.
 */
export function regionsNear(regions: readonly MapRegion[], at: Position, bufferKm: number): NearRegion[] {
  if (!Number.isFinite(bufferKm) || bufferKm < 0) throw new RangeError(`The buffer is ${String(bufferKm)}, not a number of 0 or more kilometers.`);
  const near: NearRegion[] = [];
  for (const region of regions) {
    const distanceKm = regionDistanceKm(region, at);
    if (distanceKm !== undefined && distanceKm <= bufferKm) near.push({ region, distanceKm });
  }
  return near.sort((a, b) => a.distanceKm - b.distanceKm || compareCodeUnits(a.region.code.system, b.region.code.system) || compareCodeUnits(a.region.code.code, b.region.code.code));
}
