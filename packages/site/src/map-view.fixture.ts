/**
 * A made-up map payload for the tests and the screenshots of the local page. The labels and the names are made up.
 * The codes KSZ083, KSC173 and 020173 are public Kansas codes. The other zone codes are made up. The shapes are
 * rough boxes, not the real outlines.
 */

import type { MapPayload, MapRegion, MapShape, PlaceId, Position, ReportId } from "@mark1russell7/alerts";

/** This function gives a box as a polygon. The ring goes counterclockwise (RFC 7946), or clockwise with `clockwise`. */
export function box(west: number, south: number, east: number, north: number, clockwise = false): MapShape {
  const ring: Position[] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  return { type: "polygon", rings: [clockwise ? ring.reverse() : ring] };
}

const anchor = (letter: string): ReportId => letter.padEnd(64, "0") as ReportId;
const FARM = "place:farm" as PlaceId;
const SHOP = "place:shop" as PlaceId;
const CABIN = "place:cabin" as PlaceId;

/** The anchors of the incidents of the fixture, by their kind. */
export const ANCHORS = { tornado: anchor("a"), flood: anchor("b"), wind: anchor("c"), statement: anchor("d"), air: anchor("e") } as const;

const ZONE = box(-97.81, 37.47, -97.15, 37.82);
const NORTH = box(-97.81, 37.82, -97.15, 38.17);
const zone = (code: string, name: string, ...shapes: MapShape[]): MapRegion => ({ code: { system: "ugc", code }, name, shapes });
// The zone KSZ083 and two made-up zones beside it. The side zone has two shapes, and one of them goes clockwise.
// Thus the basemap has a region of two shapes, and rings in both orders.
const BASEMAP: readonly MapRegion[] = [
  zone("KSZ083", "Center Plains", ZONE),
  zone("KSZ990", "North Plains", NORTH),
  zone("KSZ991", "Side Plains", box(-98.47, 37.47, -97.81, 37.82, true), box(-97.15, 37.47, -96.52, 37.82)),
];
// The county KSC173, a little larger than the zone.
const COUNTY = box(-97.83, 37.39, -97.13, 37.83);

/** The map payload: three regions, an incident at each level, three places and one region code with no shape. */
export const MAP_FIXTURE: MapPayload = {
  basemap: BASEMAP,
  view: {
    incidents: [
      {
        anchor: ANCHORS.tornado,
        kind: { code: "met.tornado", label: "Tornado warning" },
        level: "life-safety",
        severity: "extreme",
        expires: Date.parse("2026-11-15T23:30:00Z"),
        shapes: [
          {
            type: "polygon",
            rings: [
              [
                [-97.55, 37.55],
                [-97.3, 37.6],
                [-97.28, 37.72],
                [-97.52, 37.7],
                [-97.55, 37.55],
              ],
            ],
          },
        ],
        unshaped: [],
        places: [FARM],
      },
      {
        anchor: ANCHORS.flood,
        kind: { code: "met.flood.flash", label: "Flash flood warning" },
        level: "urgent",
        severity: "severe",
        expires: Date.parse("2026-11-16T03:00:00Z"),
        shapes: [COUNTY],
        unshaped: [],
        places: [FARM, SHOP],
      },
      {
        anchor: ANCHORS.wind,
        kind: { code: "met.wind", label: "Wind advisory" },
        level: "notice",
        severity: "moderate",
        shapes: [{ type: "circle", center: [-98.1, 37.95], radiusKm: 25 }],
        unshaped: [],
        places: [],
      },
      {
        anchor: ANCHORS.statement,
        kind: { code: "met.statement", label: "Special weather statement" },
        level: "digest",
        severity: "minor",
        shapes: [NORTH],
        unshaped: [],
        places: [CABIN],
      },
      {
        anchor: ANCHORS.air,
        kind: { code: "env.air", label: "Air quality alert" },
        level: "none",
        severity: "unknown",
        shapes: [],
        unshaped: [{ system: "same", code: "020173" }],
        places: [],
      },
    ],
    places: [
      { id: FARM, label: "Farm", at: [-97.42, 37.64], shapes: [ZONE], level: "life-safety", incidents: [ANCHORS.tornado, ANCHORS.flood], gaps: [] },
      { id: SHOP, label: "Shop", at: [-97.22, 37.52], shapes: [ZONE], level: "urgent", incidents: [ANCHORS.flood], gaps: ["met.flood.flash"] },
      { id: CABIN, label: "Cabin", shapes: [NORTH], level: "digest", incidents: [ANCHORS.statement], gaps: [] },
    ],
    unshaped: [{ system: "same", code: "020173" }],
  },
};

/** The map payload with no incident, no place and no basemap: the empty state of the page. */
export const EMPTY_FIXTURE: MapPayload = { basemap: [], view: { incidents: [], places: [], unshaped: [] } };
