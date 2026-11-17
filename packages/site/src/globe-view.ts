/**
 * The parts of the globe of the demo and of the local page, as data. The function `globeParts` is a pure calculation. It gives the
 * areas, the points, the names and the regions of a map payload for the globe of `@mark1russell7/visuals`. Thus the
 * tests examine them with no browser. The globe shows the same view as the flat map of `map-view.ts`.
 */

import { ASSESSED_LEVELS, type AssessedLevel, type MapPayload, type MapPlace, type MapRegion, type MapShape, type Status } from "@mark1russell7/alerts";
import { bboxCenter, bboxOfGeoJson, circleKm, fromPosition, type LatLon, type Region } from "@mark1russell7/geo";
import type { GlobeArea, GlobePoint } from "@mark1russell7/visuals/globe";
import { incidentTitle, PIN_PAD_KM, placeTitle, regionTitle } from "./map-view.ts";
import { STATUS_LOOKS, type OtherStatus } from "./status.ts";

/**
 * The value that a pick of a part of the globe gives to the page. A part is an incident, a watched place or a region
 * of the basemap. `words` names the part for a person. The incident of a place is its first incident: the highest level.
 */
export type GlobeValue =
  | { readonly type: "incident"; readonly words: string; readonly anchor: string }
  | { readonly type: "place"; readonly words: string; readonly id: string; readonly incident: string | undefined }
  | { readonly type: "region"; readonly words: string; readonly code: string };

/**
 * A name on the globe. It is the name of a watched place, the name of a region, or the word of a status. The text of
 * a place is next to its dot. The text of a region, and of a place with no position, is in the region. The word of a
 * status is in the area of its incident.
 */
export interface GlobeName {
  /** The record of the place, of the region or of the incident. The text gets the highlight of the record. */
  readonly record: string;
  /** The position of the name: the position of the place, or the middle of the box of the region or of the incident. */
  readonly place: LatLon;
  /** The label of the place, the name of the region, or the word of the status. */
  readonly text: string;
  /** The style of the name. A place has the style of its dot or of the outline of its region. A region has `ZONE_KIND`, and a status has its `statusKind`. */
  readonly kind: string;
  /** The rank of the name: the rank of the level of a place, `STATUS_RANK` or `REGION_RANK`. When two texts need one position, the text of the higher rank stays. */
  readonly rank: number;
  /**
   * The width of the mark of a place, in CSS pixels: the dot, or the gap ring around it. The text stays off the mark.
   * A region has no mark, and a place with no position has no mark. The value is then 0, and the text is on its position.
   */
  readonly size: number;
}

/** The options of the parts of the globe. */
export interface GlobePartsOptions {
  /**
   * This value is true for a map that shows the name of each region of the basemap. The default is false.
   * A map of a state has many regions, so it shows only the names of the places.
   */
  readonly regionNames?: boolean | undefined;
}

