import { readFileSync } from "node:fs";
import { incidents, kindLabel, knownKind, linesAt, matchPlaces, normalize, observationId, type Observation, type PlaceId, type Position, type Report, type WatchedPlace } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { entryBody } from "./fetch.ts";
import {
  ALERT_LIFE_MS,
  entryTime,
  GEOMAGNETIC_POLES,
  GEOMAGNETIC_STORM_KIND,
  kindOf,
  mapObservation,
  polarCaps,
  RADIO_BLACKOUT_KIND,
  SHORT_ALERT_LIFE_MS,
  SOLAR_RADIATION_STORM_KIND,
  SOURCE_ID,
  SPACE_WEATHER_KIND,
  SWPC_PAGE,
  SWPC_SENDER,
  WATCH_DAY_SYSTEM,
  WATCH_SYSTEM,
} from "./map.ts";
import { messageTime } from "./text.ts";

interface Entry {
  readonly product_id: string;
  readonly issue_datetime: string;
  readonly message: string;
}

/** The real list of 16 November 2026 and the real archive samples (`fixtures/README.md`). */
const LIVE = JSON.parse(readFileSync(new URL("../fixtures/alerts-20261116T1553Z.json", import.meta.url), "utf8")) as Entry[];
const SAMPLES = JSON.parse(readFileSync(new URL("../fixtures/archive-samples.json", import.meta.url), "utf8")) as { readonly file: string; readonly message: string }[];

