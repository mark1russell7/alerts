/**
 * A made-up map payload and its history for the tests and the screenshots of the local page. The labels and the names are made up.
 * The codes KSZ083, KSC173 and 020173 are public Kansas codes. The other zone codes are made up. The shapes are
 * rough boxes, not the real outlines.
 */

import { HISTORY_FORMAT, MAP_FORMAT, type HistoryChange, type HistoryPayload, type MapIncident, type MapPayload, type MapRegion, type MapShape, type PlaceId, type Position, type ReportId } from "@mark1russell7/alerts";

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
export const ANCHORS = { tornado: anchor("a"), flood: anchor("b"), wind: anchor("c"), statement: anchor("d"), air: anchor("e"), storm: anchor("f"), fog: anchor("g") } as const;

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
  format: MAP_FORMAT,
  at: Date.parse("2026-11-15T21:00:00Z"),
  basemap: BASEMAP,
  view: {
    incidents: [
      {
        anchor: ANCHORS.tornado,
        status: "actual",
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
        status: "actual",
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
        status: "actual",
        kind: { code: "met.wind", label: "Wind advisory" },
        level: "notice",
        severity: "moderate",
        shapes: [{ type: "circle", center: [-98.1, 37.95], radiusKm: 25 }],
        unshaped: [],
        places: [],
      },
      {
        anchor: ANCHORS.statement,
        status: "actual",
        kind: { code: "met.special", label: "Special weather statement" },
        level: "digest",
        severity: "minor",
        shapes: [NORTH],
        unshaped: [],
        places: [CABIN],
      },
      {
        anchor: ANCHORS.air,
        status: "actual",
        kind: { code: "env.air-quality", label: "Air quality alert" },
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
export const EMPTY_FIXTURE: MapPayload = { format: MAP_FORMAT, at: null, basemap: [], view: { incidents: [], places: [], unshaped: [] } };

/** The time of the map payload, and of its history. */
const PRESENT = Date.parse("2026-11-15T21:00:00Z");
/** This function gives a time of the day of the fixture, from a clock time in UTC. */
const utc = (clock: string): number => Date.parse(`2026-11-15T${clock}:00Z`);
const live = (name: keyof typeof ANCHORS): MapIncident => {
  const found = MAP_FIXTURE.view.incidents.find((incident) => incident.anchor === ANCHORS[name]);
  if (found === undefined) throw new Error(`The map fixture has no incident ${name}.`);
  return found;
};

/** This function gives a change of the history. With no other field, the incident is live and has no area. */
function change(clock: string, level: HistoryChange["level"], severity: HistoryChange["severity"], fields: Partial<HistoryChange> = {}): HistoryChange {
  return { at: utc(clock), reports: [], level, severity, live: true, codes: [], shapes: [], unshaped: [], ...fields };
}

/**
 * The history of the map payload, as one answer to a read of the whole history. The last change of each incident of
 * the map has the level, the severity and the areas of the map. The history also has two incidents that left the map:
 * a storm with an end mark, and a fog advisory that expired. The fog advisory is the oldest change, at 15:00 UTC.
 */
export const HISTORY_FIXTURE: HistoryPayload = {
  format: HISTORY_FORMAT,
  at: PRESENT,
  since: null,
  next: utc("19:45"),
  incidents: [
    {
      anchor: ANCHORS.tornado,
      reports: [ANCHORS.tornado],
      status: "actual",
      kind: live("tornado").kind,
      changes: [
        // The first polygon is smaller, and the level is lower. The next report makes the warning larger.
        change("19:20", "urgent", "severe", { expires: utc("20:30"), shapes: [box(-97.52, 37.56, -97.4, 37.66)] }),
        change("19:45", "life-safety", "extreme", { expires: utc("23:30"), shapes: live("tornado").shapes }),
      ],
    },
    {
      anchor: ANCHORS.flood,
      reports: [ANCHORS.flood],
      status: "actual",
      kind: live("flood").kind,
      changes: [change("18:05", "urgent", "severe", { expires: Date.parse("2026-11-16T03:00:00Z"), codes: [{ system: "ugc", code: "KSC173" }] })],
    },
    {
      anchor: ANCHORS.wind,
      reports: [ANCHORS.wind],
      status: "actual",
      kind: live("wind").kind,
      changes: [change("16:10", "notice", "moderate", { shapes: live("wind").shapes })],
    },
    {
      anchor: ANCHORS.statement,
      reports: [ANCHORS.statement],
      status: "actual",
      kind: live("statement").kind,
      changes: [change("17:30", "digest", "minor", { codes: [{ system: "ugc", code: "KSZ990" }] })],
    },
    {
      anchor: ANCHORS.air,
      reports: [ANCHORS.air],
      status: "actual",
      kind: live("air").kind,
      changes: [change("18:40", "none", "unknown", { unshaped: [{ system: "same", code: "020173" }] })],
    },
    {
      anchor: ANCHORS.storm,
      reports: [ANCHORS.storm],
      status: "actual",
      kind: { code: "met.thunderstorm", label: "Severe thunderstorm warning" },
      changes: [
        change("16:40", "urgent", "severe", { expires: utc("17:45"), codes: [{ system: "ugc", code: "KSZ991" }] }),
        // The source ends the warning before its expiry. The change has no new report.
        change("17:25", "urgent", "severe", { live: false, expires: utc("17:45"), codes: [{ system: "ugc", code: "KSZ991" }] }),
      ],
    },
    {
      anchor: ANCHORS.fog,
      reports: [ANCHORS.fog],
      status: "actual",
      kind: { code: "met.fog", label: "Dense fog advisory" },
      // No report ends the advisory. It leaves the map at its expiry.
      changes: [change("15:00", "notice", "minor", { expires: utc("16:00"), codes: [{ system: "ugc", code: "KSZ083" }] })],
    },
  ],
  regions: [
    { code: { system: "ugc", code: "KSC173" }, shapes: [COUNTY] },
    { code: { system: "ugc", code: "KSZ083" }, shapes: [ZONE] },
    { code: { system: "ugc", code: "KSZ990" }, shapes: [NORTH] },
    { code: { system: "ugc", code: "KSZ991" }, shapes: BASEMAP[2]?.shapes ?? [] },
  ],
};
