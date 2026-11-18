import { readFileSync } from "node:fs";
import { checkWith, observationId, readingProblems, readingSchema, reportSchema, type Observation, type SourceId } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { gtfsDescriptor } from "./descriptor.ts";
import { sourceIdOf, type GtfsFeed } from "./feed.ts";
import { BODY_TYPE, feedBodies } from "./fetch.ts";
import { ACTIVE_ALERTS, alertText, censusText, ended, GTFS_KIND, inEffect, mapObservation, MAX_PARAMETER_VALUES, NO_SERVICE_ALERTS, severityOf, textIn } from "./map.ts";
import { decodeFeed, type Alert, type TimeRange } from "./proto.ts";

/** The real bytes of two feeds (`fixtures/README.md`), and the time of their fetch. */
const ZDITM = decodeFeed(readFileSync(new URL("../fixtures/zditm-szczecin-20261118T0358Z.pb", import.meta.url)));
const RUTER = decodeFeed(readFileSync(new URL("../fixtures/ruter-20261118T0358Z.pb", import.meta.url)));
const FETCHED = Date.parse("2026-11-18T03:58:19Z");
const RUTER_FETCHED = Date.parse("2026-11-18T03:58:18Z");

const ZDITM_FEED: GtfsFeed = {
  id: "mdb-1967",
  title: "ZDiTM Szczecin",
  url: "https://transit.example.test/gtfs-rt-alerts.pb",
  origin: "zditm-szczecin",
  country: "PL",
  box: { west: 14.4, south: 53.3, east: 14.8, north: 53.6 },
};
const RUTER_FEED: GtfsFeed = { id: "mdb-1799", title: "Ruter", url: "https://transit.example.test/ruter", origin: "ruter", country: "NO", box: { west: 10.2, south: 59.6, east: 11.4, north: 60.2 } };

/** This function gives the observations of the bodies of a decoded feed, as the fetch makes them. */
const observationsOf = (feed: GtfsFeed, message: ReturnType<typeof decodeFeed>, fetched = FETCHED): Observation[] =>
  feedBodies(feed, message, fetched).bodies.map((body) => ({
    id: observationId({ source: sourceIdOf(feed), contentType: BODY_TYPE, url: feed.url, body }),
    source: sourceIdOf(feed),
    fetched,
    contentType: BODY_TYPE,
    body,
    transport: { latency: 0 },
  }));

/** This function gives an observation of one body at a time. */
const X = "gtfs-x" as SourceId;
const observationOf = (body: string, fetched = FETCHED): Observation => ({ id: observationId({ source: X, contentType: BODY_TYPE, url: "u", body }), source: X, fetched, contentType: BODY_TYPE, body, transport: { latency: 0 } });

const S = (iso: string): number => Date.parse(iso) / 1000;

