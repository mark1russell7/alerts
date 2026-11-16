import { ASSESSED_LEVELS, type MapView, type PlaceId } from "@mark1russell7/alerts";
import { geoArea } from "d3-geo";
import { describe, expect, it } from "vitest";
import { drawUnshaped, geometryOf, incidentFacts, MAP_HEIGHT, MAP_WIDTH, mapNodes, regionTitle, type MapNode } from "./map-view.ts";
import { ANCHORS, box, EMPTY_FIXTURE, MAP_FIXTURE } from "./map-view.fixture.ts";

/** This function gives each node of the tree, depth first. */
const all = (root: MapNode): MapNode[] => [root, ...root.children.flatMap((child) => (typeof child === "string" ? [] : all(child)))];
const byClass = (root: MapNode, name: string): MapNode[] => all(root).filter((one) => String(one.attrs["class"] ?? "").split(" ").includes(name));
const classOf = (one: MapNode): string => String(one.attrs["class"]);

/** This function gives each point of the paths, the circles and the pins of the map, in the units of the view box. */
function points(root: MapNode): [number, number][] {
  const found: [number, number][] = [];
  for (const one of all(root)) {
    if (one.tag === "path") {
      const numbers = String(one.attrs["d"]).match(/-?\d+(\.\d+)?(e-?\d+)?/g)?.map(Number) ?? [];
      for (let at = 0; at + 1 < numbers.length; at += 2) found.push([numbers[at] ?? Number.NaN, numbers[at + 1] ?? Number.NaN]);
    }
    const move = /translate\((-?[\d.]+),(-?[\d.]+)\)/.exec(String(one.attrs["transform"] ?? ""));
    if (move !== null) found.push([Number(move[1]), Number(move[2])]);
    if (one.tag === "text") found.push([Number(one.attrs["x"]), Number(one.attrs["y"])]);
  }
  return found;
}

const inside = ([x, y]: [number, number]): boolean => x >= 0 && x <= MAP_WIDTH && y >= 0 && y <= MAP_HEIGHT;

describe("the fit of the map", () => {
  it("puts each shape, pin and label inside the view box", () => {
    const map = mapNodes(MAP_FIXTURE.view, { basemap: MAP_FIXTURE.basemap });
    const found = points(map);
    expect(found.length).toBeGreaterThan(100);
    expect(found.filter((point) => !inside(point))).toEqual([]);
    // The fit uses the box: the shapes reach near two opposite edges.
    const xs = found.map(([x]) => x);
    const ys = found.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs) > MAP_WIDTH * 0.8 || Math.max(...ys) - Math.min(...ys) > MAP_HEIGHT * 0.8).toBe(true);
  });

  it("draws a polygon in either ring order as its small side", () => {
    const counter = geoArea(geometryOf(box(-97.81, 37.47, -97.15, 37.82)));
    const clockwise = geoArea(geometryOf(box(-97.81, 37.47, -97.15, 37.82, true)));
    expect(counter).toBeLessThan(0.001);
    expect(clockwise).toBeCloseTo(counter, 12);
    for (const shape of [box(-97.81, 37.47, -97.15, 37.82), box(-97.81, 37.47, -97.15, 37.82, true)]) {
      const map = mapNodes({ incidents: [], places: [], unshaped: [] }, { basemap: [{ code: { system: "ugc", code: "KSZ083" }, name: "Box", shapes: [shape] }] });
      const found = points(map);
      expect(found.length).toBeGreaterThan(3);
      expect(found.filter((point) => !inside(point))).toEqual([]);
      // The box fills the width or the height of the view, not one dot of a globe.
      const xs = found.map(([x]) => x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(MAP_WIDTH / 2);
    }
  });

  it("fits one pin alone with its pad circle, with no infinite scale", () => {
    const view: MapView = { incidents: [], places: [{ id: "place:x" as PlaceId, label: "Barn", at: [-97.4, 37.6], shapes: [], level: "none", incidents: [], gaps: [] }], unshaped: [] };
    const map = mapNodes(view);
    const found = points(map);
    expect(found.length).toBe(2);
    expect(found.every((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]) && inside(point))).toBe(true);
    // The pad circle is round on the ground, so the pin is near the middle of the view box.
    const [x, y] = found[0] ?? [0, 0];
    expect(Math.abs(x - MAP_WIDTH / 2)).toBeLessThan(1);
    expect(Math.abs(y - MAP_HEIGHT / 2)).toBeLessThan(MAP_HEIGHT / 50);
  });

  it("gives a text and no projection when nothing has a shape or a position", () => {
    const map = mapNodes(EMPTY_FIXTURE.view, { basemap: EMPTY_FIXTURE.basemap });
    expect(map.children).toEqual([{ tag: "text", attrs: { class: "map-empty", x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }, children: ["No shape to draw."] }]);
  });
});

