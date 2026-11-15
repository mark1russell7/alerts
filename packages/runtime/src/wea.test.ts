import { readFileSync } from "node:fs";
import { carriages, incidents, normalize, type Instant, type Observation, type ObservationId, type Report, type SourceId } from "@mark1russell7/alerts";
import { mapObservation as mapIpaws, SOURCE_ID as IPAWS, WEA_EXPECTATION } from "@mark1russell7/alerts-source-ipaws";
import { mapObservation as mapApi, SOURCE_ID as API } from "@mark1russell7/alerts-source-nws-api";
import { describe, expect, it } from "vitest";

/**
 * The real messages of one event of a Texas office (KEWX, flash flood warning 0108). Each message has an NWS API copy
 * and an IPAWS copy: the first message and its extension. Their one home is the package `format-cap`.
 */
const PAIRS = new URL("../../format-cap/fixtures/pairs/", import.meta.url);
const pair = (name: string): string => readFileSync(new URL(name, PAIRS), "utf8");
const MINUTE = 60_000;

/** The two copies of one message, and the time when each source fetched its copy: 20 seconds and 40 seconds after the sent time. */
interface Message {
  readonly api: string;
  readonly ipaws: string;
  readonly sent: Instant;
}

const message = (name: string): Message => {
  const api = pair(`${name}.nws-api.json`);
  return { api, ipaws: pair(`${name}.ipaws.xml`), sent: Date.parse((JSON.parse(api) as { properties: { sent: string } }).properties.sent) };
};
const NEW = message("kewx-ff-w-0108-new");
const EXT = message("kewx-ff-w-0108-ext");

const observe = (source: SourceId, body: string, fetched: Instant, contentType: string): Observation => ({
  id: `observation-${source}-${String(fetched)}` as ObservationId,
  source,
  fetched,
  contentType,
  body,
  transport: { latency: 0 },
});

/** This function maps each copy of the messages with the map of its own source, and gives the reports with no problem. */
function reportsOf(messages: readonly Message[], change: (feature: any) => void = () => undefined): { api: Report[]; ipaws: Report[] } {
  const api: Report[] = [];
  const ipaws: Report[] = [];
  for (const { api: text, ipaws: xml, sent } of messages) {
    const feature = JSON.parse(text) as unknown;
    change(feature);
    const fromApi = mapApi(observe(API, JSON.stringify(feature), sent + 20_000, "application/geo+json"));
    const fromIpaws = mapIpaws(observe(IPAWS, xml, sent + 40_000, "application/xml"));
    expect(fromApi.problems).toEqual([]);
    expect(fromIpaws.problems).toEqual([]);
    api.push(...fromApi.reports);
    ipaws.push(...fromIpaws.reports);
  }
  return { api, ipaws };
}

/** This function gives the checks of the expectation of the instance over the reports, one hour after the last message. */
function checksOf(reports: readonly Report[], messages: readonly Message[]): ReturnType<typeof carriages> {
  const state = normalize({ reports });
  const at = Math.max(...messages.map((one) => one.sent)) + 60 * MINUTE;
  return carriages(state, incidents(state, at), [WEA_EXPECTATION]);
}

describe("the WEA copies of a real event, through the maps of the two sources and the expectation of the instance", () => {
  it("keeps the parameter WEAHandling in the report of the NWS API source", () => {
    const { api } = reportsOf([NEW, EXT]);
    expect(api.map((report) => [report.status, report.parameters["WEAHandling"]])).toEqual([
      ["actual", ["Imminent Threat"]],
      ["actual", ["Imminent Threat"]],
    ]);
  });

  it("joins the four copies of the two messages in one incident by the VTEC key", () => {
    const { api, ipaws } = reportsOf([NEW, EXT]);
    const state = normalize({ reports: [...api, ...ipaws] });
    const found = incidents(state, EXT.sent + 60 * MINUTE);
    expect(found.map((incident) => [...incident.reports].sort())).toEqual([[...api, ...ipaws].map((report) => report.id).sort()]);
  });

  it("measures the delay of the first copy of the incident, because the core gives one check for each incident", () => {
    const { api, ipaws } = reportsOf([NEW, EXT]);
    // The extension is a WEA message with its own IPAWS copy, but it gives no check of its own.
    expect(checksOf([...api, ...ipaws], [NEW, EXT])).toEqual([
      { expectation: WEA_EXPECTATION.id, report: api[0]?.id, started: NEW.sent + 20_000, arrived: NEW.sent + 40_000 },
    ]);
  });

  it("starts a check with no arrival when IPAWS has no copy", () => {
    const { api } = reportsOf([NEW]);
    expect(checksOf(api, [NEW])).toEqual([{ expectation: WEA_EXPECTATION.id, report: api[0]?.id, started: api[0]?.received }]);
  });

  it("expects no copy of the same message with no WEAHandling", () => {
    const { api, ipaws } = reportsOf([NEW], (feature) => {
      delete feature.properties.parameters.WEAHandling;
    });
    expect(api[0]?.parameters["WEAHandling"]).toBeUndefined();
    expect(checksOf([...api, ...ipaws], [NEW])).toEqual([]);
  });
});