/** The parts of the globe for one map payload. */
export interface GlobeParts {
  /** The areas, from the bottom to the top: the regions of the basemap, the incidents from the lowest level, the outlines of the places. */
  readonly areas: readonly GlobeArea<GlobeValue>[];
  /** One point for each place with a position. A place with a short coverage has a larger point below it: the gap ring. */
  readonly points: readonly GlobePoint<GlobeValue>[];
  /**
   * One name for each place with a label. A place with no position and no shape has no name. With `regionNames`, each region with a name is also here.
   * An incident with a shape and a status other than `actual` has the word of its status as a name.
   */
  readonly names: readonly GlobeName[];
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

/** This function gives the name of the style of the word of a status. */
export const statusKind = (status: OtherStatus): string => `status-${status}`;

/**
 * This function gives the name of the style of the area of an incident of a level and a status.
 * The default status is `actual`. Each other status has a style of its own at each level.
 */
export const areaKind = (level: AssessedLevel, status: Status = "actual"): string => (status === "actual" ? `level-${level}` : `${statusKind(status)}-${level}`);

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

/** This function gives the rank of a level for the names: a higher level gives a larger number. */
export const levelRank = (level: AssessedLevel): number => ASSESSED_LEVELS.indexOf(level);

/** The rank of the name of a region. It is below the rank of each level, so the name of a place stays before the name of a region. */
export const REGION_RANK = -1;

/** The rank of the word of a status. It is above the rank of a region and below the rank of each level. */
export const STATUS_RANK = -0.5;

/** This function gives the middle of the box of some regions, or `undefined` for no region. */
function middleOf(regions: readonly Region[]): LatLon | undefined {
  const box = bboxOfGeoJson({ type: "GeometryCollection", geometries: [...regions] });
  return box === undefined ? undefined : bboxCenter(box);
}

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
export function globeParts(payload: MapPayload, options: GlobePartsOptions = {}): GlobeParts {
  const { view, basemap } = payload;
  const areas: GlobeArea<GlobeValue>[] = [];
  const points: GlobePoint<GlobeValue>[] = [];
  const names: GlobeName[] = [];
  const regions: Region[] = [];
  const incidents = new Map<string, readonly Region[]>();

  for (const region of basemap) {
    const record = regionRecord(region);
    const value: GlobeValue = { type: "region", words: regionTitle(region), code: region.code.code };
    const shapes = region.shapes.map(regionOf);
    for (const shape of shapes) areas.push({ record, region: shape, kind: ZONE_KIND, value });
    const text = region.name.trim();
    const middle = options.regionNames === true && text !== "" ? middleOf(shapes) : undefined;
    if (middle !== undefined) names.push({ record, place: middle, text, kind: ZONE_KIND, rank: REGION_RANK, size: 0 });
  }
  // The view has the highest level first. The globe draws the last area on top, as the flat map does.
  for (const incident of [...view.incidents].reverse()) {
    const record = incidentRecord(incident.anchor);
    const shapes = incident.shapes.map(regionOf);
    const value: GlobeValue = { type: "incident", words: incidentTitle(incident), anchor: incident.anchor };
    incidents.set(incident.anchor, shapes);
    for (const region of shapes) areas.push({ record, region, kind: areaKind(incident.level, incident.status), value });
    // The word of a status other than actual is at the middle of the box of the incident.
    const middle = incident.status === "actual" ? undefined : middleOf(shapes);
    if (incident.status !== "actual" && middle !== undefined) {
      names.push({ record, place: middle, text: STATUS_LOOKS[incident.status].word, kind: statusKind(incident.status), rank: STATUS_RANK, size: 0 });
    }
  }
  for (const place of view.places) {
    const record = placeRecord(place.id);
    // A pick of a place selects the first incident of the place: the incident of the highest level.
    const value: GlobeValue = { type: "place", words: placeTitle(place), id: place.id, incident: place.incidents[0] };
    const text = place.label.trim();
    const rank = levelRank(place.level);
    if (place.at !== undefined) {
      const at = fromPosition(place.at);
      // The ring is below the dot. The two points have one record, so they are one record of the globe.
      if (hasGap(place)) points.push({ record, place: at, kind: GAP_KIND, value, size: GAP_SIZE });
      points.push({ record, place: at, kind: pinKind(place.level), value, size: PIN_SIZE });
      if (text !== "") names.push({ record, place: at, text, kind: pinKind(place.level), rank, size: hasGap(place) ? GAP_SIZE : PIN_SIZE });
      regions.push(circleKm(at, PIN_PAD_KM));
    } else {
      const shapes = place.shapes.map(regionOf);
      for (const region of shapes) areas.push({ record, region, kind: outlineKind(place.level), value, pick: false });
      // A place with no position has no mark. Its name is at the middle of the box of its region.
      const middle = text === "" ? undefined : middleOf(shapes);
      if (middle !== undefined) names.push({ record, place: middle, text, kind: outlineKind(place.level), rank, size: 0 });
    }
  }
  const all = [...areas.map((area) => area.region), ...regions];
  return { areas, points, names, regions: all, incidents, grid: gridOf(all) };
}
