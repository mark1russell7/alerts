import { readFileSync } from "node:fs";
import { categoryOf, knownKind, SUBJECT_SYSTEMS, type Observation, type ObservationId, type SubjectSystem } from "@mark1russell7/alerts";
import { readFeed, type FeedEntry } from "@mark1russell7/alerts-format-cap";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AWS_SOURCE, REGION_SYSTEM } from "./feed.ts";
import { eventBodies } from "./fetch.ts";
import { LEVEL_OF_STATUS, mapObservation, statusOf } from "./map.ts";

/** The real feed (`fixtures/README.md`): the updates of two disruptions. */
const FEED = readFeed(readFileSync(new URL("../fixtures/all-20261118.rss", import.meta.url), "utf8"));
const ENTRIES: readonly FeedEntry[] = FEED.ok ? FEED.entries : [];
const FETCHED = Date.parse("2026-11-18T05:48:35Z");

const observationOf = (body: string): Observation => ({ id: `o-${body.length}` as ObservationId, source: AWS_SOURCE, fetched: FETCHED, contentType: "application/json", body, transport: { latency: 0 } });
const mapEntries = (entries: readonly FeedEntry[]) => eventBodies(entries).bodies.map((body) => mapObservation(observationOf(body)));
const reportOf = (entries: readonly FeedEntry[]) => mapEntries(entries)[0]!.reports[0]!;

const UAE = "multipleservices-me-central-1";
/** The updates of the event of one key of a service, the newest first. */
const updatesOf = (key: string) => ENTRIES.filter((entry) => entry.id?.includes(`#${key}_`) === true);
/** An update with a title and a time of its own, for a key of a service. */
const update = (key: string, seconds: number, title: string): FeedEntry => ({ id: `https://status.aws.amazon.com/#${key}_${String(seconds)}`, title, updated: new Date(seconds * 1000).toUTCString(), summary: `Text ${String(seconds)}` });

