/**
 * This module reads two answers of the NWS zone service: the list of the zones of a state, and the
 * outline of a zone. The functions are pure. Each problem of an answer is a text.
 */
import type { MapShape, Position, RegionCode } from "@mark1russell7/alerts";
import { countyUgcOfSame, stateOfUgc } from "@mark1russell7/alerts-format-nws";
import { parseGeometry, type Geometry } from "@mark1russell7/geo";
import { compareCodeUnits } from "@mark1russell7/text/order";

/**
 * The kinds of zones of the store: the counties (`KSC173`) and the forecast zones (`KSZ083`). The
 * store has no fire zones (AL-33) and no marine zones.
 */
export type ZoneKind = "county" | "forecast";

/** The kinds of zones, in the order of the code: a county code is before a zone code of a state. */
export const ZONE_KINDS: readonly ZoneKind[] = ["county", "forecast"];

/** The value of the property `type` of a row of each kind. The NWS API gives the type `public` to a forecast zone. */
const ROW_TYPE: Readonly<Record<ZoneKind, string>> = { county: "county", forecast: "public" };

/** The key of one zone: its kind and its UGC code in capital letters. */
export interface ZoneKey {
  readonly kind: ZoneKind;
  readonly id: string;
}

/**
 * This function gives the kind of a UGC code of a state: `county` for `KSC173` and `forecast` for
 * `KSZ083`. A marine zone (`GMZ250`) or a text that is not a UGC code gives `undefined`.
 */
export function zoneKindOf(ugc: string): ZoneKind | undefined {
  const code = ugc.trim().toUpperCase();
  if (stateOfUgc(code) === undefined) return undefined;
  return code[2] === "C" ? "county" : "forecast";
}

/**
 * This function gives the zone of a region code, or `undefined`. The system `ugc` gives its county or
 * forecast zone. The system `same` gives the full county, also for a part of a county.
 *
 * The NWS uses a `Z` code for a forecast zone and for a fire zone. This function gives the forecast
 * zone. In most states the two zones have the same outline. AL-33 adds the fire zones.
 */
export function zoneOfCode(code: RegionCode): ZoneKey | undefined {
  const ugc = code.system === "ugc" ? code.code.trim().toUpperCase() : code.system === "same" ? countyUgcOfSame(code.code) : undefined;
  if (ugc === undefined) return undefined;
  const kind = zoneKindOf(ugc);
  return kind === undefined ? undefined : { kind, id: ugc };
}

/** This function compares two codes by their code units, thus the order does not change with the locale. */
export function compareCodes(a: string, b: string): number {
  return compareCodeUnits(a, b);
}


/** This function gives the path of the list of the zones of one kind of a state, for example `/zones?area=KS&type=county`. */
export function listPath(state: string, kind: ZoneKind): string {
  return `/zones?area=${encodeURIComponent(state)}&type=${kind}`;
}

/** This function gives the path of the outline of one zone, for example `/zones/county/KSC173`. */
export function zonePath(key: ZoneKey): string {
  return `/zones/${key.kind}/${encodeURIComponent(key.id)}`;
}

/**
 * The result of `readList`. A list with no problem is complete. The store removes a zone only when a
 * complete list does not have it.
 */
export type ReadList =
  | { readonly ok: true; readonly ids: readonly string[]; readonly complete: boolean; readonly problems: readonly string[] }
  | { readonly ok: false; readonly problem: string };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** This function parses a JSON text. It gives `undefined` for a text that is not JSON. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // The caller tells the problem: the answer is not JSON.
    return undefined;
  }
}

/**
 * This function reads the list of the zones of one kind of a state. It gives the code of each correct
 * row once, in the order of the code. The function refuses an answer with no correct row, because such an answer
 * removes no zone. A row with a problem, a row twice, or a member `pagination` makes the list
 * incomplete.
 */
