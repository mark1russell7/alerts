import { DEFAULT_LINK_POLICY, incidents, linkRule, normalize, observationId, type Observation, type Report, type SourceId } from "@mark1russell7/alerts";
import { GEOMAGNETIC_STORM_KIND, POLEWARD_BY_LEVEL, SEVERITY_BY_LEVEL } from "@mark1russell7/alerts-space-weather";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ALERT_SYSTEM,
  BOM_CREDIT,
  BOM_ORIGIN,
  BOM_SENDER,
  bomDate,
  bomTime,
  bomTimeText,
  DAY_MS,
  forecastLevel,
  isValidItem,
  mapObservation,
  METHODS,
  REGION,
  SOURCE_ID,
  WARNING_DAY_SYSTEM,
  WARNING_SYSTEM,
  type Method,
} from "./map.ts";

// The answers of these tests are made from the schema of the API documentation. They hold no text of BoM.
const BASE = "https://sws.bom.test/api/v1";

/** This function gives the observation of one item of an answer, as the fetch gives it. */
const observationOf = (method: Method, item: unknown, fetched: number): Observation => {
  const url = `${BASE}/${method}`;
  const body = JSON.stringify({ method, item });
  return { id: observationId({ source: SOURCE_ID, contentType: "application/json", url, body }), source: SOURCE_ID, fetched, contentType: "application/json", body, transport: { url, status: 200, latency: 1 } };
};

const at = (text: string): number => bomTime(text)!;

const ALERT = { start_time: "2026-11-17 08:45:00", valid_until: "2026-11-17 20:45:00", g_scale: 2, description: "major" };

const WARNING = {
  issue_time: "2026-11-17 23:18:00",
  start_date: "2026-11-18",
  end_date: "2026-11-20",
  cause: "coronal mass ejection",
  activity: [
    { date: "2026-11-18", forecast: "Unsettled to minor storm" },
    { date: "2026-11-19", forecast: "Quiet to unsettled" },
    { date: "2026-11-20", forecast: "Minor to major storm" },
  ],
  comments: "A test text of the forecaster.",
};

const reportsOf = (observations: readonly Observation[]): Report[] => observations.flatMap((observation) => mapObservation(observation).reports);

