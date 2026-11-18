import { readFileSync } from "node:fs";
import { categoryOf, knownKind, type Observation, type ObservationId } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { entryBody } from "./fetch.ts";
import { CVE_SYSTEM, dateStart, dueEnd, EXPLOITED_KIND, HEAD_FIELDS, isCveId, isHead, KEV_LICENSE, KEV_ORIGIN, mapObservation, severityOf, SOURCE_ID } from "./map.ts";

/** The real catalog, with 10 of its entries (`fixtures/README.md`). */
const CATALOG = JSON.parse(readFileSync(new URL("../fixtures/kev-20261117.json", import.meta.url), "utf8")) as { vulnerabilities: Record<string, unknown>[] } & Record<string, unknown>;
const FETCHED = Date.parse("2026-11-18T04:02:53Z");
const entry = (cve: string): Record<string, unknown> => CATALOG.vulnerabilities.find((each) => each["cveID"] === cve)!;
const observationOf = (body: string, fetched = FETCHED): Observation => ({ id: `o-${body.length}` as ObservationId, source: SOURCE_ID, fetched, contentType: "application/json", body, transport: { latency: 0 } });

describe("the dates of the catalog", () => {
  it("reads a date at 00:00 UTC, and the end of a due date at 00:00 UTC of the next day", () => {
    expect(dateStart("2026-11-17")).toBe(Date.parse("2026-11-17T00:00:00Z"));
    expect(dueEnd("2026-12-01")).toBe(Date.parse("2026-12-02T00:00:00Z"));
    expect(dueEnd("2026-12-31")).toBe(Date.parse("2027-01-01T00:00:00Z"));
  });

  it("refuses a value that is not a date of the calendar", () => {
    for (const value of ["2026-11-31", "2026-02-29", "2026-1-17", "2026-11-17T00:00:00Z", "", 20261117, null, undefined]) expect(dateStart(value), String(value)).toBeUndefined();
    expect(dateStart("2028-02-29")).toBe(Date.parse("2028-02-29T00:00:00Z"));
  });

  it("gives a due end one day after the start of each valid date", () => {
    fc.assert(
      fc.property(fc.date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2099-12-31T00:00:00Z"), noInvalidDate: true }), (date) => {
        const text = date.toISOString().slice(0, 10);
        expect(dueEnd(text)! - dateStart(text)!).toBe(86_400_000);
      }),
    );
  });
});

describe("isCveId", () => {
  it("accepts the ids of the catalog, and refuses each other text", () => {
    for (const each of CATALOG.vulnerabilities) expect(isCveId(each["cveID"])).toBe(true);
    for (const value of ["CVE-2026-123", "cve-2026-1234", "CVE-26-1234", " CVE-2026-1234", "CVE-2026-1234 ", 7]) expect(isCveId(value), String(value)).toBe(false);
  });
});