const URL_OF_LIST = "https://services.swpc.noaa.gov/products/alerts.json";
const FETCHED = Date.parse("2026-11-16T15:53:30Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** This function gives the observation of one entry, as the fetch gives it. */
const observe = (entry: unknown, fetched = FETCHED): Observation => {
  const body = entryBody(entry);
  return { id: observationId({ source: SOURCE_ID, contentType: "application/json", url: URL_OF_LIST, body }), source: SOURCE_ID, fetched, contentType: "application/json", body, transport: { url: URL_OF_LIST, status: 200, latency: 0 } };
};

/** This function gives the entry of an archive sample. The archive has no list, so the issue time of the list is the issue time of the text. */
const sampleEntry = (message: string): Entry => {
  const issued = messageTime(/Issue Time: ([^\n]+)\n/.exec(message)![1]!)!;
  return { product_id: "", issue_datetime: new Date(issued).toISOString().replace("T", " ").replace("Z", ""), message };
};

const ENTRIES: readonly Entry[] = [...LIVE, ...SAMPLES.map((sample) => sampleEntry(sample.message))];

/** This function gives the real entry with a code and a serial number. The test fails if the fixtures do not have it. */
const entryOf = (code: string, serial: number): Entry => {
  const entry = ENTRIES.find((candidate) => new RegExp(`Code: ${code}\\r?\\nSerial Number: ${String(serial)}\\r?\\n`).test(candidate.message));
  if (entry === undefined) throw new Error(`no message ${code}/${String(serial)} in the fixtures`);
  return entry;
};

/** This function maps an entry, and fails the test for a problem. */
const reportsOf = (entry: Entry): readonly Report[] => {
  const result = mapObservation(observe(entry));
  expect(result.problems).toEqual([]);
  return result.reports;
};
const reportOf = (code: string, serial: number): Report => reportsOf(entryOf(code, serial))[0]!;

/** This function gives a place of the tests: a public city at its position, with no code. */
const city = (id: string, at: Position): WatchedPlace => ({ id: id as PlaceId, at, codes: [], bufferKm: 0 });
// The geomagnetic latitude of each city, from the dipole of WMM2025: 67.5, 58.1, 43.1 and 7.8 degrees.
const TROMSO = city("tromso", [18.96, 69.65]);
const EDINBURGH = city("edinburgh", [-3.19, 55.95]);
const MADRID = city("madrid", [-3.7, 40.42]);
const SINGAPORE = city("singapore", [103.82, 1.35]);
// The geomagnetic latitude of Hobart is 49.6 degrees, south of the equator.
const HOBART = city("hobart", [147.33, -42.88]);

/** This function gives the incidents at a time, from the reports sent at or before that time. */
const incidentsAt = (reports: readonly Report[], at: number) => incidents(normalize({ reports: reports.filter((report) => report.sent <= at) }), at);
const severitiesAt = (reports: readonly Report[], at: number, place: WatchedPlace): string[] => {
  const live = incidentsAt(reports, at).filter((incident) => incident.live && matchPlaces(incident, [place]).length > 0);
  return live.flatMap((incident) => (incident.lines === undefined ? [incident.severity] : linesAt(incident, place).map((line) => line.severity)));
};

describe("mapObservation over the real fixtures", () => {
  it("maps each real entry with no problem, to reports of known kinds from the NWS", () => {
    const reports = ENTRIES.flatMap((entry) => reportsOf(entry));
    expect(LIVE.flatMap((entry) => reportsOf(entry))).toHaveLength(89);
    for (const report of reports) {
      expect(knownKind(report.kind.code), report.kind.code).toBe(true);
      expect(report).toMatchObject({ source: SOURCE_ID, origin: "nws", status: "actual", sender: SWPC_SENDER, web: SWPC_PAGE });
      expect(report.kind.label).toBe(kindLabel(report.kind.code));
      expect(report.expires).toBeGreaterThanOrEqual(report.onset ?? report.sent);
    }
  });

  it("maps a K-index alert to an observation of a geomagnetic storm, with the two polar caps of its latitude", () => {
    const report = reportOf("ALTK05", 2062);
    expect(report).toMatchObject({
      key: "ALTK05/2062",
      references: [],
      correlation: [],
      op: "alert",
      kind: { code: GEOMAGNETIC_STORM_KIND, significance: "observation" },
      categories: ["geo"],
      severity: "minor",
      urgency: "immediate",
      certainty: "observed",
      // The sent time is the issue time of the list, with its seconds. The onset is the time of the text.
      onset: Date.parse("2026-11-08T02:03:00Z"),
      // The alert ends with its synoptic period, 0000-0300.
      expires: Date.parse("2026-11-08T03:00:00Z"),
      areaText: "Poleward of 60 degrees geomagnetic latitude",
      headline: "ALERT: Geomagnetic K-index of 5",
      parameters: { code: ["ALTK05"], serial: ["2062"], product: ["K05A"], scale: ["G1"], polewardOf: ["60"] },
    });
    expect(report.sent).toBe(entryTime(entryOf("ALTK05", 2062).issue_datetime));
    expect(report.areas).toEqual(polarCaps(60));
    expect(report.description?.startsWith("ALERT: Geomagnetic K-index of 5")).toBe(true);
    // A K-index of 4 is below the G scale: the kind is space weather, and the caps are at 65 degrees.
    expect(reportOf("ALTK04", 2697)).toMatchObject({ kind: { code: SPACE_WEATHER_KIND }, severity: "minor", areas: polarCaps(65) });
  });

  it("gives the severity and the caps of each level of the G scale", () => {
    const cases = [
      ["ALTK06", 729, "moderate", 55],
      ["ALTK07", 155, "moderate", 50],
      ["ALTK08", 39, "severe", 45],
      ["ALTK09", 8, "extreme", 40],
    ] as const;
    for (const [code, serial, severity, latitude] of cases) {
      expect(reportOf(code, serial)).toMatchObject({ kind: { code: GEOMAGNETIC_STORM_KIND }, severity, areas: polarCaps(latitude) });
    }
  });

  it("maps a warning and its extension: the extension references the serial number that it extends", () => {
    expect(reportOf("WARK04", 5451)).toMatchObject({ op: "alert", kind: { significance: "warning" }, urgency: "expected", certainty: "likely", onset: Date.parse("2026-11-09T05:56:00Z"), expires: Date.parse("2026-11-09T18:00:00Z") });
    expect(reportOf("WARK04", 5453)).toMatchObject({
      key: "WARK04/5453",
      op: "update",
      references: ["WARK04/5452"],
      onset: Date.parse("2026-11-09T05:56:00Z"),
      expires: Date.parse("2026-11-10T12:00:00Z"),
    });
    // A warning that starts after its sent time is in the future.
    expect(reportOf("WARK04", 4620)).toMatchObject({ urgency: "future" });
  });

  it("maps a cancel to a report that ends at its sent time and references the serial number that it ends", () => {
    for (const [code, serial, target] of [
      ["ALTK05", 1653, "ALTK05/1652"],
      ["ALTTP2", 1360, "ALTTP2/1359"],
      ["WARPX1", 580, "WARPX1/579"],
    ] as const) {
      const report = reportOf(code, serial);
      expect(report).toMatchObject({ op: "cancel", references: [target], urgency: "past", expires: report.sent });
      expect(report.onset).toBeUndefined();
    }
  });

  it("maps the families with no area: radio blackouts, radiation storms, electrons and radio emissions", () => {
    const flare = reportOf("ALTXMF", 390);
    expect(flare).toMatchObject({ kind: { code: RADIO_BLACKOUT_KIND, significance: "observation" }, severity: "moderate", areas: [], parameters: { scale: ["R2"] } });
    expect(flare.expires).toBe(Math.max(flare.onset!, flare.sent) + SHORT_ALERT_LIFE_MS);
    const protons = reportOf("ALTPX2", 72);
    expect(protons).toMatchObject({ kind: { code: SOLAR_RADIATION_STORM_KIND }, severity: "moderate", areas: [], parameters: { scale: ["S2"] } });
    expect(protons.expires).toBe(protons.sent + ALERT_LIFE_MS);
    expect(reportOf("ALTEF3", 3777)).toMatchObject({ op: "update", references: ["ALTEF3/3776"], kind: { code: SPACE_WEATHER_KIND }, areas: [] });
    const emission = reportOf("ALTTP2", 1534);
    expect(emission).toMatchObject({ kind: { code: SPACE_WEATHER_KIND }, areas: [] });
    // A radio emission ends one hour after its sent time.
    expect(emission.expires).toBe(Math.max(emission.onset!, emission.sent) + SHORT_ALERT_LIFE_MS);
    // A summary tells of an event in the past, from its begin time to its end time.
    expect(reportOf("SUMX01", 160)).toMatchObject({ kind: { code: RADIO_BLACKOUT_KIND, significance: "statement" }, severity: "moderate", urgency: "past", certainty: "observed", parameters: { scale: ["R3"] } });
  });
});

describe("the days of a watch", () => {
  it("maps each day of a watch to its own report: a day with no storm is a cancel", () => {
    const reports = reportsOf(entryOf("WATA20", 1138));
    expect(reports.map((report) => report.key)).toEqual(["WATA20/1138/2026-11-16", "WATA20/1138/2026-11-17", "WATA20/1138/2026-11-18"]);
    expect(reports.map((report) => report.op)).toEqual(["cancel", "alert", "alert"]);
    expect(reports.map((report) => report.kind.code)).toEqual([SPACE_WEATHER_KIND, GEOMAGNETIC_STORM_KIND, GEOMAGNETIC_STORM_KIND]);
    const [none, day] = reports;
    expect(none).toMatchObject({
      kind: { significance: "watch" },
      urgency: "future",
      certainty: "likely",
      onset: Date.UTC(2026, 10, 16),
      expires: Date.UTC(2026, 10, 17),
      correlation: [
        { system: WATCH_SYSTEM, id: "WATA20/1138" },
        { system: WATCH_DAY_SYSTEM, id: "2026-11-16" },
      ],
      areas: [{ type: "code", system: WATCH_DAY_SYSTEM, code: "2026-11-16", block: "caps" }],
      parameters: { day: ["2026-11-16"] },
    });
    expect(none?.parameters["scale"]).toBeUndefined();
    expect(day?.areas).toEqual([...polarCaps(60, "caps"), { type: "code", system: WATCH_DAY_SYSTEM, code: "2026-11-17", block: "caps" }]);
    expect(day?.expires! - day?.onset!).toBe(DAY);
  });

  it("gives the scale and the caps of each day, not the scale of the code of the watch", () => {
    // WATA50 is the code of a G3 watch. Its first day predicts G4.
    const days = reportsOf(entryOf("WATA50", 76));
    expect(days.map((report) => [report.parameters["scale"]?.[0], report.severity, report.parameters["polewardOf"]?.[0]])).toEqual([
      ["G4", "severe", "45"],
      ["G3", "moderate", "50"],
      ["G3", "moderate", "50"],
    ]);
    // The day of the issue started before the sent time, so it is expected.
    expect(days[0]?.urgency).toBe("expected");
  });

  it("joins two watches with shared days in one incident, and keeps the later forecast of each day", () => {
    // WATA50/76 (11:20 UTC) predicts G3 for 12 May 2024. WATA99/7 (17:53 UTC) predicts G5 for that day.
    const reports = [...reportsOf(entryOf("WATA50", 76)), ...reportsOf(entryOf("WATA99", 7))];
    const at = Date.parse("2024-05-12T06:00:00Z");
    const list = incidentsAt(reports, at);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ live: true, severity: "extreme", kind: { code: GEOMAGNETIC_STORM_KIND } });
    // Each place gets the days whose caps hold it: G5 at 40 degrees, G3 at 50 degrees, G1 at 60 degrees.
    expect(severitiesAt(reports, at, EDINBURGH)).toEqual(["extreme", "moderate"]);
    expect(severitiesAt(reports, at, MADRID)).toEqual(["extreme"]);
    expect(severitiesAt(reports, at, HOBART)).toEqual(["extreme"]);
    expect(severitiesAt(reports, at, SINGAPORE)).toEqual([]);
    // On 14 May only the G1 day of WATA99 is live.
    const late = Date.parse("2024-05-14T06:00:00Z");
    expect(incidentsAt(reports, late)[0]).toMatchObject({ live: true, severity: "minor" });
    expect(severitiesAt(reports, late, TROMSO)).toEqual(["minor"]);
    expect(severitiesAt(reports, late, EDINBURGH)).toEqual([]);
  });

  it("gives the same incidents for each order of the reports", () => {
    const reports = [...reportsOf(entryOf("WATA50", 76)), ...reportsOf(entryOf("WATA99", 7))];
    const at = Date.parse("2024-05-12T06:00:00Z");
    const expected = incidents(normalize({ reports }), at);
    fc.assert(
      fc.property(fc.shuffledSubarray(reports, { minLength: reports.length, maxLength: reports.length }), (order) => {
        expect(incidents(normalize({ reports: order }), at)).toEqual(expected);
      }),
    );
  });

  it("ends the forecast of a day when a later watch names that day with no storm", () => {
    // The archive has no watch that ends a day of an earlier watch. This variant of WATA20/1138 names its two days of G1 with no storm.
    const real = entryOf("WATA20", 1138);
    const message = real.message
      .replace("Serial Number: 1138", "Serial Number: 1139")
      .replace("Issue Time: 2026 Nov 15 1334 UTC", "Issue Time: 2026 Nov 16 1200 UTC")
      .replace("Nov 17:  G1 (Minor)", "Nov 17:  None (Below G1)")
      .replace("Nov 18:  G1 (Minor)", "Nov 18:  None (Below G1)");
    expect(message).not.toContain("G1 (Minor)   ");
    const later = reportsOf({ product_id: real.product_id, issue_datetime: "2026-11-16 12:00:00.000", message });
    expect(later.map((report) => report.op)).toEqual(["cancel", "cancel", "cancel"]);
    const at = Date.parse("2026-11-17T06:00:00Z");
    // Without the variant, the days 17 and 18 are live: two lines of G1 hold the place.
    expect(severitiesAt(reportsOf(real), at, TROMSO)).toEqual(["minor", "minor"]);
    expect(severitiesAt([...reportsOf(real), ...later], at, TROMSO)).toEqual([]);
  });

  it("keeps a later G1 forecast of a day that an earlier watch named with no storm", () => {
    // WATA20/1130 names 19 October 2026 with no storm. WATA20/1131 names it G1.
    const day = LIVE.flatMap((entry) => reportsOf(entry)).filter((report) => report.key.endsWith("/2026-10-19"));
    expect(day.map((report) => `${report.key} ${report.op}`)).toEqual(["WATA20/1131/2026-10-19 alert", "WATA20/1130/2026-10-19 cancel"]);
    const at = Date.parse("2026-10-19T12:00:00Z");
    expect(severitiesAt(day, at, TROMSO)).toEqual(["minor"]);
    expect(severitiesAt(day.filter((report) => report.key.startsWith("WATA20/1130/")), at, TROMSO)).toEqual([]);
  });
});

