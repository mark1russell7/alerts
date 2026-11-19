import { readFileSync } from "node:fs";
import { checkWith, DEFAULT_ASSESS_POLICY, observationId, readingProblems, readingSchema, reportSchema, tableLevel, type Observation, type SourceId } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { gtfsDescriptor } from "./descriptor.ts";
import { boxArea, sourceIdOf, type GtfsFeed } from "./feed.ts";
import { BODY_TYPE, feedBodies } from "./fetch.ts";
import {
  ACTIVE_ALERTS,
  alertText,
  areasOf,
  censusText,
  ended,
  FEED_SUBJECT,
  GTFS_KIND,
  inEffect,
  mapObservation,
  MAX_PARAMETER_VALUES,
  NO_SERVICE_ALERTS,
  ROUTE_SUBJECT,
  severityOf,
  stableAlert,
  STOP_RADIUS_KM,
  STOP_SUBJECT,
  subjectsOf,
  textIn,
} from "./map.ts";
import { decodeFeed, type Alert, type FeedEntity, type FeedMessage, type TimeRange } from "./proto.ts";

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
  box: { west: 14.4, south: 53.3, east: 14.8, north: 53.6 },
};
const RUTER_FEED: GtfsFeed = { id: "mdb-1799", title: "Ruter", url: "https://transit.example.test/ruter", origin: "ruter", box: { west: 10.2, south: 59.6, east: 11.4, north: 60.2 } };

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
        expect(reading.area).toEqual(boxArea(feed.box));
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
      headline: "ZDiTM Szczecin: Route changed: Metalowa ↔ Miechowska",
      web: "https://www.zditm.szczecin.pl/en/passenger/disruptions/other/1124",
      parameters: { effect: ["MODIFIED_SERVICE"], cause: ["OTHER_CAUSE"], route: ["85", "904"], language: ["pl", "en", "de", "uk"] },
    });
    // The config has no places of stops or routes, so the report has no area. The box of the feed is never an area.
    expect(route?.areas).toEqual([]);
    expect(route?.about.filter((subject) => subject.system !== STOP_SUBJECT)).toEqual([
      { system: FEED_SUBJECT, id: "mdb-1967", label: "ZDiTM Szczecin" },
      { system: ROUTE_SUBJECT, id: "mdb-1967/85" },
      { system: ROUTE_SUBJECT, id: "mdb-1967/904" },
    ]);
    // The end of the period of the route is to come, and some feeds move such an end at each fetch. Thus the report has no expiry.
    expect(route?.expires).toBeUndefined();
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
    // An alert of each night: the onset is the start of the night of the fetch. The last night is to come, thus the report has no expiry.
    expect(byKey.get("2026-76070-2")).toMatchObject({ urgency: "immediate", onset: Date.parse("2026-11-17T21:00:00Z") });
    expect(byKey.get("2026-76070-2")?.expires).toBeUndefined();
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

  it("gives the area of each known route of an alert, and keeps the report valid", () => {
    const feed: GtfsFeed = { ...ZDITM_FEED, places: { routes: { "85": { west: 14.5, south: 53.4, east: 14.6, north: 53.45 } } } };
    const [route] = observationsOf(feed, ZDITM).slice(1).flatMap((observation) => mapObservation(feed, observation).reports);
    expect(route?.areas).toEqual([boxArea({ west: 14.5, south: 53.4, east: 14.6, north: 53.45 })]);
    expect(checkWith(reportSchema, route).tag).toBe("ok");
  });
});

describe("the id of a transit report (AL-73)", () => {
  it("has no fetch time: a later fetch of the same text gives the same id", () => {
    const ids = (fetched: number): Map<string, string> =>
      new Map(
        observationsOf(RUTER_FEED, RUTER, fetched)
          .slice(1)
          .flatMap((observation) => mapObservation(RUTER_FEED, observation).reports)
          .map((report) => [report.key, report.id]),
      );
    const first = ids(RUTER_FETCHED);
    expect(first.size).toBe(59);
    // One hour later, 3 alerts ended, so they give no report. Each other alert keeps its id.
    const later = ids(RUTER_FETCHED + 3_600_000);
    expect(later.size).toBe(56);
    for (const [key, id] of later) expect(first.get(key)).toBe(id);
  });

  it("gives a new id with the same key to a new text of an alert", () => {
    const report = (text: string) => mapObservation(ZDITM_FEED, observationOf(alertText("mdb-1967", "7", { headerText: { translation: [{ text }] } }))).reports[0];
    const [before, after] = [report("Trams stop."), report("Trams stop until noon.")];
    expect(after?.key).toBe(before?.key);
    expect(after?.id).not.toBe(before?.id);
    expect(report("Trams stop.")?.id).toBe(before?.id);
  });
});