describe("mapObservation", () => {
  it("gives one report of an exploited flaw for an entry, with the CVE id as subject, correlation key and key", () => {
    const { reports, problems } = mapObservation(observationOf(entryBody(entry("CVE-2026-115731"))));
    expect(problems).toEqual([]);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report).toMatchObject({
      source: SOURCE_ID,
      origin: KEV_ORIGIN,
      key: "CVE-2026-115731",
      references: [],
      correlation: [{ system: CVE_SYSTEM, id: "CVE-2026-115731" }],
      status: "actual",
      op: "alert",
      kind: { code: EXPLOITED_KIND },
      categories: [categoryOf(EXPLOITED_KIND)],
      severity: "moderate",
      urgency: "immediate",
      certainty: "observed",
      response: ["execute"],
      sent: FETCHED,
      received: FETCHED,
      effective: Date.parse("2026-11-17T00:00:00Z"),
      expires: Date.parse("2026-12-02T00:00:00Z"),
      areas: [],
      about: [{ system: CVE_SYSTEM, id: "CVE-2026-115731", label: "Perforce Puppet Enterprise" }],
      web: "https://nvd.nist.gov/vuln/detail/CVE-2026-115731",
    });
    expect(report.headline).toBe("CVE-2026-115731: Perforce Puppet Enterprise Deserialization of Untrusted Data Vulnerability");
    expect(report.description).toMatch(/^Perforce Puppet Enterprise contains a deserialization/);
    expect(report.instruction).toMatch(/ Due date: 2026-12-01\.$/);
    expect(report.parameters).toMatchObject({ vendor: ["Perforce"], dueDate: ["2026-12-01"], cwe: ["CWE-502", "CWE-94"], license: [KEV_LICENSE] });
    expect(report.parameters["notes"]?.length).toBeGreaterThan(1);
    expect(knownKind(report.kind.code)).toBe(true);
  });

  it("gives the severity severe for a flaw of ransomware or a flaw with a forensic triage, and moderate for each other", () => {
    expect(severityOf(entry("CVE-2026-59310"))).toBe("severe");
    expect(severityOf(entry("CVE-2026-114713"))).toBe("severe");
    expect(severityOf(entry("CVE-2021-43890"))).toBe("severe");
    expect(severityOf(entry("CVE-2026-124194"))).toBe("moderate");
    expect(mapObservation(observationOf(entryBody(entry("CVE-2026-59310")))).reports[0]?.severity).toBe("severe");
  });

  it("gives the urgency past for an entry whose due date ended before the fetch", () => {
    const report = mapObservation(observationOf(entryBody(entry("CVE-2021-43890")))).reports[0]!;
    expect(report.urgency).toBe("past");
    expect(report.expires).toBe(Date.parse("2021-12-30T00:00:00Z"));
  });

  it("gives one report for each entry of the fixture, and the same report for the same observation", () => {
    for (const each of CATALOG.vulnerabilities) {
      const observation = observationOf(entryBody(each));
      const first = mapObservation(observation);
      expect(first.problems, String(each["cveID"])).toEqual([]);
      expect(first.reports).toHaveLength(1);
      expect(mapObservation(observation)).toEqual(first);
    }
  });

  it("gives no report and no problem for the head of the catalog", () => {
    const head = JSON.stringify(Object.fromEntries(HEAD_FIELDS.map((field) => [field, CATALOG[field]])));
    expect(isHead(JSON.parse(head) as Record<string, unknown>)).toBe(true);
    expect(mapObservation(observationOf(head))).toEqual({ reports: [], problems: [] });
  });

  it("gives a fatal problem for the whole answer when the answer is not the catalog", () => {
    const whole = JSON.stringify({ ...CATALOG, vulnerabilities: "moved" });
    expect(isHead(JSON.parse(whole) as Record<string, unknown>)).toBe(false);
    const { reports, problems } = mapObservation(observationOf(whole));
    expect(reports).toEqual([]);
    expect(problems).toEqual([{ path: "", message: "the observation is not one entry of the catalog of CISA: the format changed", fatal: true }]);
    expect(mapObservation(observationOf("<html>")).problems[0]).toMatchObject({ message: "the body is not JSON", fatal: true });
  });

  it("gives a fatal problem and no report for an entry with a bad id, name or date", () => {
    const base = entry("CVE-2026-124194");
    for (const [field, value] of [
      ["cveID", "CVE-26-1"],
      ["vulnerabilityName", 7],
      ["dateAdded", "2026-11-31"],
      ["dueDate", ""],
    ] as const) {
      const { reports, problems } = mapObservation(observationOf(entryBody({ ...base, [field]: value })));
      expect(reports, field).toEqual([]);
      expect(problems.map((problem) => [problem.path, problem.fatal]), field).toEqual([[field, true]]);
    }
  });

  it("leaves out the parameters and the texts that an entry does not give", () => {
    const base = entry("CVE-2026-124194");
    const report = mapObservation(observationOf(entryBody({ ...base, notes: "", cwes: [], shortDescription: " ", requiredAction: "", vendorProject: "", product: "" }))).reports[0]!;
    expect(report.parameters["notes"]).toBeUndefined();
    expect(report.parameters["cwe"]).toBeUndefined();
    expect(report.parameters["vendor"]).toBeUndefined();
    expect(report.description).toBeUndefined();
    expect(report.instruction).toBeUndefined();
    expect(report.about).toEqual([{ system: CVE_SYSTEM, id: "CVE-2026-124194" }]);
  });

  it("does not throw for any JSON body", () => {
    fc.assert(
      fc.property(fc.json(), (body) => {
        const result = mapObservation(observationOf(body));
        expect(Array.isArray(result.reports)).toBe(true);
      }),
    );
  });
});
