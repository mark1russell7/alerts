import { readFileSync } from "node:fs";
import { categoryOf, knownKind, type Observation, type ObservationId } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { incidentBody, readSummary } from "./fetch.ts";
import { componentsOf, isHead, keysOf, mapObservation, sentOf, SEVERITY_OF_IMPACT, updatesOf, URGENCY_OF_STATUS } from "./map.ts";
import { endpointKey, REGION_SYSTEM, SUBJECT_SYSTEM } from "./page.ts";
import { registeredPage } from "./register.ts";

/** The real summaries of two pages, with a part of their components (`fixtures/README.md`). */
const read = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as { incidents: Record<string, unknown>[] } & Record<string, unknown>;
const CLOUDFLARE = read("cloudflare-20261118.json");
const OPENAI = read("openai-20261118.json");
const CLOUDFLARE_PAGE = registeredPage("statuspage-cloudflare")!;
const OPENAI_PAGE = registeredPage("statuspage-openai")!;
const FETCHED = Date.parse("2026-11-18T04:34:02Z");
const incident = (summary: typeof CLOUDFLARE, id: string): Record<string, unknown> => summary.incidents.find((each) => each["id"] === id)!;
/** The Cloudflare page with keys for tests: a key of a group, two keys of components with one domain, and a key that no incident names. */
const KEYED = {
  ...CLOUDFLARE_PAGE,
  components: [
    endpointKey("zqxhg7y54vy8", "Europe", "edge.example.test"),
    endpointKey("jm5mggc2wp95", "Interconnect", "edge.example.test"),
    endpointKey("57srcl8zcn7c", "Workers", "workers.example.test"),
    endpointKey("kq0n0t0n0th3", "Other", "other.example.test"),
  ],
};
const observationOf = (body: string, fetched = FETCHED): Observation => ({ id: `o-${body.length}` as ObservationId, source: CLOUDFLARE_PAGE.id, fetched, contentType: "application/json", body, transport: { latency: 0 } });