describe("mapObservation of the real feeds", () => {
  it("gives the two readings of the census of each feed, valid against the declarations", () => {
    for (const [feed, message, active] of [
      [ZDITM_FEED, ZDITM, 2],
      [RUTER_FEED, RUTER, 58],
    ] as const) {
      const [census] = observationsOf(feed, message);
      const result = mapObservation(feed, census!);
      expect(result.problems).toEqual([]);
      expect(result.reports).toEqual([]);
      expect(result.readings?.map((reading) => [reading.measure, reading.value])).toEqual([
        [ACTIVE_ALERTS, active],
        [NO_SERVICE_ALERTS, 0],
      ]);
      for (const reading of result.readings ?? []) {
        expect(reading.area).toEqual({ type: "code", system: "iso3166", code: feed.country });
        expect(reading.at).toBe((message.header?.timestamp ?? 0) * 1000);
        expect(checkWith(readingSchema, reading).tag).toBe("ok");
        expect(readingProblems(reading, gtfsDescriptor(feed))).toEqual([]);
      }
    }
  });

  it("gives one valid report for each alert of the Szczecin feed, in English, with its routes and its periods", () => {
    const results = observationsOf(ZDITM_FEED, ZDITM).slice(1).map((observation) => mapObservation(ZDITM_FEED, observation));
    expect(results.flatMap((result) => result.problems)).toEqual([]);
    const reports = results.flatMap((result) => result.reports);
    expect(reports.map((report) => report.key)).toEqual(["1124", "1055"]);
    for (const report of reports) expect(checkWith(reportSchema, report).tag).toBe("ok");
    const [route] = reports;
    expect(route).toMatchObject({
      source: "gtfs-mdb-1967",
      origin: "zditm-szczecin",
      kind: { code: GTFS_KIND },
      severity: "minor",
      urgency: "immediate",
      certainty: "observed",
      sent: FETCHED,
      onset: Date.parse("2026-11-09T00:01:00Z"),
      expires: Date.parse("2026-11-20T22:59:00Z"),
      headline: "ZDiTM Szczecin: Route changed: Metalowa ↔ Miechowska",
      web: "https://www.zditm.szczecin.pl/en/passenger/disruptions/other/1124",
      parameters: { effect: ["MODIFIED_SERVICE"], cause: ["OTHER_CAUSE"], route: ["85", "904"], language: ["pl", "en", "de", "uk"] },
    });
    expect(route?.areas).toEqual([
      {
        type: "polygon",
        rings: [
          [
            [14.4, 53.3],
            [14.8, 53.3],
            [14.8, 53.6],
            [14.4, 53.6],
            [14.4, 53.3],
          ],
        ],
      },
    ]);
    // The stop moved with no end: the report has no expiry.
    expect(reports[1]?.expires).toBeUndefined();
    expect(reports[1]?.parameters["effect"]).toEqual(["STOP_MOVED"]);
  });

  it("gives a report for each alert of the Oslo feed that has not ended, from texts with no language, effect or level", () => {
    const results = observationsOf(RUTER_FEED, RUTER, RUTER_FETCHED).slice(1).map((observation) => mapObservation(RUTER_FEED, observation));
    expect(results.flatMap((result) => result.problems)).toEqual([]);
    const reports = results.flatMap((result) => result.reports);
    // The feed lists 59 alerts. All are open at the fetch, and 58 are in effect.
    expect(reports).toHaveLength(59);
    for (const report of reports) expect(checkWith(reportSchema, report).tag).toBe("ok");
    expect(new Set(reports.map((report) => report.severity))).toEqual(new Set(["minor"]));
    const byKey = new Map(reports.map((report) => [report.key.replace("RUT:SituationNumber:", ""), report]));
    // An alert that starts after the fetch is a future report, with the start of its period as its onset.
    expect(byKey.get("SM-5b1ba2062e664e1aa117b1a70d9981eb")).toMatchObject({ urgency: "future", certainty: "likely", onset: Date.parse("2026-11-19T00:06:00Z") });
    // An alert of each night: the onset is the start of the night of the fetch, and the expiry the end of the last night.
    expect(byKey.get("2026-76070-2")).toMatchObject({ urgency: "immediate", onset: Date.parse("2026-11-17T21:00:00Z"), expires: Date.parse("2026-11-30T05:00:00Z") });
    // The English text wins when the feed names the languages. A text with no language code gives no language.
    expect(byKey.get("313478")).toMatchObject({ headline: "Ruter: Change of platform at Brynseng", parameters: { language: ["no", "en"] } });
    expect(byKey.get("2026-74405-1")?.parameters["language"]).toBeUndefined();
    // An alert with 96 selectors keeps the first 50 stops.
    expect(byKey.get("2026-75460-1")?.parameters["stop"]).toHaveLength(MAX_PARAMETER_VALUES);
  });

  it("gives the same observations for the same feed, and the same report ids", () => {
    const first = observationsOf(RUTER_FEED, RUTER);
    const again = observationsOf(RUTER_FEED, RUTER);
    expect(again.map((observation) => observation.id)).toEqual(first.map((observation) => observation.id));
  });
});

describe("the time of an alert", () => {
  const alert = (periods?: readonly TimeRange[]): Alert => ({ ...(periods === undefined ? {} : { activePeriod: periods }), headerText: { translation: [{ text: "x" }] } });
  const at = Date.parse("2026-11-18T12:00:00Z");

  it("reads an alert with no period as in effect at each time, and never ended", () => {
    expect(inEffect(alert([]), at)).toBe(true);
    expect(ended(alert(undefined), at)).toBe(false);
  });

  it("reads an open start or end as open", () => {
    expect(inEffect(alert([{ end: S("2026-11-18T13:00:00Z") }]), at)).toBe(true);
    expect(inEffect(alert([{ start: S("2026-11-18T13:00:00Z") }]), at)).toBe(false);
    expect(ended(alert([{ start: S("2026-11-01T00:00:00Z") }]), at)).toBe(false);
  });

  it("ends an alert only when each period ended", () => {
    const periods = [{ start: S("2026-11-17T00:00:00Z"), end: S("2026-11-17T06:00:00Z") }, { start: S("2026-11-19T00:00:00Z"), end: S("2026-11-19T06:00:00Z") }];
    expect(inEffect(alert(periods), at)).toBe(false);
    expect(ended(alert(periods), at)).toBe(false);
    expect(ended(alert(periods), Date.parse("2026-11-20T00:00:00Z"))).toBe(true);
  });

  it("is in effect at a time if and only if a period holds the time, for each list of periods", () => {
    const range = fc.record({ start: fc.integer({ min: 0, max: 100 }), end: fc.integer({ min: 0, max: 100 }) }, { requiredKeys: [] });
    fc.assert(
      fc.property(fc.array(range, { minLength: 1, maxLength: 4 }), fc.integer({ min: 0, max: 100 }), (periods, seconds) => {
        const holds = periods.some((each) => (each.start === undefined || each.start <= seconds) && (each.end === undefined || seconds <= each.end));
        expect(inEffect(alert(periods), seconds * 1000)).toBe(holds);
        if (ended(alert(periods), seconds * 1000)) expect(holds).toBe(false);
      }),
    );
  });
});