describe("mapObservation", () => {
  it("gives one report of infra.cloud.outage for each event of the feed, the newest event first", () => {
    const results = mapEntries(ENTRIES);
    expect(results.map((result) => result.problems)).toEqual([[], []]);
    expect(results.map((result) => result.reports[0]?.key)).toEqual([`${UAE}_1772369485`, "multipleservices-me-south-1_1772430987"]);
  });

  it("gives the region, the status, the severity and the times of an event with many updates", () => {
    const report = reportOf(updatesOf(UAE));
    expect(report).toMatchObject({
      source: "aws-health",
      origin: "aws",
      references: [],
      correlation: [],
      status: "actual",
      op: "update",
      kind: { code: "infra.cloud.outage" },
      categories: [categoryOf("infra.cloud.outage")],
      severity: "severe",
      urgency: "immediate",
      certainty: "observed",
      response: ["monitor"],
      sent: Date.parse("2026-09-15T10:27:10Z"),
      received: FETCHED,
      effective: Date.parse("2026-03-01T12:51:25Z"),
      areas: [],
      sender: "AWS Health Dashboard",
      headline: "AWS (multipleservices, me-central-1): Service disruption: Increased Error Rates",
      web: "https://status.aws.amazon.com/",
      parameters: { status: ["Service disruption"], service: ["multipleservices"], region: ["me-central-1"], updates: ["24"] },
    });
    expect(report.about).toEqual([
      { system: "domain", id: "aws.amazon.com", label: "Amazon Web Services" },
      { system: "provider-region", id: "aws/me-central-1" },
    ]);
    expect(report.description).toMatch(/^We are providing an update on the disruption affecting the Middle East \(UAE\) \(me-central-1\) Region\./);
    expect(report.onset).toBeUndefined();
  });

  it("gives the op alert for the first update, and the highest severity of the updates for an event in recovery", () => {
    expect(reportOf([update("ec2-eu-west-1", 1_800_000_000, "Service impact: Increased API Error Rates")])).toMatchObject({
      key: "ec2-eu-west-1_1800000000",
      op: "alert",
      severity: "minor",
      urgency: "immediate",
      effective: 1_800_000_000_000,
      parameters: { service: ["ec2"], region: ["eu-west-1"], updates: ["1"] },
    });
    const recovered = reportOf([
      update("ec2-eu-west-1", 1_800_007_200, "Service is operating normally: Increased API Error Rates"),
      update("ec2-eu-west-1", 1_800_003_600, "Service degradation: Increased API Error Rates"),
      update("ec2-eu-west-1", 1_800_000_000, "Service impact: Increased API Error Rates"),
    ]);
    expect(recovered).toMatchObject({ key: "ec2-eu-west-1_1800000000", op: "update", severity: "moderate", urgency: "past", sent: 1_800_007_200_000, description: "Text 1800007200" });
  });

  it("gives an informational message the urgency future, and a global service no region", () => {
    const report = reportOf([update("cloudfront", 1_800_000_000, "Informational message: Elevated Latency")]);
    expect(report).toMatchObject({ severity: "minor", urgency: "future", headline: "AWS (cloudfront): Informational message: Elevated Latency", parameters: { service: ["cloudfront"] } });
    expect(report.about.filter((subject) => subject.system === REGION_SYSTEM)).toEqual([]);
  });

  it("gives subjects that the core routes: each system is an entity system of the core", () => {
    for (const subject of reportOf(updatesOf(UAE)).about) expect(SUBJECT_SYSTEMS[subject.system as SubjectSystem], subject.id).toBe("entity");
    expect(knownKind("infra.cloud.outage")).toBe(true);
  });

  it("gives the same report for the same observation", () => {
    for (const body of eventBodies(ENTRIES).bodies) expect(mapObservation(observationOf(body))).toEqual(mapObservation(observationOf(body)));
  });

  it("gives a lossy problem and the value unknown for a status that the feed does not give", () => {
    const { reports, problems } = mapEntries([update("s3-eu-west-1", 1_800_000_000, "Paused: Something"), update("s3-eu-west-1", 1_799_999_000, "No status")])[0]!;
    expect(reports[0]).toMatchObject({ severity: "unknown", urgency: "unknown" });
    expect(problems.map((problem) => [problem.path, problem.fatal])).toEqual([
      ["latest.title", false],
      ["earlier[0].title", false],
      ["earlier", false],
    ]);
  });

  it("gives a fatal problem for an item with no key of a service, and for a body that is not JSON", () => {
    const loose = mapEntries([{ id: "urn:other", title: "Service impact: X" }]);
    expect(loose).toEqual([{ reports: [], problems: [{ path: "", message: "the observation is not one event of the AWS Health Dashboard: the format changed", fatal: true }] }]);
    expect(mapObservation(observationOf("<rss>")).problems[0]).toMatchObject({ message: "the body is not JSON", fatal: true });
  });

  it("gives a fatal problem and no report for an event with no time or no title", () => {
    const body = JSON.parse(eventBodies([update("rds-eu-west-1", 1_800_000_000, "Service impact: X")]).bodies[0]!) as Record<string, Record<string, unknown>>;
    for (const [path, latest] of [
      ["latest.time", { ...body["latest"], time: "soon" }],
      ["latest.title", { ...body["latest"], title: " " }],
    ] as const) {
      const { reports, problems } = mapObservation(observationOf(JSON.stringify({ ...body, latest })));
      expect(reports, path).toEqual([]);
      expect(problems.map((problem) => [problem.path, problem.fatal]), path).toEqual([[path, true]]);
    }
  });

  it("does not throw for any JSON body", () => {
    fc.assert(
      fc.property(fc.json(), (body) => {
        expect(Array.isArray(mapObservation(observationOf(body)).reports)).toBe(true);
      }),
    );
  });
});

describe("the values of the statuses", () => {
  it("gives the status of a title: the text before the first colon", () => {
    expect(statusOf("Service disruption: Increased Error Rates")).toBe("Service disruption");
    expect(statusOf("No status")).toBeUndefined();
    expect(statusOf(": empty")).toBeUndefined();
    expect(statusOf(undefined)).toBeUndefined();
  });

  it("gives a level for each status of the feed, and no severity to the recovery", () => {
    expect(Object.keys(LEVEL_OF_STATUS)).toEqual(["Informational message", "Service impact", "Performance issues", "Service degradation", "Service disruption", "Service is operating normally"]);
    expect(LEVEL_OF_STATUS["Service is operating normally"]).toEqual({ urgency: "past" });
  });
});
