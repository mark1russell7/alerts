import { readFileSync } from "node:fs";
import { knownKind, Problems, type Observation, type ObservationId, type Report, type SourceId } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGES } from "./info.ts";
import { codedKind, METEOALARM_KINDS, meteoalarmTypeName, OET_KINDS, OET_VERSION } from "./kinds.ts";
import { readCap, type CapPair } from "./read.ts";
import { capReports, type CapReportOptions } from "./report.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/hub/${name}`, import.meta.url), "utf8");
const SOURCE = "test-cap" as SourceId;
const OPTIONS: CapReportOptions = { source: SOURCE, origin: "test-authority", keyed: false, languages: DEFAULT_LANGUAGES };

const pair = (valueName: string, value: string): CapPair => ({ valueName, value });
const oet = (value: string, valueName = OET_VERSION): CapPair => pair(valueName, value);

/** This function maps one CAP text, and gives the reports and the problems. */
function mapText(body: string): { reports: Report[]; problems: Problems } {
  const read = readCap(body);
  if (!read.ok) throw new Error(`the test message is not CAP: ${read.reason}`);
  const observation: Observation = {
    id: "observation-1" as ObservationId,
    source: SOURCE,
    fetched: Date.parse("2026-11-16T12:00:00Z"),
    contentType: "application/xml",
    body,
    transport: { url: "https://cap.test/feed", status: 200, latency: 0 },
  };
  const problems = new Problems();
  return { reports: capReports(read.alert, observation, OPTIONS, problems), problems };
}

/** A made-up message of one block with the category, the event and the event codes and parameters. */
function messageText(category: string, event: string, codes: readonly CapPair[], parameters: readonly CapPair[] = []): string {
  const pairs = (element: string, list: readonly CapPair[]) =>
    list.map((one) => `<${element}><valueName>${one.valueName}</valueName><value>${one.value}</value></${element}>`).join("");
  return (
    `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>TEST-1</identifier><sender>alerts@example.org</sender>` +
    `<sent>2026-11-16T10:00:00Z</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope>` +
    `<info><category>${category}</category><event>${event}</event>${pairs("eventCode", codes)}<urgency>Expected</urgency>` +
    `<severity>Moderate</severity><certainty>Likely</certainty>${pairs("parameter", parameters)}` +
    `<area><areaDesc>Area</areaDesc><circle>10,20 5</circle></area></info></alert>`
  );
}

describe("the tables of the kinds", () => {
  it("have one entry for each term of the OASIS list 1.2, and each code is in the taxonomy", () => {
    const codes = Array.from({ length: 224 }, (_, index) => `OET-${String(index).padStart(3, "0")}`);
    expect(Object.keys(OET_KINDS)).toEqual(codes);
    for (const code of Object.values(OET_KINDS)) if (code !== null) expect(knownKind(code), code).toBe(true);
    // Only the terms that name no hazard leave the kind to the category.
    expect(Object.entries(OET_KINDS).flatMap(([term, code]) => (code === null ? [term] : []))).toEqual(["OET-000", "OET-002", "OET-135", "OET-147", "OET-213"]);
  });

  it("give a code of the taxonomy for each awareness type of MeteoAlarm", () => {
    for (const code of Object.values(METEOALARM_KINDS)) expect(knownKind(code), code).toBe(true);
    expect(meteoalarmTypeName("10; rain")).toBe("rain");
    expect(meteoalarmTypeName(" 6; Low-Temperature ")).toBe("low-temperature");
    expect(meteoalarmTypeName("wind")).toBe("wind");
  });
});