describe("mapObservation", () => {
  it("gives one report of the kind of the page for an incident, with the id of the incident as its key", () => {
    const { reports, problems } = mapObservation(observationOf(incidentBody(incident(CLOUDFLARE, "k3r9i5tbre4i"))), CLOUDFLARE_PAGE);
    expect(problems).toEqual([]);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report).toMatchObject({
      source: "statuspage-cloudflare",
      origin: "cloudflare",
      key: "k3r9i5tbre4i",
      references: [],
      correlation: [],
      status: "actual",
      op: "update",
      kind: { code: "infra.internet.dns-cdn" },
      categories: [categoryOf("infra.internet.dns-cdn")],
      severity: "minor",
      urgency: "past",
      certainty: "observed",
      response: ["monitor"],
      sent: Date.parse("2026-11-18T03:57:17.991Z"),
      received: FETCHED,
      effective: Date.parse("2026-11-18T03:39:01.644Z"),
      onset: Date.parse("2026-11-18T03:39:01.643Z"),
      areas: [],
      sender: "The status page of Cloudflare",
      headline: "Cloudflare: Network Performance Issues in Paris",
      web: "https://www.cloudflarestatus.com/incidents/k3r9i5tbre4i",
    });
    expect(report.expires).toBeUndefined();
    expect(report.description).toMatch(/^A fix has been implemented and we are monitoring the results\./);
    expect(report.about).toEqual([{ system: "domain", id: "cloudflare.com", label: "Cloudflare" }]);
    expect(report.parameters).toEqual({
      status: ["monitoring"],
      impact: ["minor"],
      component: ["Network", "Cloud Network Interconnect (CNI)", "Paris, France - (CDG)"],
      updates: ["4"],
      page: ["https://www.cloudflarestatus.com"],
    });
    expect(knownKind(report.kind.code)).toBe(true);
  });

  it("names the domain of each endpoint of a key after the domain of the service, with one subject for each domain", () => {
    const report = mapObservation(observationOf(incidentBody(incident(CLOUDFLARE, "k3r9i5tbre4i"))), KEYED).reports[0]!;
    expect(report.about).toEqual([
      { system: "domain", id: "cloudflare.com", label: "Cloudflare" },
      { system: "domain", id: "edge.example.test", label: "Cloudflare: Europe, Interconnect" },
    ]);
    expect(mapObservation(observationOf(incidentBody(incident(CLOUDFLARE, "0ocqieaifg7h"))), KEYED).reports[0]!.about.map((subject) => subject.id)).toEqual(["cloudflare.com", "workers.example.test"]);
  });

  it("gives the urgency immediate for an incident that the provider still investigates or fixes", () => {
    const report = mapObservation(observationOf(incidentBody(incident(CLOUDFLARE, "0ocqieaifg7h"))), CLOUDFLARE_PAGE).reports[0]!;
    expect(report).toMatchObject({ urgency: "immediate", severity: "minor", op: "update", sent: Date.parse("2026-11-11T05:05:06.331Z") });
    expect(report.parameters["component"]).toEqual(["Workers", "Queues"]);
    expect(report.description).toBe("The issue has been identified and a fix is being implemented.");
  });

  it("reads an incident of incident.io, with no link, no start and no components", () => {
    const report = mapObservation(observationOf(incidentBody(OPENAI.incidents[0]!)), OPENAI_PAGE).reports[0]!;
    expect(report).toMatchObject({
      source: "statuspage-openai",
      key: "01M7N9VNR6X5SEC90M1YCDB36D",
      kind: { code: "infra.saas.outage" },
      urgency: "past",
      sent: Date.parse("2026-11-17T19:53:49Z"),
      effective: Date.parse("2026-11-17T17:46:15Z"),
      headline: "OpenAI: Costs API data is delayed",
      description: "We've pushed a fix and are monitoring the recovery.",
      web: "https://status.openai.com",
      about: [{ system: SUBJECT_SYSTEM, id: "openai.com", label: "OpenAI" }],
    });
    expect(report.onset).toBeUndefined();
    expect(report.parameters["component"]).toBeUndefined();
  });

  it("gives the op alert for an incident with one update", () => {
    const first = { ...incident(CLOUDFLARE, "0ocqieaifg7h"), incident_updates: updatesOf(incident(CLOUDFLARE, "0ocqieaifg7h")).slice(-1) };
    expect(mapObservation(observationOf(incidentBody(first)), CLOUDFLARE_PAGE).reports[0]?.op).toBe("alert");
  });

  it("gives one report for each incident of the fixtures, and the same report for the same observation", () => {
    for (const [summary, page] of [
      [CLOUDFLARE, CLOUDFLARE_PAGE],
      [OPENAI, OPENAI_PAGE],
    ] as const) {
      for (const each of summary.incidents) {
        const observation = observationOf(incidentBody(each));
        const first = mapObservation(observation, page);
        expect(first.problems, String(each["id"])).toEqual([]);
        expect(first.reports).toHaveLength(1);
        expect(mapObservation(observation, page)).toEqual(first);
      }
    }
  });

  it("gives no report and no problem for the head of a page", () => {
    const head = readSummary(JSON.stringify(CLOUDFLARE))!.head;
    expect(isHead(JSON.parse(head) as Record<string, unknown>)).toBe(true);
    expect(mapObservation(observationOf(head), CLOUDFLARE_PAGE)).toEqual({ reports: [], problems: [] });
  });

  it("gives a fatal problem for the whole answer when the answer is not a summary", () => {
    const whole = JSON.stringify({ ...CLOUDFLARE, incidents: "moved" });
    expect(isHead(JSON.parse(whole) as Record<string, unknown>)).toBe(false);
    expect(mapObservation(observationOf(whole), CLOUDFLARE_PAGE)).toEqual({
      reports: [],
      problems: [{ path: "", message: "the observation is not one incident of a status page: the format changed", fatal: true }],
    });
    expect(mapObservation(observationOf("<html>"), CLOUDFLARE_PAGE).problems[0]).toMatchObject({ message: "the body is not JSON", fatal: true });
  });

  it("gives a fatal problem and no report for an incident with no id, name, status or time", () => {
    const base = incident(CLOUDFLARE, "0ocqieaifg7h");
    for (const [field, change] of [
      ["id", { id: " " }],
      ["name", { name: 7 }],
      ["status", { status: null }],
      ["updated_at", { updated_at: "soon", created_at: undefined }],
    ] as const) {
      const { reports, problems } = mapObservation(observationOf(incidentBody({ ...base, ...change })), CLOUDFLARE_PAGE);
      expect(reports, field).toEqual([]);
      expect(problems.map((problem) => [problem.path, problem.fatal]), field).toEqual([[field, true]]);
    }
  });

  it("gives a lossy problem and the value unknown for a status or an impact that Statuspage does not give", () => {
    const { reports, problems } = mapObservation(observationOf(incidentBody({ ...incident(CLOUDFLARE, "0ocqieaifg7h"), status: "paused", impact: "huge" })), CLOUDFLARE_PAGE);
    expect(reports[0]).toMatchObject({ urgency: "unknown", severity: "unknown" });
    expect(problems.map((problem) => [problem.path, problem.fatal])).toEqual([
      ["status", false],
      ["impact", false],
    ]);
  });

  it("does not throw for any JSON body", () => {
    fc.assert(
      fc.property(fc.json(), (body) => {
        const result = mapObservation(observationOf(body), CLOUDFLARE_PAGE);
        expect(Array.isArray(result.reports)).toBe(true);
      }),
    );
  });
});

