import { quantileInterval } from "@mark1russell7/rigor-statistics";
import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { assess } from "./assess.ts";
import type { ObservationId, PersonId, PersonWatch, PlaceId, Report, SourceDescriptor, SourceId, WatchedPlace } from "./contracts.ts";
import { coverage } from "./coverage.ts";
import { reportId } from "./ids.ts";
import { carriages, delayLimit, delaysOf, lateness, lateSources, reportPasses, type Carriage, type Expectation } from "./lateness.ts";
import { incidents, normalize } from "./merge.ts";
import { NO_SYSTEM_LINES, SOURCE_SUBJECT, systemReports, type SystemSnapshot } from "./system-reports.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const TORNADO = "met.tornado";
const API = "api" as SourceId;
const WEA = "wea" as SourceId;

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };

// The second source carries each warning of the first source that has the parameter WEAHandling.
const EXPECT: Expectation = { id: "api-to-wea", from: API, to: WEA, when: { statuses: ["actual"], parameters: ["WEAHandling"] } };

function report(source: SourceId, key: string, received: number, fields: Partial<Report> = {}): Report {
  return {
    id: reportId({ source, key, sent: received }),
    source,
    origin: "nws",
    key,
    references: [],
    correlation: [{ system: "vtec", id: key }],
    status: "actual",
    op: "alert",
    kind: { code: TORNADO, label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: received,
    received,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: `observation:${source}:${key}` as ObservationId,
    parameters: source === API ? { WEAHandling: ["Imminent Threat"] } : {},
    ...fields,
  };
}

function checksOf(reports: readonly Report[], at = 10_000_000): Carriage[] {
  const state = normalize({ reports });
  return carriages(state, incidents(state, at), [EXPECT]);
}

function descriptor(id: SourceId, provider: string): SourceDescriptor {
  return {
    id,
    title: id === API ? "The API" : "The WEA feed",
    origins: ["nws"],
    dependsOn: [`provider:${provider}`],
    uses: ["internet", "power"],
    kinds: ["met"],
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval: 60_000,
    slowAfter: 10_000,
    auth: "none",
  };
}

describe("the filter of an expectation", () => {
  it("holds each field that is present", () => {
    const base = report(API, "w1", 0);
    expect(reportPasses({}, base)).toBe(true);
    expect(reportPasses({ statuses: ["actual"] }, base)).toBe(true);
    expect(reportPasses({ statuses: ["test"] }, base)).toBe(false);
    expect(reportPasses({ ops: ["update"] }, base)).toBe(false);
    expect(reportPasses({ kinds: ["met"] }, base)).toBe(true);
    expect(reportPasses({ kinds: ["met.flood"] }, base)).toBe(false);
    expect(reportPasses({ parameters: ["WEAHandling"] }, base)).toBe(true);
    expect(reportPasses({ parameters: ["WEAHandling"] }, { ...base, parameters: { WEAHandling: [] } })).toBe(false);
    expect(reportPasses({ parameters: ["WEAHandling"] }, { ...base, parameters: {} })).toBe(false);
  });
});

describe("the checks", () => {
  it("gives the delay of the copy in the same incident", () => {
    const checks = checksOf([report(API, "w1", 1_000), report(WEA, "w1", 61_000)]);
    expect(checks).toEqual([{ expectation: EXPECT.id, report: reportId({ source: API, key: "w1", sent: 1_000 }), started: 1_000, arrived: 61_000 }]);
    expect(delaysOf(checks, EXPECT.id)).toEqual([60_000]);
  });

  it("gives a negative delay when the copy came first", () => {
    expect(delaysOf(checksOf([report(API, "w1", 50_000), report(WEA, "w1", 20_000)]), EXPECT.id)).toEqual([-30_000]);
  });

  it("gives a check with no arrival when no copy came", () => {
    const [check] = checksOf([report(API, "w1", 1_000)]);
    expect(check).toBeDefined();
    expect(check!.arrived).toBeUndefined();
  });

  it("starts no check for a report that the filter does not pass", () => {
    expect(checksOf([report(API, "w1", 1_000, { parameters: {} })])).toEqual([]);
    expect(checksOf([report(WEA, "w1", 1_000)])).toEqual([]);
  });

  it("starts the check at the first report of the source, and takes the first copy", () => {
    const checks = checksOf([
      report(API, "w1", 5_000, { op: "update", key: "w1b", references: ["w1"] }),
      report(API, "w1", 1_000),
      report(WEA, "w1", 9_000),
      report(WEA, "w1", 7_000, { key: "w1c" }),
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ started: 1_000, arrived: 7_000 });
  });

  it("gives one check for each incident", () => {
    expect(checksOf([report(API, "w1", 1_000), report(API, "w2", 2_000), report(WEA, "w2", 3_000)]).map((check) => check.arrived)).toEqual([undefined, 3_000]);
  });

  for (const seed of SEEDS) {
    it(`does not change with the order of the reports (seed ${seed})`, () => {
      const rng = random(seed);
      const reports: Report[] = [];
      for (let warning = 0; warning < 12; warning += 1) {
        const start = Math.floor(rng.next() * 1_000_000);
        reports.push(report(API, `w${warning}`, start));
        if (rng.next() < 0.7) reports.push(report(WEA, `w${warning}`, start + Math.floor(rng.next() * 300_000) - 60_000));
        if (rng.next() < 0.3) reports.push(report(API, `w${warning}`, start + 1_000, { key: `w${warning}u`, op: "update" }));
      }
      const shuffled = [...reports];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const other = Math.floor(rng.next() * (index + 1));
        [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
      }
      expect(checksOf(shuffled)).toEqual(checksOf(reports));
    });
  }
});

describe("the limit of the delay", () => {
  it("gives no limit for a sample that is too small", () => {
    expect(delayLimit([], { quantile: 0.99, level: 0.95 })).toBeUndefined();
    expect(delayLimit([10, 20, 30, 40, 50], { quantile: 0.99, level: 0.95 })).toBeUndefined();
  });

  it("is the upper bound of the quantile of the delays", () => {
    const delays = Array.from({ length: 400 }, (_, index) => 30_000 + index * 500);
    const limit = delayLimit(delays, { quantile: 0.99, level: 0.95 });
    expect(limit).toBe(quantileInterval(delays, 0.99, 0.95).high);
    expect(limit!).toBeGreaterThanOrEqual(30_000 + 0.99 * 399 * 500);
  });

  it("is not less than 0", () => {
    const delays = Array.from({ length: 400 }, (_, index) => -100_000 + index);
    expect(delayLimit(delays, { quantile: 0.99, level: 0.95 })).toBe(0);
  });
});

describe("the lateness", () => {
  const check = (started: number, arrived?: number): Carriage => ({
    expectation: EXPECT.id,
    report: `r${started}` as Carriage["report"],
    started,
    ...(arrived === undefined ? {} : { arrived }),
  });
  const LIMIT = { [EXPECT.id]: 600_000 };

  it("only measures when the expectation has no limit", () => {
    expect(lateness([check(0)], [EXPECT], {}, 10_000_000)).toEqual([{ expectation: EXPECT.id, from: API, to: WEA, state: "no-limit", missed: [] }]);
  });

  it("gives no data before a check came or passed its limit, and the time of the next limit", () => {
    expect(lateness([], [EXPECT], LIMIT, 0)[0]).toMatchObject({ state: "no-data", missed: [] });
    const [pending] = lateness([check(1_000)], [EXPECT], LIMIT, 2_000);
    expect(pending).toMatchObject({ state: "no-data", missed: [], wakeAt: 601_000 });
  });

  it("is met when the copy came, also after the limit", () => {
    expect(lateness([check(0, 60_000)], [EXPECT], LIMIT, 100_000)[0]!.state).toBe("met");
    expect(lateness([check(0, 900_000)], [EXPECT], LIMIT, 1_000_000)[0]!.state).toBe("met");
  });

  it("is late when a check passes its limit with no copy", () => {
    expect(lateness([check(0)], [EXPECT], LIMIT, 599_999)[0]!.state).toBe("no-data");
    expect(lateness([check(0)], [EXPECT], LIMIT, 600_000)[0]).toMatchObject({ state: "late", missed: ["r0"], since: 600_000 });
  });

  it("counts a copy only when it came at or before the time", () => {
    expect(lateness([check(0, 700_000)], [EXPECT], LIMIT, 650_000)[0]!.state).toBe("late");
    expect(lateness([check(0, 700_000)], [EXPECT], LIMIT, 700_000)[0]!.state).toBe("met");
  });

  it("lists each miss after the last check that came, and a later copy ends the misses", () => {
    const checks = [check(0, 30_000), check(1_000_000), check(2_000_000), check(3_000_000)];
    const late = lateness(checks, [EXPECT], LIMIT, 3_100_000)[0]!;
    expect(late).toMatchObject({ state: "late", missed: ["r1000000", "r2000000"], since: 1_600_000, wakeAt: 3_600_000 });
    const back = lateness([...checks, check(4_000_000, 4_050_000)], [EXPECT], LIMIT, 4_100_000)[0]!;
    expect(back).toMatchObject({ state: "met", missed: [] });
  });

  it("gives the late sources", () => {
    const states = lateness([check(0)], [EXPECT, { ...EXPECT, id: "other", to: "x" as SourceId }], { [EXPECT.id]: 1, other: 1 }, 10);
    expect(lateSources(states)).toEqual([WEA]);
  });
});

describe("the effect of a late source", () => {
  const SOURCES = [descriptor(API, "api"), descriptor(WEA, "wea")];
  const HEALTH = SOURCES.map((source) => ({ source: source.id, state: "healthy" as const, since: 0, reason: "" }));

  it("does not count for the coverage, also when its health is up", () => {
    const input = { sources: SOURCES, health: HEALTH, places: [KANSAS], kinds: [TORNADO] };
    expect(coverage(input)[0]).toMatchObject({ independent: 2, sources: [API, WEA] });
    expect(coverage({ ...input, late: [WEA] })[0]).toMatchObject({ independent: 1, sources: [API] });
  });

  it("gives a line of system reports to the person who watches the sources", () => {
    const LIMIT = { [EXPECT.id]: 600_000 };
    const snap = (checks: readonly Carriage[], at: number): SystemSnapshot => ({
      sources: SOURCES,
      health: HEALTH,
      coverage: [],
      threats: [],
      lateness: lateness(checks, [EXPECT], LIMIT, at),
    });
    const first = { expectation: EXPECT.id, report: "r1" as Carriage["report"], started: 0 };
    const down = systemReports(NO_SYSTEM_LINES, snap([first], 700_000), 700_000);
    expect(down.reports).toMatchObject([
      {
        op: "alert",
        status: "system",
        kind: { code: "system.health.late" },
        onset: 600_000,
        about: [{ system: SOURCE_SUBJECT, id: WEA, label: "The WEA feed" }],
        headline: "The WEA feed is late: it did not carry the reports of The API in time.",
        description: "Reports with no copy: 1. The limit of the delay is 600 seconds, from the measured delays.",
      },
    ]);

    const operator: PersonWatch = { person: "person:op" as PersonId, places: [], rules: [], subjects: [{ system: SOURCE_SUBJECT }] };
    const neighbor: PersonWatch = { person: "person:n" as PersonId, places: [KANSAS.id], rules: [] };
    const [incident] = incidents(normalize({ reports: down.reports }), 700_000);
    expect(assess(incident!, operator, [KANSAS]).level).toBe("notice");
    expect(assess(incident!, neighbor, [KANSAS]).level).toBe("none");

    const second = { ...first, report: "r2" as Carriage["report"], started: 1_000_000 };
    const more = systemReports(down.lines, snap([first, second], 1_700_000), 1_700_000);
    expect(more.reports).toMatchObject([{ op: "update", references: [down.reports[0]!.key] }]);

    const back = systemReports(more.lines, snap([first, second, { ...second, report: "r3" as Carriage["report"], started: 2_000_000, arrived: 2_010_000 }], 2_100_000), 2_100_000);
    expect(back.reports).toMatchObject([{ op: "cancel", response: ["allclear"], kind: { code: "system.health.late" } }]);
    expect(back.lines.open).toEqual({});
  });
});