describe("the whole real list", () => {
  it("gives two live incidents at its fetch time: the electron alert and the watch of 17 and 18 November", () => {
    const reports = LIVE.flatMap((entry) => reportsOf(entry));
    const live = incidentsAt(reports, FETCHED).filter((incident) => incident.live);
    expect(live.map((incident) => `${incident.kind.code} ${String(incident.kind.significance)}`).sort()).toEqual([`${SPACE_WEATHER_KIND} observation`, `${GEOMAGNETIC_STORM_KIND} watch`]);
    const watch = live.find((incident) => incident.kind.code === GEOMAGNETIC_STORM_KIND)!;
    expect(matchPlaces(watch, [TROMSO, EDINBURGH]).map((match) => match.place)).toEqual(["tromso"]);
    // The electron alert has no area, so it matches no place.
    const electrons = live.find((incident) => incident.kind.code === SPACE_WEATHER_KIND)!;
    expect(matchPlaces(electrons, [TROMSO, EDINBURGH, MADRID])).toEqual([]);
  });
});

describe("the problems of the map", () => {
  const ALTK05 = entryOf("ALTK05", 2062);

  it("gives a fatal problem for a body that is not an entry of the list, and does not throw", () => {
    const fatal = (body: string) => {
      const result = mapObservation({ ...observe(ALTK05), body });
      expect(result.reports).toEqual([]);
      return result.problems.map((problem) => [problem.path, problem.fatal]);
    };
    expect(fatal("{")).toEqual([["", true]]);
    expect(fatal("[]")).toEqual([["", true]]);
    expect(fatal("42")).toEqual([["", true]]);
    expect(fatal(JSON.stringify({ product_id: "K05A" }))).toEqual([["", true]]);
    expect(fatal(JSON.stringify({ ...ALTK05, message: "moved" }))).toEqual([["message", true]]);
  });

  it("gives a fatal problem for a watch with no line of days", () => {
    const watch = entryOf("WATA20", 1138);
    const message = watch.message.replace("Highest Storm Level Predicted by Day:", "Levels:");
    const result = mapObservation(observe({ ...watch, message }));
    expect(result.reports).toEqual([]);
    expect(result.problems).toEqual([{ path: "message", message: "the watch has no line of its days: the map makes no report", fatal: true }]);
  });

  it("uses the issue time of the text, with a lossy problem, when the time of the list is not a time", () => {
    const result = mapObservation(observe({ ...ALTK05, issue_datetime: "2026-11-08T02:03:00Z" }));
    expect(result.reports[0]?.sent).toBe(Date.parse("2026-11-08T02:03:00Z"));
    expect(result.problems.map((problem) => [problem.path, problem.fatal, problem.lossy])).toEqual([["issue_datetime", false, true]]);
  });

  it("maps an unknown code to space weather with the severity unknown, and a lossy problem", () => {
    const message = ALTK05.message.replace("Code: ALTK05", "Code: ALTXYZ");
    const result = mapObservation(observe({ ...ALTK05, message }));
    expect(result.reports[0]).toMatchObject({ key: "ALTXYZ/2062", kind: { code: SPACE_WEATHER_KIND }, severity: "unknown", areas: [] });
    expect(result.problems.map((problem) => [problem.path, problem.lossy])).toEqual([["message", true]]);
  });

  it("gives no reference, with a lossy problem, for a serial number that is not a number", () => {
    const update = entryOf("ALTEF3", 3777);
    const message = update.message.replace("Continuation of Serial Number: 3776", "Continuation of Serial Number: none");
    expect(message).not.toBe(update.message);
    const result = mapObservation(observe({ ...update, message }));
    expect(result.reports[0]).toMatchObject({ op: "update", references: [] });
    expect(result.problems.map((problem) => problem.path)).toEqual(["message.continuation of serial number"]);
  });

  it("does not throw for each cut of a real message, and gives reports or a fatal problem", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: ALTK05.message.length }), (length) => {
        const result = mapObservation(observe({ ...ALTK05, message: ALTK05.message.slice(0, length) }));
        expect(result.reports.length > 0 || result.problems.some((problem) => problem.fatal)).toBe(true);
      }),
    );
  });

  it("does not throw for each body", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (body) => {
        const result = mapObservation({ ...observe(ALTK05), body });
        expect(Array.isArray(result.reports)).toBe(true);
      }),
    );
  });
});

