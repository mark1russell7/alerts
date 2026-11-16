import { readFileSync } from "node:fs";
import { incidents, knownKind, normalize, observationId, reportSchema, type Observation, type Report } from "@mark1russell7/alerts";
import { bandDiscs, FELT_INTENSITY, intensityAt, lawAt } from "@mark1russell7/alerts-quake";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { eventBody, readAnswer } from "./fetch.ts";
import { ANSS_ORIGIN, EARTHQUAKE_KIND, EMSC_CREDIT, EMSC_ORIGIN, EVENT_PAGE, EVENT_SYSTEM, eventTime, mapObservation, originOf, REPORT_LIFE_MS, SOURCE_ID } from "./map.ts";

/** The real answer of EMSC: 53 of the 183 earthquakes of magnitude 2.5 or more of one day (`fixtures/README.md`). */
const ANSWER = readFileSync(new URL("../fixtures/query-2.5_day-20261116T0528Z.json", import.meta.url), "utf8");
const FEATURES = (JSON.parse(ANSWER) as { features: Record<string, unknown>[] }).features;
const URL_OF_QUERY = "https://www.seismicportal.eu/fdsnws/event/1/query?format=json&minmag=2.5&start=2026-11-15T05:00:00&orderby=time&limit=500";
const FETCHED = Date.parse("2026-11-16T05:28:21Z");

const featureOf = (id: string): Record<string, unknown> => {
  const found = FEATURES.find((feature) => feature["id"] === id);
  if (found === undefined) throw new Error(`no event ${id}`);
  return found;
};
const withProperties = (feature: Record<string, unknown>, properties: Record<string, unknown>): Record<string, unknown> => ({
  ...feature,
  properties: { ...(feature["properties"] as object), ...properties },
});
const withPoint = (feature: Record<string, unknown>, coordinates: unknown): Record<string, unknown> => ({ ...feature, geometry: { type: "Point", coordinates } });
/** This function makes the observation of one feature, as the fetch makes it. */
const observationOf = (feature: unknown): Observation => {
  const body = eventBody(feature);
  return { id: observationId({ source: SOURCE_ID, contentType: "application/json", url: URL_OF_QUERY, body }), source: SOURCE_ID, fetched: FETCHED, contentType: "application/json", body, transport: { latency: 0 } };
};
/** This function maps one feature, and expects one report or more and no problem. */
const mapAll = (feature: unknown): readonly Report[] => {
  const result = mapObservation(observationOf(feature));
  expect(result.problems).toEqual([]);
  expect(result.reports.length).toBeGreaterThan(0);
  return result.reports;
};
const radiusOf = (report: Report): number => {
  const [area] = report.areas;
  if (area?.type !== "circle" || report.areas.length !== 1) throw new Error("the report has no one circle");
  return area.radiusKm;
};

/** The M5.5 event in the Philippines, depth 10 km, with the solution of the national network of the USGS (`NEIC`). */
const PHILIPPINES = featureOf("20261115_0000145");
/** An M3.5 event in Alaska, with the solution of the Alaska network (`AK`). Its time has six digits after the second. */
const ALASKA = featureOf("20261115_0000194");
/** An M4.8 event off Kamchatka, with the solution of the Russian survey (`GSRAS`): an origin outside the ANSS. */
const KAMCHATKA = featureOf("20261115_0000272");

