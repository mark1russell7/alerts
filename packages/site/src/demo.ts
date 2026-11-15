/**
 * The made-up world of the demo: four zones, two counties, two people and six messages. No real
 * office, place or person is in it. No real zone or county has these codes. The zones are `XXZ001`
 * and up, the counties are `XXC001` and up, and the SAME codes have the state `99`.
 */

import type { Instant, PersonId, PersonWatch, PlaceId, Position, RegionCode, WatchedPlace } from "@mark1russell7/alerts";
import wind from "../fixtures/1-wind-warning.json?raw";
import flood from "../fixtures/2-flood-warning.json?raw";
import backup from "../fixtures/3-backup-office.json?raw";
import grows from "../fixtures/4-flood-grows.json?raw";
import test from "../fixtures/5-test-message.json?raw";
import cancel from "../fixtures/6-flood-cancel.json?raw";

/** A zone of the made-up region, with its shape for the map. */
export interface Zone {
  readonly code: string;
  readonly name: string;
  /** The county of the zone. */
  readonly county: string;
  /** The outer ring of the zone, as `[lon, lat]` pairs. */
  readonly ring: readonly Position[];
}

/** A county of the made-up region. */
export interface County {
  readonly code: string;
  readonly same: string;
  readonly name: string;
}

/** The two counties. */
export const COUNTIES: readonly County[] = [
  { code: "XXC001", same: "099001", name: "East County" },
  { code: "XXC002", same: "099002", name: "West County" },
];

/** The four zones. The region is near the point `0, 0`, so it is at sea, far from each real place. */
export const ZONES: readonly Zone[] = [
  { code: "XXZ001", name: "Lake Shore", county: "XXC001", ring: [[0.5, 0.6], [1, 0.6], [1, 0.32], [0.55, 0.3]] },
  { code: "XXZ002", name: "Harbor", county: "XXC001", ring: [[0.55, 0.3], [1, 0.32], [1, 0], [0.5, 0]] },
  { code: "XXZ003", name: "Valley", county: "XXC002", ring: [[0, 0.28], [0.55, 0.3], [0.5, 0], [0, 0]] },
  { code: "XXZ004", name: "Ridge", county: "XXC002", ring: [[0, 0.6], [0.5, 0.6], [0.55, 0.3], [0, 0.28]] },
];

/** The river of the map, from the ridge to the sea. The map only draws it. */
export const RIVER: readonly Position[] = [
  [0.14, 0.56],
  [0.24, 0.4],
  [0.32, 0.26],
  [0.42, 0.13],
  [0.58, 0.09],
  [0.74, 0.06],
  [0.9, 0.0],
];

const codes = (zone: string, county: County): RegionCode[] => [
  { system: "ugc", code: zone },
  { system: "ugc", code: county.code },
  { system: "same", code: county.same },
];

/** The two watched places. Each holds the codes of its zone and its county. */
export const PLACES: readonly WatchedPlace[] = [
  { id: "home-a" as PlaceId, at: [0.38, 0.14], codes: codes("XXZ003", COUNTIES[1]!), bufferKm: 0 },
  { id: "home-b" as PlaceId, at: [0.72, 0.08], codes: codes("XXZ002", COUNTIES[0]!), bufferKm: 0 },
];

/** The two people. Person B has a rule: a wind message at home reaches `notice` at most. */
export const PEOPLE: readonly PersonWatch[] = [
  { person: "person-a" as PersonId, places: ["home-a" as PlaceId], rules: [] },
  {
    person: "person-b" as PersonId,
    places: ["home-b" as PlaceId],
    rules: [{ places: ["home-b" as PlaceId], kinds: ["met.wind"], max: "notice" }],
  },
];

/** The names of the people and places on the page. */
export const NAMES: Readonly<Record<string, string>> = {
  "person-a": "Person A",
  "person-b": "Person B",
  "home-a": "the home of A, in the Valley",
  "home-b": "the home of B, in the Harbor",
};

/** One step of the replay: a time, and the message that arrives at that time, if any. */
export interface Step {
  readonly at: Instant;
  readonly title: string;
  /** What happens in this step, in one or two sentences. */
  readonly story: string;
  /** The name of the fixture file and its text, exactly as the source gives it. */
  readonly message?: { readonly name: string; readonly body: string };
}

const at = (time: string): Instant => Date.parse(`2026-05-04T${time}:00Z`);

/** The steps of the replay, in the order of time. */
export const STEPS: readonly Step[] = [
  {
    at: at("11:55"),
    title: "Before the storm",
    story: "No message is in. The core has no incidents, and nobody gets a level.",
  },
  {
    at: at("12:00"),
    title: "A wind warning",
    story: "The Lake office sends a High Wind Warning for the Lake Shore and the Harbor. The rule of Person B keeps a wind message at notice.",
    message: { name: "1-wind-warning.json", body: wind },
  },
  {
    at: at("12:20"),
    title: "A flash flood",
    story: "The Lake office sends a Flash Flood Warning for West County. The home of Person A is in it, so the level is life-safety.",
    message: { name: "2-flood-warning.json", body: flood },
  },
  {
    at: at("12:35"),
    title: "A backup office",
    story: "The Hill office sends a message for the same flood, with no reference. The two messages have one VTEC key, so the core joins them.",
    message: { name: "3-backup-office.json", body: backup },
  },
  {
    at: at("13:05"),
    title: "The flood grows",
    story: "An update extends the flood warning to East County. The home of Person B is in it now.",
    message: { name: "4-flood-grows.json", body: grows },
  },
  {
    at: at("13:30"),
    title: "A test message",
    story: "A monthly test arrives. The policy sends only actual messages, so the test reaches nobody.",
    message: { name: "5-test-message.json", body: test },
  },
  {
    at: at("14:40"),
    title: "The all clear",
    story: "The Lake office cancels the flood warning. The cancel names each earlier message, so the incident ends.",
    message: { name: "6-flood-cancel.json", body: cancel },
  },
  {
    at: at("18:30"),
    title: "The wind stops",
    story: "No message arrives. The wind warning expired at 18:00, so the incident ends. The core reads the time only from the step.",
  },
];
