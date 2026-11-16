/**
 * The renderer of the view of the map. It draws a `MapView` of the core on a Mercator projection, with no tiles from
 * an outside server. The basemap is data: the regions under the view, each with its code, its name and its shapes.
 *
 * The function `mapNodes` is a pure calculation, and it gives the SVG as data. The function `drawMapView` only makes
 * the elements of that data. Thus the tests examine the map with no DOM.
 */

import { kindLabel, MAP_VIEW, type MapIncident, type MapPlace, type MapRegion, type MapShape, type MapView, type Position } from "@mark1russell7/alerts";
import { h } from "@mark1russell7/site-pages/chrome";
import { geoArea, geoCircle, geoMercator, geoPath, type ExtendedGeometryCollection, type GeoGeometryObjects, type GeoPath } from "d3-geo";
import { LEVEL_WORDS, levelChip, s } from "./draw.ts";

/** The width of the view box of the map. The core simplifies the basemap for this view box. */
export const MAP_WIDTH = MAP_VIEW.width;
/** The height of the view box of the map. */
export const MAP_HEIGHT = MAP_VIEW.height;
/** The space between the shapes and the edge of the view box. */
const PAD = MAP_VIEW.pad;

/**
 * The length of one degree of a great circle in km: π × 6371.0088 / 180, from the mean radius of the Earth.
 * `EARTH_MEAN_RADIUS_KM` of `@mark1russell7/geo` replaces this constant when geo is on npm.
 */
const KM_PER_DEGREE = 111.195;

/** The radius of the pad circle around each pin. Thus the fit does not zoom in on one point. */
const PIN_PAD_KM = 20;

/** An element of the SVG of the map, as data. */
export interface MapNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string | number>>;
  readonly children: readonly (MapNode | string)[];
  /** The anchor of the incident that a click on the element selects. */
  readonly select?: string;
}

/** The options of the map. */
export interface MapOptions {
  /** The regions under the view: the zones and the counties of each watched state. */
  readonly basemap?: readonly MapRegion[];
  /** The anchor of the selected incident. The other incidents are dim. */
  readonly selected?: string;
  /** The function that selects an incident. Without it, the incidents do not take clicks. */
  readonly select?: (anchor: string) => void;
}

const node = (tag: string, attrs: MapNode["attrs"], ...children: (MapNode | string)[]): MapNode => ({ tag, attrs, children });

/** This function gives a circle on the ground as a polygon of d3-geo. */
function groundCircle(center: Position, radiusKm: number): GeoGeometryObjects {
  return geoCircle()
    .center([center[0], center[1]])
    .radius(radiusKm / KM_PER_DEGREE)();
}

/**
 * This function gives a shape as a geometry of d3-geo. The outside ring of a polygon of d3-geo goes clockwise. A ring
 * in the other order makes the polygon the complement: the full globe less the shape. GeoJSON (RFC 7946) uses the
 * other order. Thus a polygon with an area above a half sphere (2π) gets each ring in the reverse order.
 */
export function geometryOf(shape: MapShape): GeoGeometryObjects {
  if (shape.type === "circle") return groundCircle(shape.center, shape.radiusKm);
  const rings = shape.rings.map((ring) => ring.map((point) => [point[0], point[1]]));
  const polygon: GeoGeometryObjects = { type: "Polygon", coordinates: rings };
  return geoArea(polygon) > 2 * Math.PI ? { type: "Polygon", coordinates: rings.map((ring) => [...ring].reverse()) } : polygon;
}

const collection = (geometries: GeoGeometryObjects[]): ExtendedGeometryCollection => ({ type: "GeometryCollection", geometries });

/** This function gives the classes of an incident: its level, and `selected` or `dim` when an incident is selected. */
function incidentClass(incident: MapIncident, selected: string | undefined): string {
  const state = selected === undefined ? "" : selected === incident.anchor ? " selected" : " dim";
  return `incident level-${incident.level}${state}`;
}

