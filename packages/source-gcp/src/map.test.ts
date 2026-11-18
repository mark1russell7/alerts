import { readFileSync } from "node:fs";
import { categoryOf, knownKind, SUBJECT_SYSTEMS, type Observation, type ObservationId, type SubjectSystem } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIREBASE_DASHBOARD, FIREBASE_KEYS, GCP_DASHBOARD, GCP_SOURCE, REGION_SYSTEM } from "./feed.ts";
import { incidentBody } from "./fetch.ts";
import { itemsOf, keysOf, locationsOf, mapObservation, SEVERITY_OF_INCIDENT, URGENCY_OF_STATUS } from "./map.ts";

type Incident = Record<string, unknown> & { updates: Record<string, unknown>[] };

/** Two real disruptions of the feed (`fixtures/README.md`). Both have ended. The second has more than one region. */
const [NETWORK, CLUSTERS] = JSON.parse(readFileSync(new URL("../fixtures/incidents-20261118.json", import.meta.url), "utf8")) as [Incident, Incident];
const FETCHED = Date.parse("2026-11-18T05:24:17Z");

/** Two real incidents of the Firebase Status Dashboard (`fixtures/README.md`): one of Cloud Messaging, one of Hosting. */
const [MESSAGING, HOSTING] = JSON.parse(readFileSync(new URL("../fixtures/firebase-incidents-20261118.json", import.meta.url), "utf8")) as [Incident, Incident];

/**
 * This function gives an incident as it was after its first `count` updates: live, with the locations of its newest
 * update. The feed changes the field `modified` of an update when the next update comes. Thus the time of the newest
 * update is its field `created`.
 */
function asOfUpdate(incident: Incident, count: number, status?: string): Incident {
  const updates = incident.updates.slice(incident.updates.length - count);
  const newest = updates[0]!;
  const latest: Record<string, unknown> = { ...newest, modified: newest["created"], ...(status === undefined ? {} : { status }) };
  const { end: _end, ...live } = incident;
  return { ...live, modified: latest["modified"], updates: [latest, ...updates.slice(1)], most_recent_update: latest, currently_affected_locations: latest["affected_locations"], previously_affected_locations: [] };
}

const observationOf = (body: string): Observation => ({ id: `o-${body.length}` as ObservationId, source: GCP_SOURCE, fetched: FETCHED, contentType: "application/json", body, transport: { latency: 0 } });
const mapIncident = (incident: Record<string, unknown>) => mapObservation(observationOf(incidentBody(incident)));
const regionsOf = (incident: Record<string, unknown>) =>
  mapIncident(incident)
    .reports[0]!.about.filter((subject) => subject.system === REGION_SYSTEM)
    .map((subject) => subject.id);