describe("eventTime", () => {
  it("reads each time format of the answer, with 1 to 6 digits after the second", () => {
    const formats = new Set(FEATURES.map((feature) => String((feature["properties"] as { time: string }).time).replace(/\d/g, "9")));
    expect(formats.size).toBe(5);
    for (const feature of FEATURES) {
      const time = (feature["properties"] as { time: string }).time;
      expect(eventTime(time)).toBe(Date.parse(time));
    }
    expect(eventTime("2026-11-16T05:16:26.0Z")).toBe(Date.UTC(2026, 10, 16, 5, 16, 26));
    expect(eventTime("2026-11-15T17:13:49.968484Z")).toBe(Date.UTC(2026, 10, 15, 17, 13, 49, 968));
    expect(eventTime("2026-11-15T17:13:49Z")).toBe(Date.UTC(2026, 10, 15, 17, 13, 49));
  });

  it("gives no time for a value that is not a UTC time of the calendar", () => {
    const values: unknown[] = ["2026-11-16T05:16:26", "2026-11-16 05:16:26Z", "2026-11-16T05:16:26+01:00", "2026-11-31T00:00:00Z", "2026-11-16T24:00:00Z", "2026-02-29T00:00:00Z", "2026-11-16T05:16:60Z", "", 1_763_270_186_000, null];
    for (const value of values) expect(eventTime(value)).toBeUndefined();
    expect(eventTime("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29));
  });
});

describe("originOf", () => {
  it("gives the origin of the USGS to a network of the ANSS, and the origin of EMSC to each other author", () => {
    expect(ANSS_ORIGIN).toBe("usgs");
    for (const author of ["NEIC", "AK", "HV", "NN", "OK", "PR", "us", "ci"]) expect(originOf(author)).toBe(ANSS_ORIGIN);
    for (const author of ["EMSC", "GSRAS", "CSN", "BMKG", "INGV", "", undefined]) expect(originOf(author)).toBe(EMSC_ORIGIN);
  });
});

describe("mapObservation", () => {
  it("maps each event of the real answer to one valid report for each band, with nested discs and no problem", () => {
    const listed = readAnswer({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: ANSWER }, URL_OF_QUERY, FETCHED, 40)?.listed ?? [];
    expect(listed).toHaveLength(53);
    const origins = new Set<string>();
    for (const { observation } of listed) {
      const result = mapObservation(observation);
      expect(result.problems).toEqual([]);
      expect(result.reports.length).toBeGreaterThan(0);
      const author = (JSON.parse(observation.body) as { auth: string }).auth;
      for (const report of result.reports) {
        expect(reportSchema.parse(report)).toEqual(report);
        expect(report).toMatchObject({ source: SOURCE_ID, origin: originOf(author), status: "actual", op: "alert", urgency: "past", certainty: "observed", observation: observation.id });
        expect(knownKind(report.kind.code)).toBe(true);
        expect(report.expires).toBe(report.sent + REPORT_LIFE_MS);
        expect(report.parameters["credit"]).toEqual([EMSC_CREDIT]);
        origins.add(report.origin);
      }
      // The reports come from the strongest band, so each disc holds the disc before it. The last band is the felt band.
      const radii = result.reports.map(radiusOf);
      expect([...radii].sort((a, b) => a - b)).toEqual(radii);
      expect(result.reports.at(-1)?.severity).toBe("minor");
      expect(new Set(result.reports.map((report) => report.key)).size).toBe(result.reports.length);
    }
    expect(origins).toEqual(new Set([ANSS_ORIGIN, EMSC_ORIGIN]));
  });

  it("maps the fields of one event: a disc for each band from the law of the point", () => {
    const reports = mapAll(PHILIPPINES);
    const law = lawAt([126.2, 9.7595]);
    const discs = bandDiscs(law, 5.5, 10);
    expect(reports.map((report) => [report.severity, report.areas])).toEqual(discs.map((disc) => [disc.severity, [{ type: "circle", center: [126.2, 9.7595], radiusKm: disc.radiusKm }]]));
    const time = Date.parse("2026-11-15T13:41:35.701Z");
    expect(reports[0]).toMatchObject({
      key: `20261115_0000145@${observationOf(PHILIPPINES).id}/${discs[0]?.severity}`,
      origin: ANSS_ORIGIN,
      correlation: [{ system: EVENT_SYSTEM, id: "20261115_0000145" }],
      kind: { code: EARTHQUAKE_KIND, label: "Earthquake" },
      categories: ["geo"],
      sent: time,
      onset: time,
      expires: time + REPORT_LIFE_MS,
      received: FETCHED,
      areaText: "MINDANAO, PHILIPPINES",
      sender: "NEIC",
      headline: "M 5.5 - MINDANAO, PHILIPPINES",
      web: `${EVENT_PAGE}20261115_0000145`,
      references: [],
      response: [],
      about: [],
    });
    expect(reports[0]?.parameters).toEqual({
      magnitude: ["5.5"],
      magnitudeType: ["mb"],
      depthKm: ["10"],
      strongestIntensity: [intensityAt(law, 5.5, 10).toFixed(1)],
      intensitySource: ["law"],
      intensityLaw: [law.id],
      bandIntensity: [String(discs[0]?.from)],
      bandRadiusKm: [String(discs[0]?.radiusKm)],
      author: ["NEIC"],
      catalog: ["EMSC-RTS"],
      credit: [EMSC_CREDIT],
    });
  });

  it("gives the origin of EMSC to the solution of an author outside the ANSS", () => {
    for (const report of mapAll(KAMCHATKA)) expect(report).toMatchObject({ origin: EMSC_ORIGIN, sender: "GSRAS" });
  });

  it("keeps the headline, the sender and the parameters with no region, no author, no catalog and no magnitude type", () => {
    const bare = withProperties(PHILIPPINES, { flynn_region: null, auth: null, source_catalog: "", magtype: null });
    const [report] = mapAll(bare);
    expect(report).toMatchObject({ headline: "M 5.5", sender: "EMSC", origin: EMSC_ORIGIN });
    expect(report?.areaText).toBeUndefined();
    expect(Object.keys(report?.parameters ?? {}).filter((name) => ["author", "catalog", "magnitudeType"].includes(name))).toEqual([]);
  });

  it("keeps one report of the felt band, with a disc of radius 0, for an event that the law does not give as felt", () => {
    const deep = withPoint(withProperties(ALASKA, { mag: 2.5, depth: 40 }), [-150, 61.2, -40]);
    const reports = mapAll(deep);
    expect(reports.map((report) => [report.severity, radiusOf(report), report.parameters["bandIntensity"]])).toEqual([["minor", 0, [String(FELT_INTENSITY)]]]);
  });

  it("reads the depth from the field depth, not from the third coordinate", () => {
    const shape = (reports: readonly Report[]) => reports.map((report) => [report.severity, report.areas, report.parameters]);
    expect(shape(mapAll(withPoint(PHILIPPINES, [126.2, 9.7595, -300])))).toEqual(shape(mapAll(withPoint(PHILIPPINES, [126.2, 9.7595]))));
    expect(shape(mapAll(PHILIPPINES))).toEqual(shape(mapAll(withPoint(PHILIPPINES, [126.2, 9.7595]))));
  });

  it("gives new reports for a new version of an event, in the same incident", () => {
    const one = mapAll(PHILIPPINES);
    const two = mapAll(withProperties(PHILIPPINES, { mag: 5.6, magtype: "mw" }));
    const ids = (reports: readonly Report[]): string[] => reports.map((report) => report.id);
    expect(ids(two).filter((id) => ids(one).includes(id))).toEqual([]);
    expect(incidents(normalize({ reports: [...one, ...two] }), FETCHED)).toHaveLength(1);
    // The time of the last change and the id of the database of EMSC are not in the body.
    expect(ids(mapAll(withProperties(PHILIPPINES, { lastupdate: "2026-11-16T00:00:00.0Z", source_id: "1" })))).toEqual(ids(one));
  });

  it("gives the certainty of the event type, and no report for an explosion or a landslide", () => {
    const certainties = (type: unknown): string[] => [...new Set(mapAll(withProperties(KAMCHATKA, { evtype: type })).map((report) => report.certainty))];
    for (const type of ["ke", "fe", "de", "ki", "kr"]) expect(certainties(type)).toEqual(["observed"]);
    for (const type of ["se", "si", "sr"]) expect(certainties(type)).toEqual(["likely"]);
    expect(certainties("uk")).toEqual(["unknown"]);
    for (const type of ["km", "sm", "kh", "sh", "kx", "sx", "kn", "sn", "ls"]) {
      expect(mapObservation(observationOf(withProperties(KAMCHATKA, { evtype: type })))).toEqual({ reports: [], problems: [] });
    }
  });

  it("gives a report with the certainty unknown and a lossy problem for an event type that is not known", () => {
    for (const type of ["zz", "constructor", "__proto__", null, 3]) {
      const result = mapObservation(observationOf(withProperties(KAMCHATKA, { evtype: type })));
      expect(result.reports.length).toBeGreaterThan(0);
      expect(new Set(result.reports.map((report) => report.certainty))).toEqual(new Set(["unknown"]));
      expect(result.problems).toEqual([{ path: "evtype", message: `the event type ${JSON.stringify(type)} is not known: the certainty is unknown`, fatal: false, lossy: true }]);
    }
  });

  it("gives a fatal problem and no report for an event with no id, time, magnitude, depth or point", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...ALASKA, id: "2026 1" }, "id"],
      [{ ...ALASKA, id: 7 }, "id"],
      [withProperties(ALASKA, { time: null }), "time"],
      [withProperties(ALASKA, { time: "2026-11-15T17:13:49" }), "time"],
      [withProperties(ALASKA, { mag: null }), "mag"],
      [withProperties(ALASKA, { depth: "9.4" }), "depth"],
      [withPoint(ALASKA, [200, 62.2, -9.4]), "coordinates"],
      [withPoint(ALASKA, [-149.461, 91]), "coordinates"],
      [withPoint(ALASKA, [-149.461]), "coordinates"],
      [{ ...ALASKA, geometry: null }, "coordinates"],
    ];
    for (const [feature, path] of cases) {
      const result = mapObservation(observationOf(feature));
      expect(result.reports).toEqual([]);
      expect(result.problems.map((problem) => [problem.path, problem.fatal])).toEqual([[path, true]]);
    }
  });

  it("gives a fatal problem for a body that is not JSON, or JSON that is not an event of the answer", () => {
    const body = (text: string): Observation => ({ ...observationOf(ALASKA), body: text });
    expect(mapObservation(body("{"))).toEqual({ reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] });
    expect(mapObservation(body(JSON.stringify({ error: "Service unavailable" }))).problems[0]?.message).toContain("format changed");
    expect(mapObservation(body("[1]")).problems[0]?.fatal).toBe(true);
    expect(mapObservation(body("null")).problems[0]?.fatal).toBe(true);
  });

  it("does not throw for each JSON body, and each report is valid", () => {
    fc.assert(
      fc.property(fc.json(), (text) => {
        const result = mapObservation({ ...observationOf(ALASKA), body: text });
        for (const report of result.reports) expect(reportSchema.parse(report)).toEqual(report);
        for (const problem of result.problems) expect(typeof problem.path).toBe("string");
      }),
    );
  });

  it("does not throw for each change of the fields of a real event, and each report is valid", () => {
    const value = fc.oneof(fc.constant(null), fc.string(), fc.double(), fc.integer(), fc.array(fc.double(), { maxLength: 4 }));
    const field = fc.constantFrom("time", "mag", "magtype", "flynn_region", "evtype", "auth", "source_catalog", "depth");
    fc.assert(
      fc.property(fc.dictionary(field, value), fc.option(fc.array(fc.double(), { maxLength: 4 })), (properties, point) => {
        const feature = withProperties(point === null ? ALASKA : withPoint(ALASKA, point), properties);
        const result = mapObservation(observationOf(feature));
        for (const report of result.reports) expect(reportSchema.parse(report)).toEqual(report);
        if (result.problems.some((problem) => problem.fatal)) expect(result.reports).toEqual([]);
      }),
    );
  });
});