describe("codedKind", () => {
  it("reads the kind from an OASIS code of version 1.2, and ignores the codes of other systems", () => {
    expect(codedKind({ eventCodes: [pair("SAME", "TOR"), oet("OET-218")], parameters: [] })).toEqual({ kind: { code: "met.wind", from: "OET:v1.2 OET-218" }, unknown: [] });
    expect(codedKind({ eventCodes: [oet(" oet-159 ")], parameters: [] }).kind?.code).toBe("met.rain");
    expect(codedKind({ eventCodes: [pair("SAME", "TOR"), pair("NWS", "TOW")], parameters: [] })).toEqual({ unknown: [] });
  });

  it("gives each OASIS code that the table does not know, and each code of another version of the list", () => {
    expect(codedKind({ eventCodes: [oet("OET-999"), oet("OET-537", "OET:v1.0"), oet("OET-194")], parameters: [] })).toEqual({
      kind: { code: "met.thunderstorm", from: "OET:v1.2 OET-194" },
      unknown: ["OET:v1.2 OET-999", "OET:v1.0 OET-537"],
    });
  });

  it("goes on to the next code when a term names no hazard", () => {
    expect(codedKind({ eventCodes: [oet("OET-000"), oet("OET-082")], parameters: [] }).kind?.code).toBe("met.fog");
    expect(codedKind({ eventCodes: [oet("OET-147")], parameters: [] })).toEqual({ unknown: [] });
  });

  it("reads the awareness type of MeteoAlarm, after the OASIS codes", () => {
    const parameters = [pair("awareness_level", "2; yellow; Moderate"), pair("awareness_type", "6; low-temperature")];
    expect(codedKind({ eventCodes: [], parameters })).toEqual({ kind: { code: "met.cold", from: "awareness_type 6; low-temperature" }, unknown: [] });
    expect(codedKind({ eventCodes: [oet("OET-091")], parameters }).kind?.code).toBe("met.frost");
    expect(codedKind({ eventCodes: [], parameters: [pair("awareness_type", "11; unknown")] })).toEqual({ unknown: ["awareness_type 11; unknown"] });
  });

  it("gives a code of the taxonomy or no kind for any event codes and parameters", () => {
    const text = fc.oneof(fc.string(), fc.constantFrom(...Object.keys(OET_KINDS)), fc.constantFrom(...Object.keys(METEOALARM_KINDS)));
    const name = fc.oneof(fc.string(), fc.constantFrom(OET_VERSION, "OET:v1.0", "awareness_type", "SAME"));
    const pairs = fc.array(fc.record({ valueName: name, value: text }), { maxLength: 4 });
    fc.assert(
      fc.property(pairs, pairs, (eventCodes, parameters) => {
        const { kind } = codedKind({ eventCodes, parameters });
        expect(kind === undefined || knownKind(kind.code)).toBe(true);
      }),
    );
  });
});

describe("the kind of a report of any alerting authority", () => {
  it("maps the real wind warning of the hub to the kind of its OASIS code, with its circle", () => {
    const { reports, problems } = mapText(fixture("oet-wind.xml"));
    expect(problems.list).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      key: "urn:oid:2.49.0.1.570.0.2026.10.23.0.31.33",
      op: "update",
      kind: { code: "met.wind", label: "Strong Winds" },
      categories: ["met"],
      sender: "Niue Meteorological Service",
      areaText: "Niue Island",
    });
    expect(reports[0]?.kind).not.toHaveProperty("significance");
    expect(reports[0]?.areas).toEqual([expect.objectContaining({ type: "circle" })]);
  });

  it("maps the real thunderstorm warning of the hub to the kind of its OASIS code, with its polygon", () => {
    const { reports, problems } = mapText(fixture("oet-thunderstorm.xml"));
    expect(problems.list).toEqual([]);
    expect(reports[0]).toMatchObject({ kind: { code: "met.thunderstorm", label: "thunderstorm" }, categories: ["met"], severity: expect.any(String) });
    expect(reports[0]?.areas).toEqual([expect.objectContaining({ type: "polygon" })]);
  });

  it("gives the kind of the CAP category when no table knows the event, with a lossy problem", () => {
    const { reports, problems } = mapText(messageText("Geo", "Erdrutsch", []));
    expect(reports[0]?.kind).toEqual({ code: "geo", label: "Erdrutsch" });
    expect(problems.list).toEqual([expect.objectContaining({ path: "info[0].event", lossy: true, message:'the kind tables do not know the event "Erdrutsch": the report has the kind of its category, geo' })]);
  });

  it("keeps the unknown kind for the category Other", () => {
    const { reports, problems } = mapText(messageText("Other", "Something", []));
    expect(reports[0]?.kind.code).toBe("other.unknown");
    expect(problems.list).toEqual([expect.objectContaining({ path: "info[0].event", message: 'the kind tables do not know the event "Something"' })]);
  });

  it("takes the OASIS code before the NWS tables, and tells an unknown code as a lossy problem", () => {
    const { reports, problems } = mapText(messageText("Met", "Tornado Warning", [oet("OET-218"), oet("OET-999")]));
    expect(reports[0]?.kind).toEqual({ code: "met.wind", label: "Tornado Warning" });
    expect(problems.list).toEqual([expect.objectContaining({ path: "info[0].eventCode", message: 'the kind tables do not know the event code "OET:v1.2 OET-999"' })]);
  });

  it("reads the awareness type of a message in the CAP profile of MeteoAlarm", () => {
    const { reports, problems } = mapText(messageText("Met", "FROST", [], [pair("awareness_type", "6; low-temperature")]));
    expect(reports[0]?.kind).toEqual({ code: "met.cold", label: "FROST" });
    expect(problems.list).toEqual([]);
  });
});