describe("an alert whose feed moves its end at each fetch (AL-75)", () => {
  const STEP = 5 * 60_000;
  const DETOUR = "Buses take a detour.";
  /** This function gives the feed one fetch later. Some feeds move each end that is to come, and their own time, at each fetch. */
  const moved = (message: FeedMessage, from: number, by: number): FeedMessage => ({
    ...message,
    entity: (message.entity ?? []).map((entity) =>
      entity.alert?.activePeriod === undefined
        ? entity
        : { ...entity, alert: { ...entity.alert, activePeriod: entity.alert.activePeriod.map((range) => (range.end !== undefined && range.end * 1000 >= from ? { ...range, end: range.end + by / 1000 } : range)) } },
    ),
  });
  /** An alert with a rolling end, two hours after each fetch, as a real feed gives it. */
  const rolling = (fetched: number, text = DETOUR): FeedEntity => ({
    id: "rolling",
    alert: { activePeriod: [{ start: S("2026-11-17T00:00:00Z"), end: Math.floor(fetched / 1000) + 7_172 }], headerText: { translation: [{ text }] } },
  });
  const feedAt = (fetched: number, text?: string): FeedMessage => {
    const message = moved(RUTER, RUTER_FETCHED, fetched - RUTER_FETCHED);
    return { ...message, entity: [...(message.entity ?? []), rolling(fetched, text)] };
  };
  const observationsAt = (fetched: number, text?: string) => observationsOf(RUTER_FEED, feedAt(fetched, text), fetched).slice(1);
  const reportsAt = (fetched: number, text?: string) => observationsAt(fetched, text).flatMap((observation) => mapObservation(RUTER_FEED, observation).reports);
  const idsAt = (fetched: number, text?: string) => new Map(reportsAt(fetched, text).map((report) => [report.key, report.id]));

  it("gives the same observations and report ids one fetch later, though each end that is to come moved", () => {
    const [first, next] = [RUTER_FETCHED, RUTER_FETCHED + STEP];
    // The raw alert changed between the two fetches: its end is in it.
    expect(alertText(RUTER_FEED.id, "rolling", rolling(next).alert!)).not.toBe(alertText(RUTER_FEED.id, "rolling", rolling(first).alert!));
    expect(observationsAt(next).map((observation) => observation.id)).toEqual(observationsAt(first).map((observation) => observation.id));
    expect(idsAt(first).size).toBe(60);
    expect(idsAt(next)).toEqual(idsAt(first));
  });

  it("gives a report with no planned end while its end is to come, and keeps its start", () => {
    const reports = reportsAt(RUTER_FETCHED);
    const detour = reports.find((report) => report.key === "rolling");
    expect(detour?.onset).toBe(S("2026-11-17T00:00:00Z") * 1000);
    expect(detour?.urgency).toBe("immediate");
    expect(reports.filter((report) => report.expires !== undefined)).toEqual([]);
  });

  it("gives a new version with the same key to a changed text one fetch later, and keeps the id of each other alert", () => {
    const first = idsAt(RUTER_FETCHED);
    const next = idsAt(RUTER_FETCHED + STEP, "Buses take a detour until noon.");
    expect([...next].filter(([key, id]) => first.get(key) !== id).map(([key]) => key)).toEqual(["rolling"]);
  });

  it("keeps each end that passed, and takes out each end that is to come", () => {
    const at = Date.parse("2026-11-18T03:00:00Z");
    const passed = { start: S("2026-11-18T01:00:00Z"), end: S("2026-11-18T02:00:00Z") };
    const alert: Alert = { activePeriod: [passed, { start: S("2026-11-18T05:00:00Z"), end: S("2026-11-18T06:00:00Z") }, { start: S("2026-11-19T05:00:00Z") }] };
    expect(stableAlert(alert, at).activePeriod).toEqual([passed, { start: S("2026-11-18T05:00:00Z") }, { start: S("2026-11-19T05:00:00Z") }]);
    // An end at the time of the fetch is to come: its period holds the time.
    expect(stableAlert({ activePeriod: [{ end: at / 1000 }] }, at).activePeriod).toEqual([{}]);
    const none: Alert = { headerText: { translation: [{ text: "x" }] } };
    expect(stableAlert(none, at)).toBe(none);
  });

  it("keeps the state of each alert at the time, and gives the same alert one fetch later, for each list of periods", () => {
    const range = fc.record({ start: fc.integer({ min: 0, max: 100 }), end: fc.integer({ min: 0, max: 100 }) }, { requiredKeys: [] });
    fc.assert(
      fc.property(fc.array(range, { maxLength: 4 }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 1, max: 50 }), (periods, seconds, step) => {
        const alert: Alert = { activePeriod: periods };
        const at = seconds * 1000;
        const stable = stableAlert(alert, at);
        expect([inEffect(stable, at), ended(stable, at)]).toEqual([inEffect(alert, at), ended(alert, at)]);
        // The feed moves each end that is to come by the step of the fetch.
        const later: Alert = { activePeriod: periods.map((each) => (each.end !== undefined && each.end >= seconds ? { ...each, end: each.end + step } : each)) };
        expect(stableAlert(later, at + step * 1000)).toEqual(stable);
      }),
    );
  });
});