describe("mapObservation", () => {
  it("gives one report of infra.cloud.outage for an incident in progress, with the id of the incident as its key", () => {
    const { reports, problems } = mapIncident(asOfUpdate(NETWORK, 1));
    expect(problems).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      source: "gcp-status",
      origin: "google",
      key: "5fGQt4VbkDnr3Yp8PXPr",
      references: [],
      correlation: [],
      status: "actual",
      op: "alert",
      kind: { code: "infra.cloud.outage" },
      categories: [categoryOf("infra.cloud.outage")],
      severity: "moderate",
      urgency: "immediate",
      certainty: "observed",
      response: ["monitor"],
      sent: Date.parse("2026-06-10T01:13:50Z"),
      received: FETCHED,
      effective: Date.parse("2026-06-10T01:13:50Z"),
      onset: Date.parse("2026-06-05T07:00:00Z"),
      areas: [],
      sender: "Google Cloud Service Health",
      web: "https://status.cloud.google.com/incidents/5fGQt4VbkDnr3Yp8PXPr",
    });
    expect(reports[0]?.headline).toMatch(/^Google Cloud: Network traffic to Google Cloud originating from /);
    expect(reports[0]?.about).toEqual([
      { system: "domain", id: "cloud.google.com", label: "Google Cloud" },
      { system: "provider-region", id: "gcp/asia-south2", label: "Delhi (asia-south2)" },
    ]);
    expect(reports[0]?.parameters).toMatchObject({ status: ["SERVICE_DISRUPTION"], impact: ["SERVICE_DISRUPTION"], severity: ["medium"], "location-now": ["asia-south2"], updates: ["1"] });
    expect(reports[0]?.expires).toBeUndefined();
  });

  it("gives the op update, a new sent time and the urgency past after more updates and the recovery", () => {
    const later = mapIncident(asOfUpdate(NETWORK, 5)).reports[0]!;
    expect(later).toMatchObject({ op: "update", urgency: "immediate", sent: Date.parse("2026-06-15T23:11:38Z") });
    expect(regionsOf(asOfUpdate(NETWORK, 5))).toEqual(["gcp/asia-south2", "gcp/global"]);
    const report = mapIncident(NETWORK).reports[0]!;
    expect(report).toMatchObject({ op: "update", urgency: "past", severity: "moderate", sent: Date.parse("2026-06-29T23:06:10Z") });
    expect(report.description).toMatch(/^\*\*Summary\*\*\nNetwork traffic to Google Cloud/);
    expect(report.parameters["product"]).toEqual(["Hybrid Connectivity", "Media CDN", "Virtual Private Cloud (VPC)"]);
    expect(report.parameters["product-id"]).toHaveLength(3);
    expect(report.parameters["location-now"]).toBeUndefined();
    expect(report.parameters["updates"]).toEqual(["9"]);
  });

  it("gives each region of an incident with more than one region: the regions of the update, then the regions before", () => {
    expect(regionsOf(asOfUpdate(CLUSTERS, 1))).toEqual(["gcp/australia-southeast2", "gcp/europe-west3", "gcp/northamerica-northeast2"]);
    expect(regionsOf(CLUSTERS)).toEqual(["gcp/australia-southeast2", "gcp/europe-west3"]);
    expect(mapIncident(CLUSTERS).reports[0]).toMatchObject({ key: "T8gmtofFSTGT5tbhyciF", urgency: "past", parameters: { product: ["VMWare engine"], updates: ["11"] } });
  });

  it("gives the severity minor for the severity low, and the urgency future for a notice in progress", () => {
    expect(mapIncident({ ...CLUSTERS, severity: "low" }).reports[0]?.severity).toBe("minor");
    expect(mapIncident(asOfUpdate(CLUSTERS, 1, "SERVICE_INFORMATION")).reports[0]).toMatchObject({ urgency: "future", op: "alert", parameters: { status: ["SERVICE_INFORMATION"] } });
  });

  it("maps an incident of the Firebase dashboard: the domain of Firebase, then the endpoint of the key of each product", () => {
    const { reports, problems } = mapObservation(observationOf(incidentBody(MESSAGING)), FIREBASE_DASHBOARD);
    expect(problems).toEqual([]);
    expect(reports[0]).toMatchObject({
      source: "firebase-status",
      origin: "google",
      key: "efSHTx8oFZ4CH8XsqZuy",
      kind: { code: "infra.cloud.outage" },
      urgency: "past",
      areas: [],
      sender: "Firebase Status Dashboard",
      web: "https://status.firebase.google.com/incidents/efSHTx8oFZ4CH8XsqZuy",
    });
    expect(reports[0]?.headline).toMatch(/^Firebase: RESOLVED: Firebase Cloud Messaging /);
    expect(reports[0]?.about).toEqual([
      { system: "domain", id: "firebase.google.com", label: "Firebase" },
      { system: "domain", id: "fcm.googleapis.com", label: "Firebase: Cloud Messaging" },
    ]);
    expect(mapObservation(observationOf(incidentBody(HOSTING)), FIREBASE_DASHBOARD).reports[0]?.about).toEqual([{ system: "domain", id: "firebase.google.com", label: "Firebase" }]);
  });

  it("gives one subject for each domain of the keys, with the names of its products, and no subject twice for the domain of the service", () => {
    const products = [
      { id: "K2T198LhzrR5kLU8hmkk", name: "Cloud Messaging", domain: "push.example.test" },
      { id: "hhAxKbKdeaqncSsxMwEx", name: "Hosting", domain: "push.example.test" },
      { id: "x-1", name: "Other", domain: "firebase.google.com" },
    ];
    const both = { ...MESSAGING, affected_products: [...(MESSAGING["affected_products"] as unknown[]), ...(HOSTING["affected_products"] as unknown[]), { id: "x-1", title: "Other" }] };
    expect(mapObservation(observationOf(incidentBody(both)), { ...FIREBASE_DASHBOARD, products }).reports[0]?.about).toEqual([
      { system: "domain", id: "firebase.google.com", label: "Firebase" },
      { system: "domain", id: "push.example.test", label: "Firebase: Cloud Messaging, Hosting" },
    ]);
  });

  it("gives subjects that the core routes: each system is an entity system of the core", () => {
    for (const subject of mapIncident(CLUSTERS).reports[0]!.about) expect(SUBJECT_SYSTEMS[subject.system as SubjectSystem], subject.id).toBe("entity");
    expect(knownKind("infra.cloud.outage")).toBe(true);
  });

  it("gives the same report for the same observation", () => {
    for (const incident of [NETWORK, CLUSTERS, asOfUpdate(NETWORK, 3)]) {
      const observation = observationOf(incidentBody(incident));
      expect(mapObservation(observation)).toEqual(mapObservation(observation));
    }
  });

  it("gives a fatal problem for the whole answer when the answer is not one incident", () => {
    const message = "the observation is not one incident of Google Cloud Service Health: the format changed";
    expect(mapObservation(observationOf(JSON.stringify([NETWORK])))).toEqual({ reports: [], problems: [{ path: "", message, fatal: true }] });
    expect(mapObservation(observationOf(JSON.stringify({ incidents: [] }))).problems[0]?.message).toBe(message);
    expect(mapObservation(observationOf("<html>")).problems[0]).toMatchObject({ message: "the body is not JSON", fatal: true });
  });

  it("gives a fatal problem and no report for an incident with no id, summary or time", () => {
    for (const [field, change] of [
      ["id", { id: " " }],
      ["external_desc", { external_desc: 7 }],
      ["modified", { modified: "soon", created: undefined }],
    ] as const) {
      const { reports, problems } = mapIncident({ ...NETWORK, ...change });
      expect(reports, field).toEqual([]);
      expect(problems.map((problem) => [problem.path, problem.fatal]), field).toEqual([[field, true]]);
    }
  });

  it("gives a lossy problem and the value unknown for a severity or a status that the feed does not give", () => {
    const { reports, problems } = mapIncident({ ...NETWORK, severity: "huge", most_recent_update: { ...(NETWORK["most_recent_update"] as object), status: "PAUSED" } });
    expect(reports[0]).toMatchObject({ severity: "unknown", urgency: "unknown" });
    expect(problems.map((problem) => [problem.path, problem.fatal])).toEqual([
      ["severity", false],
      ["most_recent_update.status", false],
    ]);
    expect(mapIncident({ ...NETWORK, most_recent_update: undefined }).reports[0]).toMatchObject({ urgency: "unknown", op: "update" });
  });

  it("does not throw for any JSON body", () => {
    fc.assert(
      fc.property(fc.json(), (body) => {
        expect(Array.isArray(mapObservation(observationOf(body)).reports)).toBe(true);
      }),
    );
  });
});

