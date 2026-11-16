/**
 * The gate of the link of two paths of the earthquakes: the real answer of EMSC and the real feed of the USGS of one
 * day. Merge rule 3 (`linkRule` of the core) joins the reports of one event from the two sources in one incident.
 * No key joins them, because each source has its own ids.
 */

import { readFileSync } from "node:fs";
import { coverage, DEFAULT_LINK_POLICY, incidents, linkRule, normalize, sourceDescriptorSchema, type Incident, type PlaceId, type Report } from "@mark1russell7/alerts";
import { mapObservation as mapUsgs, readAnswer as readUsgs, SOURCE_ID as USGS_SOURCE, USGS_DESCRIPTOR, USGS_ORIGIN } from "@mark1russell7/alerts-source-usgs";
import { describe, expect, it } from "vitest";
import { EMSC_DESCRIPTOR } from "./descriptor.ts";
import { readAnswer } from "./fetch.ts";
import { ANSS_ORIGIN, EMSC_ORIGIN, mapObservation, originOf, SOURCE_ID } from "./map.ts";

const reply = (body: string) => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body });
const EMSC_ANSWER = readFileSync(new URL("../fixtures/query-2.5_day-20261116T0528Z.json", import.meta.url), "utf8");
const USGS_FEED = readFileSync(new URL("../../source-usgs/fixtures/feed-2.5_day-20261116T0327Z.geojson", import.meta.url), "utf8");
const EMSC_FETCHED = Date.parse("2026-11-16T05:28:21Z");
const USGS_FETCHED = Date.parse("2026-11-16T03:27:40Z");

/** The event of each report: the id of its feature in its answer. */
const eventOf = new Map<string, string>();
const authorOf = new Map<string, string>();
const problems: unknown[] = [];
const mapped = (source: string, observations: readonly { readonly body: string }[], map: (observation: never) => { readonly reports: readonly Report[]; readonly problems: readonly unknown[] }): Report[] =>
  observations.flatMap((observation) => {
    const result = map(observation as never);
    problems.push(...result.problems);
    const fields = JSON.parse(observation.body) as { id: string; auth?: string };
    for (const report of result.reports) eventOf.set(report.id, `${source}:${fields.id}`);
    if (fields.auth !== undefined) authorOf.set(fields.id, fields.auth);
    return result.reports;
  });
const USGS_REPORTS = mapped(USGS_SOURCE, readUsgs(reply(USGS_FEED), "https://usgs.test/feed", USGS_FETCHED, 40)?.observations ?? [], mapUsgs);
const EMSC_REPORTS = mapped(SOURCE_ID, (readAnswer(reply(EMSC_ANSWER), "https://emsc.test/query", EMSC_FETCHED, 40)?.listed ?? []).map((listed) => listed.observation), mapObservation);
const STATE = normalize({ reports: [...USGS_REPORTS, ...EMSC_REPORTS] });

/** The events of an incident, by source. */
const eventsOf = (incident: Incident, source: string): string[] => [...new Set(incident.reports.map((id) => eventOf.get(id) ?? "").filter((event) => event.startsWith(`${source}:`)).map((event) => event.slice(source.length + 1)))];

/** The 30 events of the USGS feed that EMSC has too, with the id of EMSC (`unid`). The other 18 are only in the feed. */
const PAIRS: readonly (readonly [string, string])[] = [
  ["aka2026wqjupw", "20261115_0000142"],
  ["aka2026wqrlbd", "20261115_0000194"],
  ["aka2026wrfeqf", "20261116_0000001"],
  ["hv75070872", "20261115_0000283"],
  ["hv75070952", "20261116_0000046"],
  ["nn00927002", "20261115_0000140"],
  ["nn00927024", "20261115_0000241"],
  ["ok2026wjws", "20261115_0000121"],
  ["pr2026319000", "20261115_0000072"],
  ["pr71539328", "20261115_0000186"],
  ["us7000tyd3", "20261115_0000070"],
  ["us7000tydd", "20261115_0000080"],
  ["us7000tyde", "20261115_0000079"],
  ["us7000tydm", "20261115_0000086"],
  ["us7000tye3", "20261115_0000119"],
  ["us7000tyek", "20261115_0000145"],
  ["us7000tyes", "20261115_0000169"],
  ["us7000tyet", "20261115_0000170"],
  ["us7000tyeu", "20261115_0000237"],
  ["us7000tyf4", "20261115_0000184"],
  ["us7000tyfb", "20261115_0000239"],
  ["us7000tyfh", "20261115_0000204"],
  ["us7000tyfr", "20261115_0000221"],
  ["us7000tyg0", "20261115_0000236"],
  ["us7000tyg6", "20261115_0000249"],
  ["us7000tyga", "20261115_0000257"],
  ["us7000tygk", "20261115_0000272"],
  ["us7000tygl", "20261115_0000276"],
  ["us7000tyh5", "20261116_0000015"],
  ["us7000tyhi", "20261116_0000045"],
];

