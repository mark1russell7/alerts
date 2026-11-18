/**
 * The made-up world of the demo: four zones, two counties, two people, two sources and six messages.
 * No real office, place or person is in it. No real zone or county has these codes. The zones are
 * `XXZ001` and up, the counties are `XXC001` and up, and the SAME codes have the state `99`.
 */

import {
  SOURCE_SUBJECT,
  type Area,
  type FetchRecord,
  type Instant,
  type PersonId,
  type PersonWatch,
  type PlaceId,
  type Position,
  type RegionCode,
  type SourceDescriptor,
  type SourceId,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { NWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nws-api";
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

/**
 * The two people. Person A also watches the sources of the system, so only A gets their health
 * reports. Person B has a rule: a wind message at home reaches `notice` at most.
 */
export const PEOPLE: readonly PersonWatch[] = [
  { person: "person-a" as PersonId, places: ["home-a" as PlaceId], subjects: [{ system: SOURCE_SUBJECT }], rules: [] },
  {
    person: "person-b" as PersonId,
    places: ["home-b" as PlaceId],
    rules: [{ places: ["home-b" as PlaceId], kinds: ["met.wind"], max: "notice" }],
  },
];

// A time of the made-up day. `Date.parse` reads a fixed text here: the replay reads no clock.
const at = (time: string): Instant => Date.parse(`2026-05-04T${time}:00Z`);

/** The names of the people and places in the sentences of the page. */
export const NAMES: Readonly<Record<string, string>> = {
  "person-a": "Person A",
  "person-b": "Person B",
  "home-a": "the home of A, in the Valley",
  "home-b": "the home of B, in the Harbor",
};

/** The short names of the homes and the sources, for the lists of the page. */
export const SHORT_NAMES: Readonly<Record<string, string>> = {
  "home-a": "Home of A",
  "home-b": "Home of B",
  "nws-api": "NWS API",
  "radio-x": "Weather radio",
};

/** The areas of the two sources: the two made-up counties. */
const REGION: readonly Area[] = COUNTIES.map((county) => ({ type: "code", system: "ugc", code: county.code }));

/**
 * The NWS API source of the demo. It is the descriptor of the NWS source package with one change.
 * Its coverage names the made-up counties in place of the real countries of the NWS.
 */
export const API: SourceDescriptor = { ...NWS_DESCRIPTOR, coverage: REGION };

/**
 * The second source of the demo: a made-up weather radio. It needs a transmitter and not the
 * internet. So the two sources share no outside domain, and one fault cannot stop both. The demo
 * shows no message of the radio.
 */
export const RADIO: SourceDescriptor = {
  id: "radio-x" as SourceId,
  title: "The weather radio of the region",
  origins: ["nws"],
  dependsOn: ["rf:x-transmitter"],
  uses: ["receiver", "power"],
  kinds: ["met"],
  coverage: REGION,
  transport: "radio",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
};

/** The two sources, in the order of the views. */
export const SOURCES: readonly SourceDescriptor[] = [API, RADIO];

/**
 * The kinds that the coverage examines at each home. A flash flood is a life-safety kind, so it
 * needs 2 independent sources. Wind needs 1.
 */
export const COVERAGE_KINDS: readonly string[] = ["met.flood.flash", "met.wind"];

/** One step of the replay: a time, and the message that arrives at that time, if any. */
export interface Step {
  readonly at: Instant;
  readonly title: string;
  /** What happens in this step, in one or two sentences. */
  readonly story: string;
  /** The name of the fixture file and its text, exactly as the source gives it. */
  readonly message?: { readonly name: string; readonly body: string };
}

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
    at: at("13:15"),
    title: "The API stops",
    story:
      "From 13:08, each fetch of the NWS API times out. After two failures in a row, its health is failing. A flash flood needs 2 independent sources, and only the radio is up. So the core makes system reports, and each person gets urgent for the home.",
  },
  {
    at: at("13:25"),
    title: "The API is back",
    story:
      "The fetches of the NWS API pass again from 13:24, so its health is healthy. The flood has 2 independent sources again, and the core cancels the coverage reports. The health report of the API stays open for 15 minutes of good fetches. Thus a source that flaps makes one incident.",
  },
  {
    at: at("13:40"),
    title: "A test message",
    story: "A monthly test arrives. The policy sends only actual messages, so the test reaches nobody. The NWS API is up for 16 minutes, so the core cancels its health report.",
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

/** The time of the first fetch of each source. The health of each source starts at this time. */
export const FIRST_FETCH: Instant = at("11:50");

/** The outage of the NWS API. Each fetch of the API that starts at `from` or later, and before `to`, fails. */
export const OUTAGE: { readonly from: Instant; readonly to: Instant } = { from: at("13:08"), to: at("13:24") };

/**
 * The fetch log of the two sources: one fetch of each source at each minute, to the last step. In
 * the outage, each fetch of the API times out after 10 s. A fetch that brings the message of a
 * step has one fresh observation.
 */
export const FETCHES: readonly FetchRecord[] = fetchLog();

function fetchLog(): FetchRecord[] {
  const records: FetchRecord[] = [];
  const last = STEPS[STEPS.length - 1]!.at;
  const messages = new Set(STEPS.flatMap((step) => (step.message === undefined ? [] : [step.at])));
  for (let minute = FIRST_FETCH; minute <= last; minute += 60_000) {
    if (minute >= OUTAGE.from && minute < OUTAGE.to) {
      records.push({ source: API.id, at: minute, took: 10_000, failure: { kind: "timeout", message: "No answer in 10 s." }, fresh: 0, fatal: 0 });
    } else {
      records.push({ source: API.id, at: minute, took: 400, fresh: messages.has(minute) ? 1 : 0, fatal: 0 });
    }
    records.push({ source: RADIO.id, at: minute, took: 200, fresh: 0, fatal: 0 });
  }
  return records;
}