describe("keysOf", () => {
  it("gives the keys of the affected products in the order of the dashboard, and no key for a dashboard with no keys", () => {
    expect(keysOf(MESSAGING, FIREBASE_DASHBOARD)).toEqual(FIREBASE_KEYS);
    expect(keysOf(HOSTING, FIREBASE_DASHBOARD)).toEqual([]);
    expect(keysOf(MESSAGING, GCP_DASHBOARD)).toEqual([]);
  });
});

describe("the values of an incident", () => {
  it("gives a severity for each severity and an urgency for each status of the feed", () => {
    expect(SEVERITY_OF_INCIDENT).toEqual({ high: "severe", medium: "moderate", low: "minor" });
    expect(Object.keys(URGENCY_OF_STATUS)).toEqual(["SERVICE_OUTAGE", "SERVICE_DISRUPTION", "SERVICE_INFORMATION", "AVAILABLE"]);
  });

  it("lists the current locations first and each location one time, and skips an item with no id", () => {
    expect(locationsOf({ currently_affected_locations: [{ id: "b" }], previously_affected_locations: [{ id: "a", title: "A" }, { id: "b" }] })).toEqual([{ id: "b" }, { id: "a", title: "A" }]);
    expect(itemsOf({ list: [{ id: "x" }, { id: "x" }, { title: "No id" }, 7, { id: " " }] }, "list")).toEqual([{ id: "x" }]);
    expect(itemsOf({ list: "none" }, "list")).toEqual([]);
  });
});