describe("the helpers of the map", () => {
  it("reads the issue time of the list as UTC, and gives undefined for each other value", () => {
    expect(entryTime("2026-11-16 06:28:16.430")).toBe(Date.UTC(2026, 10, 16, 6, 28, 16, 430));
    expect(entryTime("2026-11-16 06:28:16")).toBe(Date.UTC(2026, 10, 16, 6, 28, 16));
    for (const value of [undefined, 0, "", "2026-11-16T06:28:16Z", "2026-02-30 00:00:00", "2026-11-16 24:00:00"]) expect(entryTime(value)).toBeUndefined();
  });

  it("gives two antipodal caps with the radius of the arc from the pole to the latitude", () => {
    const [north, south] = polarCaps(60);
    expect(north).toMatchObject({ type: "circle", center: GEOMAGNETIC_POLES[0] });
    expect(south).toMatchObject({ type: "circle", center: GEOMAGNETIC_POLES[1] });
    expect(north?.type === "circle" && north.radiusKm).toBeCloseTo(3335.85, 1);
    expect(GEOMAGNETIC_POLES[0]![1]).toBe(-GEOMAGNETIC_POLES[1]![1]);
    expect(GEOMAGNETIC_POLES[0]![0] + 180).toBeCloseTo(GEOMAGNETIC_POLES[1]![0], 9);
  });

  it("gives the kind of each family and level", () => {
    expect(kindOf("geomagnetic", 0)).toBe(SPACE_WEATHER_KIND);
    expect(kindOf("geomagnetic", 1)).toBe(GEOMAGNETIC_STORM_KIND);
    expect(kindOf("radio-blackout", 2)).toBe(RADIO_BLACKOUT_KIND);
    expect(kindOf("radiation", 0)).toBe(SOLAR_RADIATION_STORM_KIND);
    expect(kindOf("electron", 0)).toBe(SPACE_WEATHER_KIND);
    expect(kindOf(undefined, 3)).toBe(SPACE_WEATHER_KIND);
  });
});