describe("mapObservation of a magnetic alert", () => {
  it("gives one observed report of the level G2, with the caps of the level, and no problem", () => {
    const fetched = at("2026-11-17 09:00:00");
    const result = mapObservation(observationOf(METHODS.alert, ALERT, fetched));
    expect(result.problems).toEqual([]);
    const [report] = result.reports;
    expect(report).toMatchObject({
      source: SOURCE_ID,
      origin: BOM_ORIGIN,
      references: [],
      correlation: [{ system: ALERT_SYSTEM, id: "2026-11-17 08:45:00" }],
      status: "actual",
      op: "alert",
      kind: { code: GEOMAGNETIC_STORM_KIND, label: "Geomagnetic storm" },
      categories: ["geo"],
      severity: SEVERITY_BY_LEVEL[2],
      urgency: "immediate",
      certainty: "observed",
      sent: fetched,
      received: fetched,
      onset: at("2026-11-17 08:45:00"),
      expires: at("2026-11-17 20:45:00"),
      areaText: `Poleward of ${POLEWARD_BY_LEVEL[2]} degrees geomagnetic latitude`,
      sender: BOM_SENDER,
      headline: `Geomagnetic storm G2: the magnetic alert of the ${REGION} since 08:45 UTC on 2026-11-17`,
      parameters: {
        scale: ["G2"],
        description: ["major"],
        start: ["2026-11-17 08:45:00"],
        validUntil: ["2026-11-17 20:45:00"],
        polewardOf: [String(POLEWARD_BY_LEVEL[2])],
        region: [REGION],
        credit: [BOM_CREDIT],
      },
    });
    expect(report?.areas.filter((area) => area.type === "circle")).toHaveLength(2);
    expect(report?.areas.at(-1)).toEqual({ type: "code", system: ALERT_SYSTEM, code: "2026-11-17 08:45:00", block: "caps" });
    expect(report?.key).toBe(`alert 2026-11-17 08:45:00@${report?.observation}`);
  });

  it("gives no problem for each description that agrees with its level, and a note for one that does not", () => {
    const fetched = at("2026-11-17 09:00:00");
    const pairs: [number, string][] = [
      [1, "minor"],
      [2, "major"],
      [3, "severe"],
      [4, "severe"],
      [5, "severe"],
    ];
    for (const [level, description] of pairs) {
      const result = mapObservation(observationOf(METHODS.alert, { ...ALERT, g_scale: level, description }, fetched));
      expect(result.problems, description).toEqual([]);
      expect(result.reports[0]?.severity).toBe(SEVERITY_BY_LEVEL[level]);
    }
    const odd = mapObservation(observationOf(METHODS.alert, { ...ALERT, g_scale: 1, description: "severe" }, fetched));
    expect(odd.problems.map((problem) => [problem.path, problem.fatal, problem.lossy])).toEqual([["description", false, undefined]]);
    expect(odd.reports[0]?.parameters["scale"]).toEqual(["G1"]);
  });

  it("gives a fatal problem and no report for a level that is not an integer from 1 to 5", () => {
    for (const g_scale of [0, 6, 1.5, "2", null]) {
      const result = mapObservation(observationOf(METHODS.alert, { ...ALERT, g_scale }, 0));
      expect(result.reports, String(g_scale)).toEqual([]);
      expect(result.problems.map((problem) => [problem.path, problem.fatal])).toEqual([["g_scale", true]]);
    }
  });

  it("gives a lossy problem for a start or an end that is not a time, and the urgency past after the end", () => {
    const fetched = at("2026-11-17 09:00:00");
    // The example of the documentation has the start "2015-02-07 08:45:", with no seconds.
    const noStart = mapObservation(observationOf(METHODS.alert, { ...ALERT, start_time: "2026-11-17 08:45:" }, fetched));
    expect(noStart.problems.map((problem) => [problem.path, problem.lossy])).toEqual([["start_time", true]]);
    expect(noStart.reports[0]).toMatchObject({ onset: fetched, correlation: [{ system: ALERT_SYSTEM, id: "fetched 2026-11-17 09:00:00" }] });
    expect(noStart.reports[0]?.parameters["start"]).toBeUndefined();
    const noEnd = mapObservation(observationOf(METHODS.alert, { ...ALERT, valid_until: "soon" }, fetched));
    expect(noEnd.problems.map((problem) => [problem.path, problem.lossy])).toEqual([["valid_until", true]]);
    expect(noEnd.reports[0]?.expires).toBeUndefined();
    const late = mapObservation(observationOf(METHODS.alert, ALERT, at("2026-11-17 21:00:00")));
    expect(late.reports[0]?.urgency).toBe("past");
  });

  it("replaces an alert with the changed alert of the same start, by the rule of the copies", () => {
    const first = observationOf(METHODS.alert, { ...ALERT, g_scale: 3, description: "severe" }, at("2026-11-17 09:00:00"));
    const later = observationOf(METHODS.alert, { ...ALERT, g_scale: 1, description: "minor" }, at("2026-11-17 09:10:00"));
    const reports = reportsOf([first, later]);
    expect(new Set(reports.map((report) => report.id)).size).toBe(2);
    const found = incidents(normalize({ reports }), at("2026-11-17 09:20:00"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: SEVERITY_BY_LEVEL[1], live: true });
  });

  it("links with the report of a second origin of the storm, by the link rule of the runtime", () => {
    const [bom] = reportsOf([observationOf(METHODS.alert, ALERT, at("2026-11-17 09:00:00"))]);
    const other: Report = { ...bom!, id: "r-other" as never, source: "other" as SourceId, origin: "other", key: "other", correlation: [], areas: bom!.areas.slice(0, 2), onset: at("2026-11-17 09:00:00") };
    const state = normalize({ reports: [bom!, other] });
    expect(incidents(state, at("2026-11-17 09:20:00"))).toHaveLength(2);
    expect(incidents(state, at("2026-11-17 09:20:00"), { link: linkRule(DEFAULT_LINK_POLICY) })).toHaveLength(1);
  });
});

