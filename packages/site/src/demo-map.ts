/**
 * The map of the demo. The function `frameMap` gives the map payload of one frame of the replay. It uses `mapPayload`
 * of the core: the function of the map route of the runtime. Thus the demo and the local page draw one format with
 * one renderer. The shapes and the names come from the made-up world of `demo.ts`.
 */

import { mapPayload, type Incident, type MapPayload, type MapPlaceInput, type MapRegion, type MapShape, type RegionCode, type ShapeLookup } from "@mark1russell7/alerts";
import { COUNTIES, PEOPLE, PLACES, SHORT_NAMES, ZONES, type Zone } from "./demo.ts";
import type { Frame } from "./replay.ts";

/** This function gives the zones of a region code: the zone of a zone code, or each zone of a county. A county has a UGC code and a SAME code. */
export function zonesOfCode(code: RegionCode): Zone[] {
  return ZONES.filter((zone) => {
    if (code.system === "ugc") return zone.code === code.code || zone.county === code.code;
    return code.system === "same" && COUNTIES.some((county) => county.code === zone.county && county.same === code.code);
  });
}

/** This function gives the zones that the code areas of an incident cover, in the sequence of `ZONES`. */
export function zonesOf(incident: Pick<Incident, "areas">): Zone[] {
  const covered = new Set(incident.areas.flatMap((area) => (area.type === "code" ? zonesOfCode(area) : [])));
  return ZONES.filter((zone) => covered.has(zone));
}

/** The shape of each zone, by the code of the zone: one polygon. Each ring closes on its first position, as the core tells. */
const SHAPES: ReadonlyMap<string, MapShape> = new Map(
  ZONES.map((zone): [string, MapShape] => {
    const [first, ...rest] = zone.ring;
    return [zone.code, { type: "polygon", rings: first === undefined ? [] : [[first, ...rest, first]] }];
  }),
);

/** This function gives the shapes of a region code of the made-up world. A code of a different world has no shape. */
export const demoShape: ShapeLookup = (code) => {
  const shapes = zonesOfCode(code).flatMap((zone) => SHAPES.get(zone.code) ?? []);
  return shapes.length === 0 ? undefined : shapes;
};

/** The regions under the map of the demo: the four zones, each with its name. */
export const DEMO_BASEMAP: readonly MapRegion[] = ZONES.map((zone) => ({
  code: { system: "ugc", code: zone.code },
  name: zone.name,
  shapes: demoShape({ system: "ugc", code: zone.code }) ?? [],
}));

/** The watched places of the map: the two homes, each with its short name. */
export const DEMO_PLACES: readonly MapPlaceInput[] = PLACES.map((place) => ({ ...place, label: SHORT_NAMES[place.id] ?? place.id }));

/**
 * This function gives the map payload of a frame of the replay, at the time of its step. The incidents are the
 * incidents of the source and of the system reports, as the runtime gives them to its map route. A short coverage
 * of the frame is a gap at its home.
 */
export function frameMap(frame: Frame): MapPayload {
  return mapPayload({
    at: frame.step.at,
    incidents: [...frame.incidents, ...frame.sources.incidents],
    coverage: frame.sources.coverage,
    people: PEOPLE,
    places: DEMO_PLACES,
    basemap: DEMO_BASEMAP,
    shape: demoShape,
  });
}