describe("the link of EMSC and the USGS (merge rule 3)", () => {
  it("maps each event of the two answers with no problem", () => {
    expect(problems).toEqual([]);
    expect(new Set([...eventOf.values()].filter((event) => event.startsWith(`${USGS_SOURCE}:`))).size).toBe(48);
    expect(new Set([...eventOf.values()].filter((event) => event.startsWith(`${SOURCE_ID}:`))).size).toBe(53);
    expect(ANSS_ORIGIN).toBe(USGS_ORIGIN);
  });

  it("joins no report of the two sources with no link rule: no key joins them", () => {
    const groups = incidents(STATE, EMSC_FETCHED);
    expect(groups).toHaveLength(48 + 53);
    for (const incident of groups) expect(eventsOf(incident, USGS_SOURCE).length + eventsOf(incident, SOURCE_ID).length).toBe(1);
  });

  it("joins each shared event of the two sources in one incident, and no two events of one source", () => {
    const groups = incidents(STATE, EMSC_FETCHED, { link: linkRule(DEFAULT_LINK_POLICY) });
    expect(groups).toHaveLength(48 + 53 - PAIRS.length);
    for (const incident of groups) {
      expect(eventsOf(incident, USGS_SOURCE).length).toBeLessThanOrEqual(1);
      expect(eventsOf(incident, SOURCE_ID).length).toBeLessThanOrEqual(1);
    }
    const joined = groups.filter((incident) => eventsOf(incident, USGS_SOURCE).length === 1 && eventsOf(incident, SOURCE_ID).length === 1);
    const pairs = joined.map((incident) => [eventsOf(incident, USGS_SOURCE)[0], eventsOf(incident, SOURCE_ID)[0]] as const);
    expect([...pairs].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1))).toEqual(PAIRS);
  });

  it("counts a second origin only for a solution of an author outside the ANSS", () => {
    const groups = incidents(STATE, EMSC_FETCHED, { link: linkRule(DEFAULT_LINK_POLICY) });
    const second = new Map<string, number>();
    for (const incident of groups) {
      const [usgs] = eventsOf(incident, USGS_SOURCE);
      const [emsc] = eventsOf(incident, SOURCE_ID);
      if (usgs === undefined || emsc === undefined) continue;
      const origin = originOf(authorOf.get(emsc));
      expect(incident.corroboration).toBe(origin === EMSC_ORIGIN ? 2 : 1);
      second.set(usgs, incident.corroboration);
    }
    // EMSC relays the solution of the ANSS for 22 of the 30 events. Only 8 events have a second solution.
    expect([...second].filter(([, count]) => count === 2).map(([usgs]) => usgs).sort()).toEqual(["us7000tydm", "us7000tye3", "us7000tyfh", "us7000tyfr", "us7000tyg0", "us7000tyga", "us7000tygk", "us7000tygl"]);
  });
});

describe("the coverage of the earthquakes with EMSC and the USGS", () => {
  it("gives one independent source in the US, because EMSC depends on the USGS there", () => {
    expect(sourceDescriptorSchema.parse(EMSC_DESCRIPTOR)).toEqual(EMSC_DESCRIPTOR);
    const health = [USGS_DESCRIPTOR, EMSC_DESCRIPTOR].map((source) => ({ source: source.id, state: "healthy" as const, since: 0, reason: "the test" }));
    const places = [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "US" }], bufferKm: 0 }];
    const [entry] = coverage({ sources: [USGS_DESCRIPTOR, EMSC_DESCRIPTOR], health, places, kinds: ["geo.earthquake"] });
    expect(entry).toMatchObject({ sources: [USGS_SOURCE, SOURCE_ID], independent: 1, required: 2, proven: true });
  });
});
