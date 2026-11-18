import { readFileSync } from "node:fs";
import { readFeed } from "@mark1russell7/alerts-format-cap";
import type { Observation, ObservationId, SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { incidentBodies } from "./fetch.ts";
import { mapObservation, plainText } from "./map.ts";

/** The real feeds (`fixtures/README.md`). */
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const FETCHED = Date.parse("2024-12-27T04:12:23Z");

/** This function gives the observations of a fixture, as the fetch gives them. */
function observationsOf(name: string): readonly Observation[] {
  const read = readFeed(fixture(name));
  const bodies = read.ok ? incidentBodies(read.entries).bodies : [];
  return bodies.map((body, index) => ({ id: `o${String(index)}` as ObservationId, source: "azure-status" as SourceId, fetched: FETCHED, contentType: "application/json", body, transport: { latency: 0 } }));
}

const reportsOf = (name: string) => observationsOf(name).flatMap((observation) => mapObservation(observation).reports);

const observation = (fields: Record<string, unknown>): Observation => ({ id: "o" as ObservationId, source: "azure-status" as SourceId, fetched: FETCHED, contentType: "application/json", body: JSON.stringify(fields), transport: { latency: 0 } });

describe("mapObservation", () => {
  it("maps the storage incident of South Central US: its region as a subject, its services as a parameter and its text with no HTML", () => {
    const [observed] = observationsOf("feed-20241227T041223Z.xml");
    const result = mapObservation(observed!);
    expect(result.problems).toEqual([]);
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0]!;
    expect(report).toMatchObject({
      source: "azure-status",
      origin: "microsoft",
      key: "active-storage-latency-timeouts-or-http-500-errors-in-south-central-us",
      status: "actual",
      op: "alert",
      kind: { code: "infra.cloud.outage" },
      severity: "moderate",
      urgency: "immediate",
      certainty: "observed",
      response: ["monitor"],
      sent: Date.parse("2024-12-26T18:44:00Z"),
      effective: Date.parse("2024-12-26T18:44:00Z"),
      received: FETCHED,
      areas: [],
      sender: "Azure Status",
      headline: "Azure: Active - Storage latency, timeouts, or HTTP 500 errors in South Central US",
      web: "https://status.azure.com/en-us/status/",
      observation: "o0",
      parameters: { service: ["App Service", "Application Gateway", "Azure Cosmos DB", "Azure Sentinel", "Log Analytics", "Storage Accounts", "Virtual Machines"], region: ["South Central US"] },
    });
    expect(report.about).toEqual([
      { system: "domain", id: "azure.microsoft.com", label: "Microsoft Azure" },
      { system: "provider-region", id: "azure/southcentralus", label: "South Central US" },
    ]);
    expect(report.description).toMatch(/^Impact Statement: Starting at 18:44 UTC on 26 Dec 2024, /);
    expect(report.description).toContain("and it’s possible, we advise you");
    expect(report.description).not.toMatch(/[<>]|&nbsp;|&lt;|&amp;/);
  });

  it("gives each region of the real feeds a subject, and no region for the categories with no region", () => {
    const [awareness] = reportsOf("feed-20240719T153048Z.xml");
    expect(awareness!.about.filter((subject) => subject.system === "provider-region")).toHaveLength(40);
    expect(awareness!.parameters).toMatchObject({ service: ["Virtual Machines"] });
    const [network] = reportsOf("feed-20240730T171154Z.xml");
    expect(network!.parameters?.["service"]).toEqual(["Network Infrastructure"]);
    expect(network!.parameters?.["region"]).toHaveLength(40);
    expect(network!.about.map((subject) => subject.id)).not.toContain("azure/publicnon-regional");
    expect(network!.about.map((subject) => subject.id)).toContain("azure/westeurope");
    const [guidance] = reportsOf("feed-20240721T181144Z.xml");
    expect(guidance!.about).toEqual([{ system: "domain", id: "azure.microsoft.com", label: "Microsoft Azure" }]);
    expect(guidance!.parameters).toEqual({});
    expect(reportsOf("feed-20241220T213324Z.xml")).toEqual([]);
  });

  it("gives a fatal problem and no report for an incident with no time or no title, and for a body that is not JSON", () => {
    const base = { key: "k", title: "Active - T", published: "Thu, 26 Dec 2024 18:44:00 Z", categories: [] };
    expect(mapObservation(observation({ ...base, published: "soon" }))).toEqual({ reports: [], problems: [{ path: "published", message: "the incident has no time: the map makes no report", fatal: true }] });
    expect(mapObservation(observation({ ...base, title: " " })).problems).toEqual([{ path: "title", message: "the incident has no title: the map makes no report", fatal: true }]);
    expect(mapObservation(observation({ ...base, key: "" })).problems).toEqual([{ path: "key", message: "the incident has no guid: the map makes no report", fatal: true }]);
    expect(mapObservation({ ...observation(base), body: "{" }).problems).toEqual([{ path: "", message: "the body is not JSON", fatal: true }]);
  });

  it("gives the page of Azure as the link when the item has no HTTPS link, and the same report id for the same item", () => {
    const base = { key: "k", title: "Active - T", published: "Thu, 26 Dec 2024 18:44:00 Z", categories: ["West Europe", "West Europe"], link: "http://example.org/" };
    const [one] = mapObservation(observation(base)).reports;
    expect(one!.web).toBe("https://azure.status.microsoft/en-us/status");
    expect(one!.about.filter((subject) => subject.system === "provider-region")).toEqual([{ system: "provider-region", id: "azure/westeurope", label: "West Europe" }]);
    expect(mapObservation(observation({ ...base, description: "<p>New text</p>" })).reports[0]!.id).toBe(one!.id);
  });
});

describe("plainText", () => {
  it("removes the tags, decodes the references and keeps one space for each run of white space", () => {
    expect(plainText("<p><strong>Impact:</strong>&nbsp;one&amp;two</p>\n<p>it&#8217;s &lt;b&gt;</p>")).toBe("Impact: one&two it’s <b>");
    expect(plainText("<p> </p>")).toBeUndefined();
    expect(plainText(undefined)).toBeUndefined();
  });
});