describe("severityOf and textIn", () => {
  it("takes the severity from the level, and else from the effect", () => {
    expect(severityOf({ severityLevel: 4 })).toBe("severe");
    expect(severityOf({ severityLevel: 3, effect: 1 })).toBe("moderate");
    expect(severityOf({ severityLevel: 2, effect: 1 })).toBe("minor");
    expect(severityOf({ severityLevel: 1, effect: 1 })).toBe("moderate");
    expect(severityOf({ effect: 3 })).toBe("minor");
  });

  it("takes the English text, else the text with no language, else the first text", () => {
    expect(textIn({ translation: [{ text: "Linia", language: "pl" }, { text: " Line ", language: "EN" }] })).toBe("Line");
    expect(textIn({ translation: [{ text: "Linja", language: "fi" }, { text: "Line" }] })).toBe("Line");
    expect(textIn({ translation: [{ text: " ", language: "en" }, { text: "Linja", language: "fi" }] })).toBe("Linja");
    expect(textIn(undefined)).toBeUndefined();
  });
});

describe("mapObservation of bodies that are not good", () => {
  it("gives a fatal problem and no report for a body that is not JSON, not a census or not an alert", () => {
    for (const body of ["{", "[]", JSON.stringify({ type: "trip" })]) {
      const result = mapObservation(ZDITM_FEED, observationOf(body));
      expect(result.reports).toEqual([]);
      expect(result.problems.map((problem) => problem.fatal)).toEqual([true]);
    }
  });

  it("gives a fatal problem for a census with no counts, and for an alert with no id or no text", () => {
    expect(mapObservation(ZDITM_FEED, observationOf(JSON.stringify({ type: "census", at: "2026-11-18T00:00:00Z" }))).problems[0]?.fatal).toBe(true);
    expect(mapObservation(ZDITM_FEED, observationOf(alertText("mdb-1967", " ", { headerText: { translation: [{ text: "x" }] } }))).problems[0]?.path).toBe("entity");
    expect(mapObservation(ZDITM_FEED, observationOf(alertText("mdb-1967", "7", { effect: 1 }))).problems[0]).toMatchObject({ path: "alert.headerText", fatal: true });
  });

  it("names the effect in the headline of an alert with only a description, and tells of the loss", () => {
    const result = mapObservation(ZDITM_FEED, observationOf(alertText("mdb-1967", "7", { effect: 1, descriptionText: { translation: [{ text: "No trams." }] } })));
    expect(result.reports[0]).toMatchObject({ headline: "ZDiTM Szczecin: no service", description: "No trams.", severity: "moderate" });
    expect(result.problems).toEqual([{ path: "alert.headerText", message: expect.any(String), fatal: false, lossy: true }]);
  });

  it("does not throw for any JSON body", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const result = mapObservation(ZDITM_FEED, observationOf(JSON.stringify({ type: "alert", feed: "mdb-1967", entity: "1", alert: value })));
        expect(Array.isArray(result.reports)).toBe(true);
      }),
    );
  });
});

describe("the census", () => {
  it("counts the alerts in effect at the time of the feed, and those that stop a service", () => {
    const message = {
      header: { timestamp: S("2026-11-18T12:00:00Z") },
      entity: [
        { id: "a", alert: { effect: 1, headerText: { translation: [{ text: "No service" }] } } },
        { id: "b", alert: { effect: 1, activePeriod: [{ start: S("2026-11-19T00:00:00Z") }], headerText: { translation: [{ text: "Later" }] } } },
        { id: "c", isDeleted: true, alert: { effect: 1 } },
        { id: "d" },
      ],
    };
    const { bodies, complete, asOf } = feedBodies(ZDITM_FEED, message, Date.parse("2026-11-18T12:00:30Z"));
    expect(complete).toBe(true);
    expect(asOf).toBe(Date.parse("2026-11-18T12:00:00Z"));
    expect(JSON.parse(bodies[0]!)).toEqual(JSON.parse(censusText({ feed: "mdb-1967", at: "2026-11-18T12:00:00.000Z", entities: 4, alerts: 2, active: 1, noService: 1 })));
    // The deleted entity and the entity with no alert give no body.
    expect(bodies).toHaveLength(3);
  });

  it("gives a differential feed as not complete, and takes the time of the fetch when the header has no time", () => {
    const { complete, asOf, bodies } = feedBodies(ZDITM_FEED, { header: { incrementality: 1 }, entity: [] }, Date.parse("2026-11-18T12:00:30Z"));
    expect(complete).toBe(false);
    expect(asOf).toBeUndefined();
    expect((JSON.parse(bodies[0]!) as { at: string }).at).toBe("2026-11-18T12:00:30.000Z");
  });
});