describe("the areas and the subjects of an alert (AL-73)", () => {
  const box = { west: 14.5, south: 53.4, east: 14.6, north: 53.45 };
  const places: GtfsFeed["places"] = { stops: { s1: [14.55, 53.42] }, routes: { r1: box } };

  it("gives a circle for a known stop, else the box of a known route, and no area for each other selector", () => {
    const areas = areasOf({ places }, [{ stopId: "s1", routeId: "r1" }, { routeId: "r1" }, { trip: { routeId: "r2" } }, { agencyId: "a" }, { stopId: "s9" }]);
    expect(areas).toEqual([
      { type: "circle", center: [14.55, 53.42], radiusKm: STOP_RADIUS_KM },
      boxArea(box),
    ]);
    expect(areasOf({ places }, [{ trip: { tripId: "t", routeId: "r1" } }])).toEqual([boxArea(box)]);
  });

  it("never gives the box of the feed: a feed with no places gives no area for any selector", () => {
    for (const selectors of [[], [{ agencyId: "a" }], [{ routeId: "85" }, { stopId: "1" }]]) {
      expect(areasOf(ZDITM_FEED, selectors)).toEqual([]);
      expect(areasOf({ places }, selectors)).not.toContainEqual(boxArea(ZDITM_FEED.box));
    }
  });

  it("gives no more than the most areas, and one area for a stop named twice", () => {
    const stops = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`s${String(index)}`, [14.5, 53.4] as const]));
    const selectors = Object.keys(stops).map((stopId) => ({ stopId }));
    expect(areasOf({ places: { stops } }, selectors)).toHaveLength(MAX_PARAMETER_VALUES);
    expect(areasOf({ places }, [{ stopId: "s1" }, { stopId: "s1" }])).toHaveLength(1);
  });

  it("gives the feed, then each route and each stop, with the id of the feed in each id", () => {
    expect(subjectsOf(ZDITM_FEED, [{ routeId: "85", stopId: "1" }, { trip: { routeId: "904" } }, { agencyId: "a" }])).toEqual([
      { system: FEED_SUBJECT, id: "mdb-1967", label: "ZDiTM Szczecin" },
      { system: ROUTE_SUBJECT, id: "mdb-1967/85" },
      { system: ROUTE_SUBJECT, id: "mdb-1967/904" },
      { system: STOP_SUBJECT, id: "mdb-1967/1" },
    ]);
    expect(subjectsOf(ZDITM_FEED, [])).toEqual([{ system: FEED_SUBJECT, id: "mdb-1967", label: "ZDiTM Szczecin" }]);
  });

  it("gives each report of the two feeds the digest at most with the default policy, also at the worst severity", () => {
    const reports = [
      ...observationsOf(ZDITM_FEED, ZDITM).slice(1).flatMap((observation) => mapObservation(ZDITM_FEED, observation).reports),
      ...observationsOf(RUTER_FEED, RUTER, RUTER_FETCHED).slice(1).flatMap((observation) => mapObservation(RUTER_FEED, observation).reports),
    ];
    expect(reports).toHaveLength(61);
    for (const report of reports) {
      expect(["none", "digest"]).toContain(tableLevel(DEFAULT_ASSESS_POLICY, report).level);
      expect(tableLevel(DEFAULT_ASSESS_POLICY, { ...report, severity: "extreme", urgency: "immediate" }).level).toBe("digest");
    }
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
