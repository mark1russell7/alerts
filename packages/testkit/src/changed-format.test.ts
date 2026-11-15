import { describe, expect, it } from "vitest";
import {
  changeOf,
  FORMAT_ARMS,
  type FormatArm,
  type FormatBaseline,
  type FormatRecord,
  formatVerdictOf,
  type LevelChange,
  runChangedFormat,
} from "./changed-format.ts";

const SENT = "2026-11-14T09:54:00-09:00";
const collection = (): unknown => ({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { sent: SENT, severity: "Extreme", urgency: "Expected", geocode: { UGC: ["AKZ001"], SAME: ["002001"] } },
    },
    { type: "Feature", properties: { sent: SENT, severity: "Unknown", urgency: "Unknown", geocode: { UGC: ["AKZ002"] } } },
  ],
});
const propertiesOf = (body: unknown, index: number): Record<string, unknown> =>
  ((body as { features: { properties: Record<string, unknown> }[] }).features[index]?.properties ?? {});

describe("changeOf", () => {
  it("makes each key of each geocode lowercase", () => {
    const body = changeOf("geocode-renamed", collection());
    expect(propertiesOf(body, 0)["geocode"]).toEqual({ ugc: ["AKZ001"], same: ["002001"] });
    expect(propertiesOf(body, 1)["geocode"]).toEqual({ ugc: ["AKZ002"] });
  });

  it("renames the list of the collection, and keeps its other keys", () => {
    const body = changeOf("features-renamed", collection()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["type", "alerts"]);
    expect(body["alerts"]).toEqual((collection() as { features: unknown }).features);
  });

  it("gives the sent time as milliseconds since 1970", () => {
    expect(propertiesOf(changeOf("sent-epoch", collection()), 0)["sent"]).toBe(Date.parse(SENT));
  });

  it("renames the known severities and urgencies, and keeps Unknown", () => {
    const severity = changeOf("severity-renamed", collection());
    expect([propertiesOf(severity, 0)["severity"], propertiesOf(severity, 1)["severity"]]).toEqual(["Critical", "Unknown"]);
    const urgency = changeOf("urgency-renamed", collection());
    expect([propertiesOf(urgency, 0)["urgency"], propertiesOf(urgency, 1)["urgency"]]).toEqual(["Soon", "Unknown"]);
  });

  it("adds a field to each alert", () => {
    const body = changeOf("field-added", collection());
    expect([propertiesOf(body, 0)["colour"], propertiesOf(body, 1)["colour"]]).toEqual(["red", "red"]);
  });

  it("does not change its input, and refuses a body that is not a feature collection", () => {
    const input = collection();
    for (const arm of FORMAT_ARMS) changeOf(arm, input);
    expect(input).toEqual(collection());
    expect(() => changeOf("field-added", { type: "FeatureCollection" })).toThrow("not a feature collection");
  });
});

describe("formatVerdictOf", () => {
  const baseline: FormatBaseline = {
    whole: true,
    outcome: { ok: true, complete: true, observations: 15 },
    reports: 2,
    problems: [],
    health: "healthy",
    at: Date.parse(SENT),
    levels: [
      { report: "a", level: "urgent" },
      { report: "b", level: "none" },
    ],
  };
  const same: readonly LevelChange[] = baseline.levels.map(({ report, level }) => ({ report, before: level, after: level }));
  const dropped: readonly LevelChange[] = [
    { report: "a", before: "urgent", after: "digest" },
    { report: "b", before: "none", after: "none" },
  ];
  const record = (arm: FormatArm, health: FormatRecord["health"], levels: readonly LevelChange[]): FormatRecord => ({
    arm,
    answered: true,
    outcome: { ok: true, complete: true, observations: 15 },
    canary: true,
    reports: 2,
    fatal: [],
    other: [],
    health,
    levels,
  });
  const all = (health: (arm: FormatArm) => FormatRecord["health"], levels: (arm: FormatArm) => readonly LevelChange[]): FormatRecord[] =>
    FORMAT_ARMS.map((arm) => record(arm, health(arm), levels(arm)));

  it("passes when each change keeps each level or moves the health, and the field keeps both", () => {
    const records = all(
      (arm) => (arm === "field-added" ? "healthy" : arm === "geocode-renamed" ? "changed" : "healthy"),
      (arm) => (arm === "geocode-renamed" ? dropped : same),
    );
    expect(formatVerdictOf(baseline, records)).toMatchObject({ read: true, pass: true, problems: [] });
  });

  it("fails a silent change of a level", () => {
    const verdict = formatVerdictOf(
      baseline,
      all(
        () => "healthy",
        (arm) => (arm === "severity-renamed" ? dropped : same),
      ),
    );
    expect(verdict).toMatchObject({ read: true, pass: false });
    expect(verdict.gates["severity-renamed"]).toBe(false);
    expect(verdict.problems).toEqual(["severity-renamed: 1 levels changed silently: the health is healthy"]);
  });

  it("passes a told change in the state failing", () => {
    const verdict = formatVerdictOf(
      baseline,
      all(
        (arm) => (arm === "features-renamed" ? "failing" : "healthy"),
        (arm) => (arm === "features-renamed" ? dropped : same),
      ),
    );
    expect(verdict.pass).toBe(true);
  });

  it("fails a false change of the health, or of a level, for a change that keeps the meaning", () => {
    const health = formatVerdictOf(
      baseline,
      all(
        (arm) => (arm === "field-added" ? "changed" : "healthy"),
        () => same,
      ),
    );
    expect(health.gates["field-added"]).toBe(false);
    const level = formatVerdictOf(
      baseline,
      all(
        () => "healthy",
        (arm) => (arm === "field-added" ? dropped : same),
      ),
    );
    expect(level.gates["field-added"]).toBe(false);
  });

  it("has no read, and no pass, when an arm has no answer, no canary or no record", () => {
    const good = all(
      () => "healthy",
      () => same,
    );
    const noAnswer = good.map((r) => (r.arm === "sent-epoch" ? { ...r, answered: false } : r));
    const noCanary = good.map((r) => (r.arm === "sent-epoch" ? { ...r, canary: false } : r));
    const missing = good.filter((r) => r.arm !== "sent-epoch");
    for (const records of [noAnswer, noCanary, missing]) expect(formatVerdictOf(baseline, records)).toMatchObject({ read: false, pass: false });
  });

  it("has no read when the baseline is not whole, not healthy or has no alert with a level", () => {
    const good = all(
      () => "healthy",
      () => same,
    );
    const broken: FormatBaseline[] = [
      { ...baseline, whole: false },
      { ...baseline, health: "changed" },
      { ...baseline, levels: baseline.levels.map(({ report }) => ({ report, level: "none" })) },
    ];
    for (const one of broken) expect(formatVerdictOf(one, good)).toMatchObject({ read: false, pass: false });
  });
});

describe("runChangedFormat", () => {
  it("answers the main query of each arm with its changed body, and reads", async () => {
    const run = await runChangedFormat();
    expect(run.baseline).toMatchObject({ whole: true, health: "healthy", outcome: { ok: true, complete: true } });
    expect(run.records.map((r) => [r.arm, r.answered, r.canary])).toEqual(FORMAT_ARMS.map((arm) => [arm, true, true]));
    expect(run.records.find((r) => r.arm === "field-added")?.reports).toBe(run.baseline.reports);
    expect(run.verdict.read).toBe(true);
  }, 60_000);
});