describe("mapObservation of a geophysical warning", () => {
  it("gives one likely report for each day of a storm, with the level of its forecast, and no problem", () => {
    const fetched = at("2026-11-17 23:30:00");
    const result = mapObservation(observationOf(METHODS.warning, WARNING, fetched));
    expect(result.problems).toEqual([]);
    expect(result.reports.map((report) => [report.parameters["day"]?.[0], report.parameters["scale"]?.[0], report.severity])).toEqual([
      ["2026-11-18", "G1", SEVERITY_BY_LEVEL[1]],
      ["2026-11-20", "G2", SEVERITY_BY_LEVEL[2]],
    ]);
    expect(result.reports[0]).toMatchObject({
      origin: BOM_ORIGIN,
      correlation: [
        { system: WARNING_SYSTEM, id: "2026-11-17 23:18:00" },
        { system: WARNING_DAY_SYSTEM, id: "2026-11-18" },
      ],
      urgency: "future",
      certainty: "likely",
      sent: at("2026-11-17 23:18:00"),
      onset: bomDate("2026-11-18"),
      expires: bomDate("2026-11-18")! + DAY_MS,
      headline: `Geomagnetic storm G1 likely on 2026-11-18 in the ${REGION}: Unsettled to minor storm`,
      parameters: { forecast: ["Unsettled to minor storm"], warning: ["2026-11-17 23:18:00"], cause: ["coronal mass ejection"], credit: [BOM_CREDIT] },
    });
    expect(result.reports[0]?.areas.at(-1)).toEqual({ type: "code", system: WARNING_DAY_SYSTEM, code: "2026-11-18", block: "caps" });
    // The comments of the forecaster stay out of each report.
    expect(JSON.stringify(result.reports)).not.toContain("forecaster");
  });

  it("gives the urgency expected for the day of the fetch", () => {
    const [report] = mapObservation(observationOf(METHODS.warning, WARNING, at("2026-11-18 06:00:00"))).reports;
    expect(report?.urgency).toBe("expected");
  });

  it("replaces the forecast of a day with the forecast of a later warning, by the rule of the copies", () => {
    const first = observationOf(METHODS.warning, { ...WARNING, activity: [{ date: "2026-11-18", forecast: "Major storm" }] }, at("2026-11-17 23:30:00"));
    const later = observationOf(METHODS.warning, { ...WARNING, issue_time: "2026-11-18 03:00:00", activity: [{ date: "2026-11-18", forecast: "Active to minor storm" }] }, at("2026-11-18 03:10:00"));
    const found = incidents(normalize({ reports: reportsOf([first, later]) }), at("2026-11-18 03:20:00"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: SEVERITY_BY_LEVEL[1], live: true });
  });

  it("gives a lossy problem for a day with no date or an unknown forecast, and a fatal problem for a warning with no issue or no days", () => {
    const days = [{ forecast: "Minor storm" }, { date: "2026-11-19", forecast: "Storm levels" }, { date: "2026-11-20", forecast: "G2 expected" }];
    const result = mapObservation(observationOf(METHODS.warning, { ...WARNING, activity: days }, 0));
    expect(result.problems.map((problem) => [problem.path, problem.lossy])).toEqual([
      ["activity[0]", true],
      ["activity[1].forecast", true],
      ["activity[2].forecast", true],
    ]);
    expect(result.reports.map((report) => [report.parameters["day"]?.[0], report.parameters["scale"]?.[0]])).toEqual([["2026-11-19", "G1"]]);
    const fatal = (item: unknown) => mapObservation(observationOf(METHODS.warning, item, 0)).problems.map((problem) => [problem.path, problem.fatal]);
    expect(fatal({ ...WARNING, issue_time: "2026-11-17" })).toEqual([["issue_time", true]]);
    expect(fatal({ ...WARNING, activity: "none" })).toEqual([["activity", true]]);
  });
});

