import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { assess } from "./assess.ts";
import type { Coverage, HealthState, Incident, PersonId, PersonWatch, PlaceId, Report, ReportId, SourceDescriptor, SourceHealth, SourceId, WatchedPlace } from "./contracts.ts";
import { incidents, normalize } from "./merge.ts";
import { gapGrade, NO_SYSTEM_LINES, SOURCE_SUBJECT, SYSTEM_SOURCE, systemReports, threats, type SystemLines, type SystemSnapshot } from "./system-reports.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const TORNADO = "met.tornado";

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = {
  id: "place:a" as PlaceId,
  codes: [
    { system: "ugc", code: "KSZ083" },
    { system: "same", code: "020173" },
    { system: "state", code: "KS" },
  ],
  bufferKm: 0,
};
const TEXAS: WatchedPlace = { id: "place:b" as PlaceId, codes: [{ system: "same", code: "048029" }], bufferKm: 0 };
const PLACES = [KANSAS, TEXAS];

const API: SourceDescriptor = {
  id: "api" as SourceId,
  title: "The API",
  origins: ["nws"],
  dependsOn: ["provider:api"],
  uses: ["internet", "power"],
  kinds: ["met"],
  coverage: [{ type: "code", system: "state", code: "KS" }],
  transport: "poll",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
};

const OPERATOR: PersonWatch = { person: "person:op" as PersonId, places: [KANSAS.id], rules: [], subjects: [{ system: SOURCE_SUBJECT }] };
const NEIGHBOR: PersonWatch = { person: "person:n" as PersonId, places: [KANSAS.id], rules: [] };

function healthOf(state: HealthState, since = 0): SourceHealth {
  return { source: API.id, state, since, reason: `The reason at ${since}.` };
}

function gap(fields: Partial<Coverage> = {}): Coverage {
  return { place: KANSAS.id, kind: TORNADO, sources: [], independent: 0, proven: true, faults: [], commonResources: [], required: 2, ...fields };
}

function snapshot(fields: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return { sources: [API], health: [], coverage: [], threats: [], ...fields };
}

// The levels of the live incidents of all the reports, for one person.
function levels(reports: readonly Report[], person: PersonWatch, at = 1_000_000): string[] {
  return incidents(normalize({ reports }), at).map((incident) => assess(incident, person, PLACES).level);
}

describe("the health reports", () => {
  it("gives an alert, an update, a cancel and then a new line", () => {
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf("failing", 10)] }), 100);
    expect(down.reports).toHaveLength(1);
    const [alert] = down.reports;
    expect(alert).toMatchObject({
      source: SYSTEM_SOURCE,
      status: "system",
      op: "alert",
      references: [],
      kind: { code: "system.health.failing" },
      onset: 10,
      areas: [],
      about: [{ system: SOURCE_SUBJECT, id: "api", label: "The API" }],
      headline: "The API: the fetches fail.",
      description: "The reason at 10.",
    });
    expect(down.observations.map((observation) => observation.id)).toEqual([alert!.observation]);

    // The same state with a new reason gives no report.
    const again = systemReports(down.lines, snapshot({ health: [{ ...healthOf("failing", 10), reason: "Another count." }] }), 200);
    expect(again.reports).toEqual([]);
    expect(again.lines).toEqual(down.lines);

    const silent = systemReports(again.lines, snapshot({ health: [healthOf("silent", 300)] }), 300);
    expect(silent.reports).toMatchObject([{ op: "update", references: [alert!.key], kind: { code: "system.health.silent" } }]);

    const up = systemReports(silent.lines, snapshot({ health: [healthOf("healthy", 400)] }), 400);
    expect(up.reports).toMatchObject([{ op: "cancel", references: [silent.reports[0]!.key], response: ["allclear"], kind: { code: "system.health.silent" } }]);
    expect(up.lines.open).toEqual({});

    const downAgain = systemReports(up.lines, snapshot({ health: [healthOf("changed", 500)] }), 500);
    expect(downAgain.reports).toMatchObject([{ op: "alert", references: [] }]);
    expect(new Set([alert, ...silent.reports, ...up.reports, ...downAgain.reports].map((report) => report!.key)).size).toBe(4);
  });

  it("starts no line for a source that is up or unknown", () => {
    for (const state of ["healthy", "slow", "unknown"] as const) {
      expect(systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf(state)] }), 1).reports).toEqual([]);
    }
  });

  it("goes to the person who watches the sources, at notice, until the cancel", () => {
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf("failing")] }), 100);
    expect(levels(down.reports, OPERATOR)).toEqual(["notice"]);
    expect(levels(down.reports, NEIGHBOR)).toEqual(["none"]);
    const [incident] = incidents(normalize({ reports: down.reports }), 200);
    expect(assess(incident!, NEIGHBOR, PLACES).reasons).toEqual([{ kind: "no-subject" }]);
    const up = systemReports(down.lines, snapshot({ health: [healthOf("healthy")] }), 300);
    expect(levels([...down.reports, ...up.reports], OPERATOR)).toEqual(["none"]);
  });

  it("matches a watch of one source only", () => {
    const down = systemReports(NO_SYSTEM_LINES, snapshot({ health: [healthOf("failing")] }), 100);
    const one = (id: string): PersonWatch => ({ ...NEIGHBOR, subjects: [{ system: SOURCE_SUBJECT, id }] });
    expect(levels(down.reports, one("api"))).toEqual(["notice"]);
    expect(levels(down.reports, one("radio"))).toEqual(["none"]);
  });
});

