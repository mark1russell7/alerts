import { readdirSync, readFileSync } from "node:fs";
import type { Observation, ObservationId, Report } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PHENOMENA } from "./kinds.ts";
import { mapObservation, SOURCE_ID } from "./map.ts";
import { mainVtec, parseVtec, vtecKey, type Vtec } from "./vtec.ts";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const NAMES = readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));
const text = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");
const feature = (name: string): any => JSON.parse(text(name));
const FETCHED = Date.parse("2026-11-15T00:00:00Z");

const observe = (body: string): Observation => ({
  id: `observation-${String(body.length)}` as ObservationId,
  source: SOURCE_ID,
  fetched: FETCHED,
  contentType: "application/geo+json",
  body,
  transport: { latency: 0 },
});

const mapOne = async (body: unknown): Promise<{ report: Report | undefined; problems: readonly { path: string; message: string; fatal: boolean }[] }> => {
  const result = await mapObservation(observe(typeof body === "string" ? body : JSON.stringify(body)));
  return { report: result.reports[0], problems: result.problems };
};

/** The kind code that each fixture has: its file name is the NWS event code. */
const EXPECTED_KIND: Readonly<Record<string, string>> = {
  "nws-bzw.json": "met.winter.blizzard",
  "nws-cfs.json": "met.flood.coastal",
  "nws-faa.json": "met.flood.areal",
  "nws-faw.json": "met.flood.areal",
  "nws-flw.json": "met.flood.river",
  "nws-fzw.json": "met.freeze",
  "nws-glw.json": "met.marine.gale",
  "nws-hwa.json": "met.wind.high",
  "nws-keepalive.json": "system.test",
  "nws-scy.json": "met.marine.small-craft",
  "nws-sps.json": "met.special",
  "nws-srw.json": "met.marine.storm",
  "nws-upw.json": "met.marine.freezing-spray.heavy",
  "nws-wwy.json": "met.winter.weather",
};

describe("the map of the recorded alerts", () => {
  it("has a fixture for each expected kind", () => {
    expect(NAMES.sort()).toEqual(Object.keys(EXPECTED_KIND).sort());
  });

  it.each(NAMES)("maps %s to one report with no problem", async (name) => {
    const source = feature(name);
    const properties = source.properties;
    const { report, problems } = await mapOne(source);
    expect(problems).toEqual([]);
    expect(report).toBeDefined();
    if (report === undefined) return;

    expect(report.kind.code).toBe(EXPECTED_KIND[name]);
    expect(report.kind.label).toBe(properties.event);
    expect(report.key).toBe(properties.id);
    expect(report.source).toBe(SOURCE_ID);
    expect(report.op).toBe(properties.messageType.toLowerCase());
    expect(report.status).toBe(properties.status.toLowerCase());
    expect(report.severity).toBe(properties.severity.toLowerCase());
    expect(report.sent).toBe(Date.parse(properties.sent));
    expect(report.received).toBe(FETCHED);
    expect(report.headline).toBe(properties.headline ?? properties.parameters.NWSheadline?.[0] ?? properties.event);
    expect(report.sender).toBe(properties.senderName);
    expect(report.areaText).toBe(properties.areaDesc);

    const references = (properties.references as { identifier: string }[]).map((reference) => reference.identifier);
    for (const reference of references) expect(report.references).toContain(reference);
    expect(report.references).not.toContain(report.key);

    for (const ugc of properties.geocode.UGC) expect(report.areas).toContainEqual({ type: "code", system: "ugc", code: ugc });
    for (const same of properties.geocode.SAME) expect(report.areas).toContainEqual({ type: "code", system: "same", code: same });
    expect(report.areas.some((area) => area.type === "polygon")).toBe(source.geometry !== null);

    const vtec = ((properties.parameters.VTEC ?? []) as string[]).map((one) => parseVtec(one)).filter((one): one is Vtec => one !== undefined);
    const main = mainVtec(vtec);
    if (main === undefined) {
      expect(report.correlation).toEqual([]);
    } else {
      expect(PHENOMENA[main.phenomenon]?.code).toBe(report.kind.code);
      expect(report.correlation).toContainEqual(vtecKey(main, report.sent));
    }
  });

  it.each(NAMES)("gives the same reports for %s each time", async (name) => {
    expect(await mapObservation(observe(text(name)))).toEqual(await mapObservation(observe(text(name))));
  });

  it("marks the keepalive as a test", async () => {
    const { report } = await mapOne(feature("nws-keepalive.json"));
    expect(report?.status).toBe("test");
    expect(report?.categories).toEqual(["met"]);
  });

  it("maps each alert of a feature collection, with the path of each problem", async () => {
    const good = feature("nws-flw.json");
    const bad = { ...feature("nws-glw.json"), properties: { ...feature("nws-glw.json").properties, id: undefined } };
    const result = await mapObservation(observe(JSON.stringify({ type: "FeatureCollection", features: [good, bad] })));
    expect(result.reports.map((report) => report.key)).toEqual([good.properties.id]);
    expect(result.problems).toEqual([{ path: "features[1].properties.id", message: "the alert has no identifier", fatal: true }]);
  });
});