describe("the classes of the map", () => {
  const map = mapNodes(MAP_FIXTURE.view, { basemap: MAP_FIXTURE.basemap });
  const incidents = byClass(map, "incident");

  it("gives each incident the class of its level, from the lowest level up", () => {
    expect(incidents.map(classOf)).toEqual([...ASSESSED_LEVELS].map((level) => `incident level-${level}`));
    expect(byClass(map, "zone")).toHaveLength(4);
    // The incident with no shape draws no area.
    const air = incidents.find((one) => one.attrs["data-anchor"] === ANCHORS.air);
    expect(air?.children.filter((child) => typeof child !== "string" && child.tag === "path")).toEqual([]);
  });

  it("draws each shape of each region as a zone, under a title with the name and the code of the region", () => {
    const regions = byClass(map, "region");
    expect(regions.map((one) => one.children[0])).toEqual([
      { tag: "title", attrs: {}, children: ["Center Plains (KSZ083)"] },
      { tag: "title", attrs: {}, children: ["North Plains (KSZ990)"] },
      { tag: "title", attrs: {}, children: ["Side Plains (KSZ991)"] },
    ]);
    expect(regions.map((one) => one.attrs["data-code"])).toEqual(["KSZ083", "KSZ990", "KSZ991"]);
    expect(regions.map((one) => byClass(one, "zone").length)).toEqual([1, 1, 2]);
    expect(MAP_FIXTURE.basemap.map(regionTitle)).toEqual(["Center Plains (KSZ083)", "North Plains (KSZ990)", "Side Plains (KSZ991)"]);
  });

  it("draws a pin for a place with a position, and an outline with its label for a place with only shapes", () => {
    expect(byClass(map, "pin").map(classOf)).toEqual(["pin level-life-safety", "pin level-urgent"]);
    expect(byClass(map, "place").map(classOf)).toEqual(["place level-digest"]);
    expect(byClass(map, "outline")).toHaveLength(1);
    expect(byClass(map, "place-label").map((one) => one.children[0])).toEqual(["Cabin", "Farm", "Shop"]);
    expect(byClass(map, "gap").map((one) => one.attrs["data-place"])).toEqual(["place:shop"]);
    const shop = byClass(map, "pin").find((one) => one.attrs["data-place"] === "place:shop");
    expect(shop?.children[0]).toEqual({ tag: "title", attrs: {}, children: ["Shop: Urgent. The coverage is short for: Flash flood."] });
  });

  it("names no region by default, and each region of the basemap with `regionNames`: above the incidents and below the places", () => {
    expect(byClass(map, "region-label")).toEqual([]);
    const named = mapNodes(MAP_FIXTURE.view, { basemap: MAP_FIXTURE.basemap, regionNames: true });
    const labels = byClass(named, "region-label");
    expect(labels.map((one) => one.children[0])).toEqual(MAP_FIXTURE.basemap.map((region) => region.name));
    for (const label of labels) expect(inside([Number(label.attrs["x"]), Number(label.attrs["y"])])).toBe(true);
    const order = named.children.flatMap((child) => (typeof child === "string" ? [] : [classOf(child).split(" ")[0]]));
    expect(order.lastIndexOf("incident")).toBeLessThan(order.indexOf("region-label"));
    expect(order.lastIndexOf("region-label")).toBeLessThan(order.indexOf("place"));
    // The names change no other part of the map.
    expect(named.children.filter((child) => typeof child === "string" || classOf(child) !== "region-label")).toEqual(map.children);
  });

  it("names no region with no name", () => {
    const basemap = MAP_FIXTURE.basemap.map((region, index) => (index === 0 ? { ...region, name: "" } : region));
    const labels = byClass(mapNodes(MAP_FIXTURE.view, { basemap, regionNames: true }), "region-label");
    expect(labels.map((one) => one.children[0])).toEqual(MAP_FIXTURE.basemap.slice(1).map((region) => region.name));
  });

  it("marks the selected incident and dims the others", () => {
    const chosen = byClass(mapNodes(MAP_FIXTURE.view, { selected: ANCHORS.flood }), "incident");
    expect(chosen.filter((one) => classOf(one).includes(" selected")).map((one) => one.attrs["data-anchor"])).toEqual([ANCHORS.flood]);
    expect(chosen.filter((one) => classOf(one).includes(" dim"))).toHaveLength(ASSESSED_LEVELS.length - 1);
    expect(incidents.some((one) => /selected|dim/.test(classOf(one)))).toBe(false);
  });

  it("makes the incidents selectable only when the page gives a select function", () => {
    expect(incidents.some((one) => one.select !== undefined || "tabindex" in one.attrs)).toBe(false);
    const selectable = byClass(mapNodes(MAP_FIXTURE.view, { selectable: true }), "incident");
    expect(selectable.map((one) => one.select)).toEqual(selectable.map((one) => one.attrs["data-anchor"]));
    expect(selectable.every((one) => one.attrs["tabindex"] === 0 && one.attrs["role"] === "button")).toBe(true);
  });
});

describe("the lists of the map", () => {
  it("gives no list of region codes when each code has a shape", () => {
    expect(drawUnshaped(EMPTY_FIXTURE.view)).toBeNull();
  });

  it("writes the severity, the end and the labels of the places of an incident", () => {
    const [tornado, flood, wind] = MAP_FIXTURE.view.incidents;
    if (tornado === undefined || flood === undefined || wind === undefined) throw new Error("the fixture has three incidents");
    const time = (at: number): string => new Date(at).toISOString().slice(11, 16);
    expect(incidentFacts(tornado, MAP_FIXTURE.view, time)).toBe("Severity extreme. Ends 23:30. Places: Farm.");
    expect(incidentFacts(flood, MAP_FIXTURE.view, time)).toBe("Severity severe. Ends 03:00. Places: Farm, Shop.");
    expect(incidentFacts(wind, MAP_FIXTURE.view, time)).toBe("Severity moderate. No end time. No watched place.");
  });
});
