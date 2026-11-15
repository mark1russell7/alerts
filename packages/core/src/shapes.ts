/**
 * The tests of the shapes of an area against a position: the polygons and the circles of the core. The
 * home of geography, `@mark1russell7/geo`, gives the great-circle distances. An edge of a polygon is a
 * straight line in longitude and latitude, as in GeoJSON (RFC 7946).
 */
import { distanceKm, distanceToGeometryKm, GeoError } from "@mark1russell7/geo";
import type { Area, Position } from "./contracts.ts";
import type { MapShape } from "./map.ts";

/** This function tells if an area is a shape: a polygon or a circle. */
export function isShape(area: Area): area is MapShape {
  return area.type === "polygon" || area.type === "circle";
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