/** This function gives the words of a place for a reader of the screen: its label, its level and its gaps. */
function placeTitle(place: MapPlace): string {
  const gaps = place.gaps.map(kindLabel).join(", ");
  return `${place.label}: ${LEVEL_WORDS[place.level]}.${gaps === "" ? "" : ` The coverage is short for: ${gaps}.`}`;
}

/** This function gives the words of a region of the basemap: its name and its code, for example `Center (KSZ083)`. */
export function regionTitle(region: MapRegion): string {
  return `${region.name} (${region.code.code})`;
}

/**
 * This function gives the SVG of the map as data. The projection fits each shape of the view and of each region of the
 * basemap, and a pad circle around each pin. The incidents go from the lowest level up, so the highest level is on top.
 */
export function mapNodes(view: MapView, options: Omit<MapOptions, "select"> & { readonly selectable?: boolean } = {}): MapNode {
  const basemap = options.basemap ?? [];
  const pinned = view.places.flatMap((place) => (place.at === undefined ? [] : [{ place, at: place.at }]));
  const outlined = view.places.filter((place) => place.at === undefined && place.shapes.length > 0);
  const fitted = [
    ...basemap.flatMap((region) => region.shapes.map(geometryOf)),
    ...view.incidents.flatMap((incident) => incident.shapes.map(geometryOf)),
    ...outlined.flatMap((place) => place.shapes.map(geometryOf)),
    ...pinned.map((pin) => groundCircle(pin.at, PIN_PAD_KM)),
  ];
  const summary = `A map of the live incidents and the watched places. Live incidents: ${String(view.incidents.length)}. Watched places: ${String(view.places.length)}.`;
  const root = { viewBox: `0 0 ${String(MAP_WIDTH)} ${String(MAP_HEIGHT)}`, class: "map live-map", role: options.selectable === true ? "group" : "img", "aria-label": summary };
  if (fitted.length === 0) {
    return node("svg", root, node("text", { class: "map-empty", x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }, "No shape to draw."));
  }

  const projection = geoMercator().fitExtent(
    [
      [PAD, PAD],
      [MAP_WIDTH - PAD, MAP_HEIGHT - PAD],
    ],
    collection(fitted),
  );
  const path: GeoPath = geoPath(projection).digits(1);
  const paths = (shapes: readonly MapShape[], className: string): MapNode[] =>
    shapes.flatMap((shape) => {
      const d = path(geometryOf(shape));
      return d === null ? [] : [node("path", { class: className, d })];
    });
  const round = (value: number): number => Math.round(value * 10) / 10;

  // Each region is a group with a title, so a hover on its shapes names the region.
  const regions = basemap.map((region) => node("g", { class: "region", "data-code": region.code.code }, node("title", {}, regionTitle(region)), ...paths(region.shapes, "zone")));
  const children: MapNode[] = [node("g", { class: "basemap" }, ...regions)];
  for (const incident of [...view.incidents].reverse()) {
    const group = node(
      "g",
      {
        class: incidentClass(incident, options.selected),
        "data-anchor": incident.anchor,
        ...(options.selectable === true ? { tabindex: 0, role: "button", "aria-label": `${incident.kind.label}, ${LEVEL_WORDS[incident.level]}` } : {}),
      },
      node("title", {}, `${incident.kind.label}: ${LEVEL_WORDS[incident.level]}`),
      ...paths(incident.shapes, "area"),
    );
    children.push(options.selectable === true ? { ...group, select: incident.anchor } : group);
  }

  const labels: MapNode[] = [];
  for (const place of outlined) {
    children.push(node("g", { class: `place level-${place.level}`, "data-place": place.id }, node("title", {}, placeTitle(place)), ...paths(place.shapes, "outline")));
    const [x, y] = path.centroid(collection(place.shapes.map(geometryOf)));
    if (Number.isFinite(x) && Number.isFinite(y)) labels.push(node("text", { class: "place-label outlined", x: round(x), y: round(y) }, place.label));
  }
  for (const { place, at: position } of pinned) {
    const at = projection([position[0], position[1]]);
    if (at === null) continue;
    const [x, y] = [round(at[0]), round(at[1])];
    // A label near the right edge goes on the left of its pin, so it stays in the view box.
    const left = x > MAP_WIDTH * 0.7;
    if (place.gaps.length > 0) children.push(node("circle", { class: "gap short", "data-place": place.id, cx: x, cy: y, r: 30 }));
    children.push(node("g", { class: `pin level-${place.level}`, "data-place": place.id, transform: `translate(${String(x)},${String(y)})` }, node("title", {}, placeTitle(place)), node("circle", { r: 12 })));
    labels.push(node("text", { class: left ? "place-label left" : "place-label", x: left ? x - 20 : x + 20, y: y + 8 }, place.label));
  }
  return node("svg", root, ...children, ...labels);
}