describe("mapObservation of the K index and of other bodies", () => {
  it("gives no report and no problem for the K index", () => {
    expect(mapObservation(observationOf(METHODS.kIndex, { index: 3, valid_time: "2026-11-17 18:00:00", analysis_time: "2026-11-17 19:59:33" }, 0))).toEqual({ reports: [], problems: [] });
  });

  it("gives a fatal problem for a body that is not one item of a known method", () => {
    const fatal = (body: string) => mapObservation({ ...observationOf(METHODS.alert, ALERT, 0), body }).problems.map((problem) => [problem.path, problem.fatal]);
    for (const body of ["{", JSON.stringify({ data: [] }), JSON.stringify({ method: "get-aurora-alert", item: {} }), JSON.stringify({ method: METHODS.alert, item: [1] })]) {
      expect(fatal(body), body).toEqual([["", true]]);
    }
  });

  it("gives the same reports with the same ids for the same observation", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 100_000 }), (level, hours) => {
        const fetched = at("2026-01-01 00:00:00") + hours * 3_600_000;
        const observation = observationOf(METHODS.alert, { ...ALERT, start_time: bomTimeText(fetched - 600_000), g_scale: level }, fetched);
        const once = mapObservation(observation);
        expect(mapObservation(observation)).toEqual(once);
        expect(once.reports.length).toBe(level >= 1 && level <= 5 ? 1 : 0);
      }),
    );
  });
});

describe("forecastLevel", () => {
  it("gives the highest storm that a forecast names, and tells of a text with no known word", () => {
    const cases: [string, number, boolean][] = [
      ["Quiet", 0, false],
      ["Unsettled to active", 0, false],
      ["Active to minor storm", 1, false],
      ["Minor storm", 1, false],
      ["Minor storm, chance of major storm periods", 2, false],
      ["Major storms", 2, false],
      ["Severe storm", 3, false],
      ["Storm levels", 1, true],
      ["G2 expected", 0, true],
    ];
    expect(cases.map(([text]) => [text, forecastLevel(text).level, forecastLevel(text).unknown])).toEqual(cases);
  });
});

describe("bomTime and bomDate", () => {
  it("read only a UTC time or date of the format of the API", () => {
    expect(bomTime("2026-11-17 18:00:00")).toBe(Date.parse("2026-11-17T18:00:00Z"));
    expect(bomDate("2026-11-18")).toBe(Date.parse("2026-11-18T00:00:00Z"));
    for (const text of ["2026-11-17T18:00:00Z", "2026-11-17 18:00", "2026-11-31 00:00:00", "2026-11-17 24:00:00", 1, null]) expect(bomTime(text), String(text)).toBeUndefined();
    for (const text of ["2026-11-31", "2026-11-18 00:00:00", "18 Nov"]) expect(bomDate(text), text).toBeUndefined();
    expect(bomTimeText(Date.parse("2026-11-17T18:00:00Z"))).toBe("2026-11-17 18:00:00");
  });
});

describe("isValidItem", () => {
  it("tells if an item has the facts of its map", () => {
    expect(isValidItem(METHODS.alert, ALERT)).toBe(true);
    expect(isValidItem(METHODS.alert, { ...ALERT, g_scale: 0 })).toBe(false);
    expect(isValidItem(METHODS.warning, WARNING)).toBe(true);
    expect(isValidItem(METHODS.warning, { ...WARNING, activity: undefined })).toBe(false);
    expect(isValidItem(METHODS.kIndex, { index: 1, valid_time: "2026-11-17 18:00:00" })).toBe(true);
    expect(isValidItem(METHODS.kIndex, { index: "1", valid_time: "2026-11-17 18:00:00" })).toBe(false);
  });
});