describe("the coverage reports", () => {
  const warning: Incident = {
    anchor: "w".repeat(64) as ReportId,
    reports: ["w".repeat(64) as ReportId],
    status: "actual",
    kind: { code: TORNADO, significance: "warning", label: "Tornado Warning" },
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    live: true,
    corroboration: 1,
  };

  it("finds the threats: live, actual, a watch, a warning or no stage, at a watched place", () => {
    expect(threats([warning], PLACES)).toEqual([{ place: KANSAS.id, kind: TORNADO }]);
    expect(threats([{ ...warning, kind: { code: TORNADO, label: "Tornado" } }], PLACES)).toHaveLength(1);
    expect(threats([{ ...warning, live: false }], PLACES)).toEqual([]);
    expect(threats([{ ...warning, status: "test" }], PLACES)).toEqual([]);
    expect(threats([{ ...warning, kind: { code: TORNADO, significance: "statement", label: "Statement" } }], PLACES)).toEqual([]);
    expect(threats([{ ...warning, areas: [{ type: "code", system: "same", code: "020001" }] }], PLACES)).toEqual([]);
  });

  it("grades a gap by its count and its threat", () => {
    expect(gapGrade(gap(), true)).toEqual({ severity: "extreme", urgency: "immediate" });
    expect(gapGrade(gap(), false)).toEqual({ severity: "severe", urgency: "expected" });
    expect(gapGrade(gap({ independent: 1 }), true)).toEqual({ severity: "severe", urgency: "expected" });
    expect(gapGrade(gap({ independent: 2, proven: false }), true)).toEqual({ severity: "moderate", urgency: "expected" });
  });

  it("wakes the people of the place at no coverage during a warning, and only then", () => {
    const quiet = systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [gap()] }), 100);
    expect(quiet.reports).toMatchObject([{ op: "alert", areas: [{ type: "place", place: KANSAS.id }], kind: { code: "system.coverage.met.tornado" }, instruction: expect.any(String) }]);
    expect(levels(quiet.reports, NEIGHBOR)).toEqual(["urgent"]);

    const threat = systemReports(quiet.lines, snapshot({ coverage: [gap()], threats: threats([warning], PLACES) }), 200);
    expect(threat.reports).toMatchObject([{ op: "update", references: [quiet.reports[0]!.key], severity: "extreme" }]);
    expect(levels([...quiet.reports, ...threat.reports], NEIGHBOR)).toEqual(["life-safety"]);

    // The people of another place get nothing.
    const away: PersonWatch = { ...NEIGHBOR, places: [TEXAS.id] };
    expect(levels([...quiet.reports, ...threat.reports], away)).toEqual(["none"]);
  });

  it("gives notice for one domain short of a kind that is not life-safety, and for a count that is not proven", () => {
    const winter = systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [gap({ kind: "met.winter", required: 2, independent: 1, faults: ["cdn:x"] })] }), 100);
    expect(levels(winter.reports, NEIGHBOR)).toEqual(["notice"]);
    expect(winter.reports[0]!.description).toBe("A fault of cdn:x stops each source that covers met.winter at this place.");
    const unproven = systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [gap({ independent: 2, proven: false, faults: ["a", "b"] })] }), 100);
    expect(levels(unproven.reports, NEIGHBOR)).toEqual(["notice"]);
  });

  it("gives an urgent push for one domain short of a life-safety kind", () => {
    const one = systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [gap({ independent: 1, faults: ["cdn:x"], commonResources: ["power"] })] }), 100);
    expect(levels(one.reports, NEIGHBOR)).toEqual(["urgent"]);
    expect(one.reports[0]!.description).toContain("Each of these sources uses the power of this place.");
  });

  it("starts no line for a coverage that is not short, and cancels a line when the coverage is back", () => {
    const full = gap({ independent: 2, faults: ["a", "b"] });
    expect(systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [full] }), 1).reports).toEqual([]);
    const short = systemReports(NO_SYSTEM_LINES, snapshot({ coverage: [gap()] }), 1);
    const back = systemReports(short.lines, snapshot({ coverage: [full] }), 2);
    expect(back.reports).toMatchObject([{ op: "cancel", areas: [{ type: "place", place: KANSAS.id }] }]);
    expect(levels([...short.reports, ...back.reports], NEIGHBOR)).toEqual(["none"]);
  });
});

