/**
 * The parts of the globe of the local page, as data. The function `globeParts` is a pure calculation: it gives the
 * areas, the points and the regions of a map payload for the globe of `@mark1russell7/visuals`. Thus the tests
 * examine them with no browser. The globe shows the same view as the flat map of `map-view.ts`.
 */

import type { AssessedLevel, MapPayload, MapPlace, MapRegion, MapShape } from "@mark1russell7/alerts";
import { bboxOfGeoJson, circleKm, fromPosition, type Region } from "@mark1russell7/geo";
import type { GlobeArea, GlobePoint } from "@mark1russell7/visuals/globe";
import { LEVEL_WORDS } from "./draw.ts";
import { PIN_PAD_KM, placeTitle, regionTitle } from "./map-view.ts";

/**
 * The value that a pick of a part of the globe gives to the page. A part is an incident, a watched place or a region
 * of the basemap. `words` names the part for a person. The incident of a place is its first incident: the highest level.
 */
export type GlobeValue =
  | { readonly type: "incident"; readonly words: string; readonly anchor: string }
  | { readonly type: "place"; readonly words: string; readonly id: string; readonly incident: string | undefined }
  | { readonly type: "region"; readonly words: string; readonly code: string };

/** The parts of the globe for one map payload. */
export interface GlobeParts {
  /** The areas, from the bottom to the top: the regions of the basemap, the incidents from the lowest level, the outlines of the places. */
  readonly areas: readonly GlobeArea<GlobeValue>[];
  /** One point for each place with a position. A place with a short coverage has a larger point below it: the gap ring. */
  readonly points: readonly GlobePoint<GlobeValue>[];
  /** Each region of the picture, and a circle around each point. The first view of the globe shows them. */
  readonly regions: readonly Region[];
  /** The regions of each incident, by its anchor. The view of a selected incident shows them. */
  readonly incidents: ReadonlyMap<string, readonly Region[]>;
  /** The angle between two lines of the grid, in degrees. */
  readonly grid: number;
}

/** The width of the dot of a place, in CSS pixels. */
export const PIN_SIZE = 11;

/** The width of the gap ring of a place, in CSS pixels. The ring is around the dot of the place. */
export const GAP_SIZE = 21;

/** The name of the style of a region of the basemap. */
export const ZONE_KIND = "zone";

/** The name of the style of the gap ring: the sign of a place with a short coverage. */
export const GAP_KIND = "gap";

/** The angles between two lines of the grid that the globe uses, in degrees. */
export const GRID_STEPS: readonly number[] = [1, 2, 5, 10, 15];

/** The smallest count of the lines of the grid across the regions, when the grid has a step for it. */
const GRID_LINES = 4;

/** This function gives the name of the record of an incident on the globe. */
export const incidentRecord = (anchor: string): string => `incident:${anchor}`;

/** This function gives the name of the record of a watched place on the globe. */
export const placeRecord = (id: string): string => `place:${id}`;

/** This function gives the name of the record of a region of the basemap on the globe. */
export const regionRecord = (region: MapRegion): string => `region:${region.code.system}:${region.code.code}`;

/** This function gives the name of the style of the area of an incident of a level. */
export const areaKind = (level: AssessedLevel): string => `level-${level}`;

/** This function gives the name of the style of the outline of a place of a level. */
export const outlineKind = (level: AssessedLevel): string => `outline-${level}`;

/** This function gives the name of the style of the point of a place of a level. */
export const pinKind = (level: AssessedLevel): string => `pin-${level}`;

/**
 * This function gives a shape of the map as a region of `@mark1russell7/geo`. A circle on the ground becomes a
 * polygon. The rings of a polygon stay in their order: the globe accepts each order.
 */
export function regionOf(shape: MapShape): Region {
  if (shape.type === "circle") return circleKm(fromPosition(shape.center), shape.radiusKm);
  return { type: "Polygon", coordinates: shape.rings.map((ring) => ring.map((point) => [point[0], point[1]])) };
}

/** This function tells if the coverage of a place is short for one kind or more. */
const hasGap = (place: MapPlace): boolean => place.gaps.length > 0;

/**
 * This function gives the angle between two lines of the grid for the regions of a picture, in degrees.
 * A small picture gets a small step, so some lines go across it. No region gives the largest step.
 */
export function gridOf(regions: readonly Region[]): number {
  const largest = GRID_STEPS[GRID_STEPS.length - 1] ?? 15;
  const box = bboxOfGeoJson({ type: "GeometryCollection", geometries: [...regions] });
  if (box === undefined) return largest;
  // A box across the antimeridian has its west side at the larger longitude.
  const wide = box.east >= box.west ? box.east - box.west : box.east - box.west + 360;
  const span = Math.max(box.north - box.south, wide);
  let step = GRID_STEPS[0] ?? largest;
  for (const next of GRID_STEPS) if (next * GRID_LINES <= span) step = next;
  return step;
}

/**
 * This function gives the parts of the globe for a map payload. The areas go from the bottom to the top, so a pick
 * finds the highest level first. A place with a position is a point. A place with no position is the outline of its
 * region. The outline takes no pick, so a pick in it finds the incident below it. A shape that is not correct makes
 * the function throw the error of `@mark1russell7/geo`.
 */
export function globeParts(payload: MapPayload): GlobeParts {
  const { view, basemap } = payload;
  const areas: GlobeArea<GlobeValue>[] = [];
  const points: GlobePoint<GlobeValue>[] = [];
  const regions: Region[] = [];
  const incidents = new Map<string, readonly Region[]>();

  for (const region of basemap) {
    const value: GlobeValue = { type: "region", words: regionTitle(region), code: region.code.code };
    for (const shape of region.shapes) areas.push({ record: regionRecord(region), region: regionOf(shape), kind: ZONE_KIND, value });
  }
  // The view has the highest level first. The globe draws the last area on top, as the flat map does.
  for (const incident of [...view.incidents].reverse()) {
    const record = incidentRecord(incident.anchor);
    const shapes = incident.shapes.map(regionOf);
    const value: GlobeValue = { type: "incident", words: `${incident.kind.label}: ${LEVEL_WORDS[incident.level]}`, anchor: incident.anchor };
    incidents.set(incident.anchor, shapes);
    for (const region of shapes) areas.push({ record, region, kind: areaKind(incident.level), value });
  }
  for (const place of view.places) {
    const record = placeRecord(place.id);
    // A pick of a place selects the first incident of the place: the incident of the highest level.
    const value: GlobeValue = { type: "place", words: placeTitle(place), id: place.id, incident: place.incidents[0] };
    if (place.at !== undefined) {
      const at = fromPosition(place.at);
      // The ring is below the dot. The two points have one record, so they are one record of the globe.
      if (hasGap(place)) points.push({ record, place: at, kind: GAP_KIND, value, size: GAP_SIZE });
      points.push({ record, place: at, kind: pinKind(place.level), value, size: PIN_SIZE });
      regions.push(circleKm(at, PIN_PAD_KM));
    } else {
      for (const shape of place.shapes) areas.push({ record, region: regionOf(shape), kind: outlineKind(place.level), value, pick: false });
    }
  }
  const all = [...areas.map((area) => area.region), ...regions];
  return { areas, points, regions: all, incidents, grid: gridOf(all) };
}