export function readList(body: string, state: string, kind: ZoneKind): ReadList {
  const parsed = parseJson(body);
  if (!isRecord(parsed) || parsed["type"] !== "FeatureCollection" || !Array.isArray(parsed["features"])) {
    return { ok: false, problem: `The list of the ${kind} zones of ${state} is not a GeoJSON FeatureCollection.` };
  }
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const [at, feature] of (parsed["features"] as readonly unknown[]).entries()) {
    const properties = isRecord(feature) && isRecord(feature["properties"]) ? feature["properties"] : undefined;
    const id = typeof properties?.["id"] === "string" ? properties["id"].trim().toUpperCase() : undefined;
    if (id === undefined || stateOfUgc(id) !== state || zoneKindOf(id) !== kind || properties?.["type"] !== ROW_TYPE[kind]) {
      problems.push(`Row ${String(at)} of the list of the ${kind} zones of ${state} is not a ${kind} zone of ${state}.`);
      continue;
    }
    if (ids.has(id)) {
      problems.push(`The list of the ${kind} zones of ${state} has ${id} two times.`);
      continue;
    }
    ids.add(id);
  }
  if (ids.size === 0) return { ok: false, problem: `The list of the ${kind} zones of ${state} has no correct row.` };
  const paged = isRecord(parsed["pagination"]) && parsed["pagination"]["next"] !== undefined;
  if (paged) problems.push(`The list of the ${kind} zones of ${state} has more pages. The store reads only the first page.`);
  return { ok: true, ids: [...ids].sort(compareCodes), complete: problems.length === 0, problems };
}

/** The result of `readZone`: the name and the shapes of a zone, or a problem. */
export type ReadZone = { readonly ok: true; readonly name: string; readonly shapes: readonly MapShape[] } | { readonly ok: false; readonly problem: string };

/** This function changes the rings of a GeoJSON polygon into a shape of the map. It removes the altitudes. */
function polygonShape(rings: readonly (readonly (readonly number[])[])[]): MapShape {
  return { type: "polygon", rings: rings.map((ring) => ring.map((position): Position => [position[0]!, position[1]!])) };
}

/** This function gives the polygons of a geometry. A point or a line has no polygon. */
function shapesOf(geometry: Geometry): MapShape[] {
  switch (geometry.type) {
    case "Polygon":
      return [polygonShape(geometry.coordinates)];
    case "MultiPolygon":
      return geometry.coordinates.map(polygonShape);
    case "GeometryCollection":
      return geometry.geometries.flatMap(shapesOf);
    default:
      return [];
  }
}

/**
 * This function reads the outline of one zone. The geometry is GeoJSON (RFC 7946), and the function
 * `parseGeometry` of `@mark1russell7/geo` examines it. Each polygon of a multipolygon, for example an
 * island of a county, is one shape.
 */
export function readZone(body: string, key: ZoneKey): ReadZone {
  const parsed = parseJson(body);
  const properties = isRecord(parsed) && isRecord(parsed["properties"]) ? parsed["properties"] : undefined;
  if (!isRecord(parsed) || parsed["type"] !== "Feature" || properties === undefined) return { ok: false, problem: `The answer for ${key.id} is not a GeoJSON Feature.` };
  const id = typeof properties["id"] === "string" ? properties["id"].trim().toUpperCase() : undefined;
  if (id !== key.id) return { ok: false, problem: `The answer for ${key.id} is the zone ${id ?? "with no id"}.` };
  if (parsed["geometry"] === null || parsed["geometry"] === undefined) return { ok: false, problem: `The answer for ${key.id} has no geometry.` };
  const geometry = parseGeometry(parsed["geometry"]);
  if (geometry.tag === "err") {
    const at = geometry.error.path === "" ? "" : ` at ${geometry.error.path}`;
    return { ok: false, problem: `The geometry of ${key.id} is not correct GeoJSON (${geometry.error.code}${at}).` };
  }
  const shapes = shapesOf(geometry.value);
  if (shapes.length === 0) return { ok: false, problem: `The geometry of ${key.id} has no polygon.` };
  const name = typeof properties["name"] === "string" && properties["name"].trim() !== "" ? properties["name"].trim() : key.id;
  return { ok: true, name, shapes };
}