/** This function makes the SVG element of map data, with a click and a key handler on each element to select. */
function build(data: MapNode, select: ((anchor: string) => void) | undefined): SVGElement {
  const element = s(data.tag, data.attrs, ...data.children.map((child) => (typeof child === "string" ? child : build(child, select))));
  const anchor = data.select;
  if (anchor !== undefined && select !== undefined) {
    element.addEventListener("click", () => select(anchor));
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      select(anchor);
    });
  }
  return element;
}

/** This function draws the map of a view. An incident takes clicks when `options.select` is given. */
export function drawMapView(view: MapView, options: MapOptions = {}): SVGElement {
  const data = mapNodes(view, {
    ...(options.basemap === undefined ? {} : { basemap: options.basemap }),
    ...(options.selected === undefined ? {} : { selected: options.selected }),
    selectable: options.select !== undefined,
  });
  return build(data, options.select);
}

/**
 * This function draws the list of the region codes with no shape. The map does not show them, so the list tells the
 * reader of each one. When each code has a shape, the function gives nothing.
 */
export function drawUnshaped(view: MapView): HTMLElement | null {
  if (view.unshaped.length === 0) return null;
  return h(
    "div",
    { class: "unshaped" },
    h("p", { class: "hint" }, "The map has no shape for these region codes of live incidents:"),
    h("ul", { class: "codes" }, ...view.unshaped.map((code) => h("li", {}, h("code", {}, code.code), " ", h("span", { class: "code-system" }, code.system.toUpperCase())))),
  );
}

/** This function writes a time of an incident in the local time of the reader, for example `Nov 15, 06:30 PM`. */
function localTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** This function gives the facts of an incident for its line in the list: the severity, the end and the places. */
export function incidentFacts(incident: MapIncident, view: MapView, time: (at: number) => string = localTime): string {
  const labels = incident.places.map((id) => view.places.find((place) => place.id === id)?.label ?? id);
  const end = incident.expires === undefined ? "No end time." : `Ends ${time(incident.expires)}.`;
  const places = labels.length === 0 ? "No watched place." : `Places: ${labels.join(", ")}.`;
  return `Severity ${incident.severity}. ${end} ${places}`;
}

/** This function draws the list of the incidents, in the order of the view. A click on an incident selects it. */
export function drawIncidentList(view: MapView, selected: string | undefined, select: (anchor: string) => void): HTMLElement {
  const list = h("div", { class: "incidents" });
  if (view.incidents.length === 0) list.append(h("p", { class: "empty" }, "No live incident."));
  for (const incident of view.incidents) {
    const chosen = selected === incident.anchor;
    const card = h(
      "article",
      { class: `incident-card${chosen ? " selected" : ""}`, "data-anchor": incident.anchor, tabindex: 0, "aria-current": chosen ? "true" : null },
      h("header", {}, h("h4", {}, incident.kind.label), levelChip(incident.level)),
      h("p", { class: "facts" }, incidentFacts(incident, view)),
    );
    card.addEventListener("click", () => select(incident.anchor));
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      select(incident.anchor);
    });
    list.append(card);
  }
  return list;
}