describe("the properties of the fold", () => {
  const states: HealthState[] = ["unknown", "healthy", "slow", "failing", "silent", "changed"];
  const sources = ["a", "b", "c"].map((id) => ({ ...API, id: id as SourceId, title: `Source ${id}` }));

  it.each(SEEDS)("keeps one open line for each condition, and links each line (seed %i)", (seed) => {
    const r = random(seed);
    let lines: SystemLines = NO_SYSTEM_LINES;
    const all: Report[] = [];
    for (let step = 0; step < 120; step += 1) {
      const health = sources.filter(() => r.chance(0.8)).map((source) => ({ source: source.id, state: r.pick(states), since: step, reason: "" }));
      const coverage = [KANSAS, TEXAS].flatMap((place) =>
        [TORNADO, "met.winter"].filter(() => r.chance(0.5)).map((kind) => gap({ place: place.id, kind, independent: r.int(0, 2), proven: r.chance(0.9) })),
      );
      const input = snapshot({ sources, health, coverage, threats: r.chance(0.3) ? [{ place: KANSAS.id, kind: TORNADO }] : [] });
      const before = lines;
      const result = systemReports(lines, input, step * 1_000);
      const label = `seed ${seed} step ${step}`;
      // Each update and cancel references the last key of its line, and an alert starts a line.
      for (const report of result.reports) {
        const name = report.key.slice(0, report.key.lastIndexOf("#"));
        expect(report.references, label).toEqual(report.op === "alert" ? [] : [before.open[name]!.key]);
      }
      // The open lines are the conditions of the snapshot.
      const down = health.filter((entry) => ["failing", "silent", "changed"].includes(entry.state)).length;
      const short = coverage.filter((entry) => !entry.proven || entry.independent < entry.required).length;
      expect(Object.keys(result.lines.open), label).toHaveLength(down + short);
      // The same snapshot again gives no report.
      expect(systemReports(result.lines, input, step * 1_000 + 1).reports, label).toEqual([]);
      lines = result.lines;
      all.push(...result.reports);
      // The live incidents of the merge are the open lines.
      const live = incidents(normalize({ reports: all }), step * 1_000).filter((incident) => incident.live);
      expect(live, label).toHaveLength(down + short);
    }
    expect(new Set(all.map((report) => report.key)).size).toBe(all.length);
  });
});