describe("the map of broken alerts", () => {
  const base = feature("nws-flw.json");
  const withProperties = (change: Record<string, unknown>): unknown => ({ ...base, properties: { ...base.properties, ...change } });

  it("gives a fatal problem for a body that is not JSON or not a feature", async () => {
    expect(await mapOne("<html>")).toEqual({ report: undefined, problems: [{ path: "", message: "the body is not JSON", fatal: true }] });
    expect((await mapOne({ type: "Point" })).problems[0]?.fatal).toBe(true);
    expect((await mapOne({ type: "Feature" })).problems[0]).toMatchObject({ path: "properties", fatal: true });
  });

  it("gives a fatal problem for an alert with no valid sent time", async () => {
    const { report, problems } = await mapOne(withProperties({ sent: "yesterday" }));
    expect(report).toBeUndefined();
    expect(problems.filter((problem) => problem.fatal)).toEqual([
      { path: "properties.sent", message: "the alert has no valid sent time", fatal: true },
    ]);
  });

  it("gives no report and no problem for an acknowledgment", async () => {
    expect(await mapOne(withProperties({ messageType: "Ack" }))).toEqual({ report: undefined, problems: [] });
  });

  it("keeps a report with a problem for an unknown value or field", async () => {
    const { report, problems } = await mapOne(withProperties({ severity: "Catastrophic", status: "Rehearsal", colour: "red" }));
    expect(report?.severity).toBe("unknown");
    expect(report?.status).toBe("actual");
    expect(problems.map((problem) => problem.path).sort()).toEqual(["properties.colour", "properties.severity", "properties.status"]);
    expect(problems.every((problem) => !problem.fatal)).toBe(true);
  });

  it("keeps the label of an unknown event and says so", async () => {
    const { report, problems } = await mapOne(
      withProperties({ event: "Volcanic Haze Notice", eventCode: { SAME: ["NWS"], NationalWeatherService: ["VHN"] }, parameters: {} }),
    );
    expect(report?.kind).toEqual({ code: "other.unknown", label: "Volcanic Haze Notice" });
    expect(problems).toContainEqual({ path: "properties.event", message: 'the kind tables do not know the event "Volcanic Haze Notice"', fatal: false });
  });

  it("closes an open ring, and drops a polygon with a bad outside ring", async () => {
    const open = { ...base, geometry: { type: "Polygon", coordinates: [[[-98, 28], [-97, 28], [-97, 29]]] } };
    const closed = await mapOne(open);
    expect(closed.report?.areas).toContainEqual({ type: "polygon", rings: [[[-98, 28], [-97, 28], [-97, 29], [-98, 28]]] });
    expect(closed.problems.map((problem) => problem.path)).toEqual(["geometry.coordinates[0]"]);

    const broken = await mapOne({ ...base, geometry: { type: "Polygon", coordinates: [[[-98, 28], [-97, 200], [-97, 29]]] } });
    expect(broken.report?.areas.some((area) => area.type === "polygon")).toBe(false);
    expect(broken.problems[0]?.fatal).toBe(false);
  });

  it("reads the expired references of the NWS", async () => {
    const { report } = await mapOne(
      withProperties({ parameters: { ...base.properties.parameters, expiredReferences: ["w-nws.webmaster@noaa.gov,urn:oid:old.1,2026-11-14T01:00:00-06:00 w-nws.webmaster@noaa.gov,urn:oid:old.2,2026-11-14T02:00:00-06:00"] } }),
    );
    expect(report?.references).toEqual(expect.arrayContaining(["urn:oid:old.1", "urn:oid:old.2"]));
    expect(report?.parameters["expiredReferences"]).toBeUndefined();
  });
});

describe("the map function", () => {
  it("does not throw for any JSON body", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (value) => {
        const result = await mapObservation(observe(JSON.stringify(value) ?? "null"));
        return Array.isArray(result.reports) && Array.isArray(result.problems);
      }),
    );
  });

  it("does not throw when a field of a real alert has any value", async () => {
    const source = feature("nws-faw.json");
    const fields = Object.keys(source.properties);
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...fields), fc.jsonValue(), async (field, value) => {
        const changed = { ...source, properties: { ...source.properties, [field]: value } };
        const result = await mapObservation(observe(JSON.stringify(changed)));
        return result.reports.length <= 1 && result.problems.every((problem) => typeof problem.path === "string");
      }),
    );
  });

  it("does not throw for any geometry", async () => {
    const source = feature("nws-sps.json");
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (geometry) => {
        const result = await mapObservation(observe(JSON.stringify({ ...source, geometry })));
        return result.reports.length === 1;
      }),
    );
  });
});

describe("the VTEC key at the new year", () => {
  // Two messages of one event, made from a recorded alert. The first message starts the event on
  // 31 December. The second one continues it on 1 January, with the start 000000T0000Z.
  const base = feature("nws-bzw.json");
  const message = (id: string, sent: string, messageType: string, vtec: string, references: unknown[]): unknown => ({
    ...base,
    properties: { ...base.properties, id, sent, messageType, references, parameters: { ...base.properties.parameters, VTEC: [vtec] } },
  });
  const first = message("urn:oid:test.year.1", "2026-12-31T20:00:00+00:00", "Alert", "/O.NEW.PAFG.BZ.W.0099.261231T2100Z-270101T1600Z/", []);
  const second = message("urn:oid:test.year.2", "2027-01-01T03:00:00+00:00", "Update", "/O.CON.PAFG.BZ.W.0099.000000T0000Z-270101T1600Z/", [
    { "@id": "x", identifier: "urn:oid:test.year.1", sender: "w-nws.webmaster@noaa.gov", sent: "2026-12-31T20:00:00+00:00" },
  ]);

  it("gives two keys, and the CAP reference still links the two reports", async () => {
    const one = (await mapOne(first)).report;
    const two = (await mapOne(second)).report;
    expect(one?.correlation).toEqual([{ system: "vtec", id: "PAFG.BZ.W.0099.2026" }]);
    expect(two?.correlation).toEqual([{ system: "vtec", id: "PAFG.BZ.W.0099.2027" }]);
    expect(two?.references).toContain(one?.key);
  });
});