describe("keysOf", () => {
  it("gives the keys of the components and the groups of an incident, in the order of the page", () => {
    expect(keysOf(incident(CLOUDFLARE, "k3r9i5tbre4i"), KEYED).map((key) => key.name)).toEqual(["Europe", "Interconnect"]);
    expect(keysOf(incident(CLOUDFLARE, "0ocqieaifg7h"), KEYED).map((key) => key.name)).toEqual(["Workers"]);
  });

  it("reads the codes of the affected components of the updates, which give no group", () => {
    expect(keysOf({ ...incident(CLOUDFLARE, "k3r9i5tbre4i"), components: [] }, KEYED).map((key) => key.name)).toEqual(["Interconnect"]);
  });

  it("gives no key for a page with no keys", () => {
    expect(keysOf(incident(CLOUDFLARE, "k3r9i5tbre4i"), CLOUDFLARE_PAGE)).toEqual([]);
  });

  it("names the API of Twilio for an incident on the path of an alert, and the path of the region for an incident of a carrier", () => {
    const twilio = read("twilio-incidents-20261118.json");
    const page = registeredPage("statuspage-twilio")!;
    const aboutOf = (id: string) => mapObservation(observationOf(incidentBody(incident(twilio, id))), page).reports[0]!.about.map((subject) => subject.id);
    expect(keysOf(incident(twilio, "269ytwp2jgqq"), page).map((key) => key.name)).toEqual(["SMS", "Programmable Messaging API"]);
    expect(aboutOf("269ytwp2jgqq")).toEqual(["twilio.com", "api.twilio.com"]);
    // The component SMS, APAC is in the group CARRIER NETWORK. Its key names the SMS of APAC, not the API.
    expect(keysOf(incident(twilio, "smg76w4fhp05"), page).map((key) => key.name)).toEqual(["SMS, APAC"]);
    const carrier = mapObservation(observationOf(incidentBody(incident(twilio, "smg76w4fhp05"))), page).reports[0]!;
    expect(carrier.about).toEqual([
      { system: SUBJECT_SYSTEM, id: "twilio.com", label: "Twilio" },
      { system: REGION_SYSTEM, id: "twilio/apac/sms", label: "Twilio: SMS, APAC" },
    ]);
  });
});

describe("the values of an incident", () => {
  it("gives a severity for each impact and an urgency for each status of Statuspage", () => {
    expect(SEVERITY_OF_IMPACT).toEqual({ critical: "severe", major: "moderate", minor: "minor", none: "minor" });
    expect(Object.keys(URGENCY_OF_STATUS)).toEqual(["investigating", "identified", "monitoring", "resolved", "postmortem"]);
  });

  it("orders the updates with the newest first, and takes the time of creation when the incident has no time of change", () => {
    const each = incident(CLOUDFLARE, "k3r9i5tbre4i");
    expect(updatesOf(each).map((update) => update["status"])).toEqual(["monitoring", "identified", "identified", "investigating"]);
    expect(updatesOf({ ...each, incident_updates: [...(each["incident_updates"] as unknown[])].reverse() }).map((update) => update["id"])).toEqual(updatesOf(each).map((update) => update["id"]));
    expect(sentOf({ created_at: "2026-11-18T03:39:01.644Z" })).toBe(Date.parse("2026-11-18T03:39:01.644Z"));
    expect(componentsOf({ components: [{ name: "A" }, { name: "A" }, { name: " " }, 7] })).toEqual(["A"]);
  });
});
