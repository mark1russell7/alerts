import { destinationKm, distanceKm } from "@mark1russell7/geo";
import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { Area, ObservationId, Position, Report, SourceId, Status } from "./contracts.ts";
import { reportId } from "./ids.ts";
import { DEFAULT_LINK_POLICY, MAGNITUDE_PARAMETER, linkRule, type LinkPolicy } from "./link.ts";
import { incidents, normalize, type LinkRule } from "./merge.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const SECOND = 1_000;
const HOUR = 3_600_000;
// A start of a slot: T0 is a multiple of the window of 30 s.
const T0 = 1_763_157_600_000;
// The epicenter of the tests: a point in the open ocean.
const HERE = { lat: 30, lon: -40 };
const RULE = linkRule(DEFAULT_LINK_POLICY);

interface Quake {
  readonly key: string;
  readonly source?: string;
  readonly status?: Status;
  readonly kind?: string;
  /** The onset, or `null` for a report with no onset. */
  readonly onset?: number | null;
  /** The epicenter, as the distance in kilometers north of `HERE`. */
  readonly northKm?: number;
  /** The text of the parameter `magnitude`, or `null` for a report with no magnitude. */
  readonly magnitude?: string | null;
  readonly areas?: readonly Area[];
}

function at(northKm: number): Position {
  const point = destinationKm(HERE, 0, northKm);
  return [point.lon, point.lat];
}

function quake(q: Quake): Report {
  const source = (q.source ?? "usgs") as SourceId;
  const onset = q.onset === undefined ? T0 : q.onset;
  const sent = onset ?? T0;
  return {
    id: reportId({ source, key: q.key, sent }),
    source,
    origin: source,
    key: q.key,
    references: [],
    correlation: [],
    status: q.status ?? "actual",
    op: "alert",
    kind: { code: q.kind ?? "geo.earthquake", label: "Earthquake" },
    categories: ["geo"],
    severity: "moderate",
    urgency: "past",
    certainty: "observed",
    response: [],
    sent,
    received: sent,
    ...(onset === null ? {} : { onset }),
    expires: sent + HOUR,
    areas: q.areas ?? [{ type: "circle", center: at(q.northKm ?? 0), radiusKm: 50 }],
    about: [],
    sender: source,
    headline: "Earthquake",
    observation: "0".repeat(64) as ObservationId,
    parameters: q.magnitude === null ? {} : { [MAGNITUDE_PARAMETER]: [q.magnitude ?? "4.5"] },
  };
}

/** This function gives the size of each incident of the reports, from the smallest. */
function sizes(reports: readonly Report[], rule: LinkRule = RULE): number[] {
  return incidents(normalize({ reports }), T0, { link: rule })
    .map((incident) => incident.reports.length)
    .sort((a, b) => a - b);
}

describe("the link rule of the earthquakes (merge rule 3)", () => {
  it("joins the reports of one earthquake from two sources into one incident with two origins", () => {
    // The capture of 2026-11-16 had a largest time difference of 6.3 s.
    const usgs = quake({ key: "us1", magnitude: "4.5" });
    const emsc = quake({ key: "em1", source: "emsc", onset: T0 + 6_300, northKm: 20, magnitude: "4.3" });
    const [one, ...rest] = incidents(normalize({ reports: [usgs, emsc] }), T0, { link: RULE });
    expect(rest).toEqual([]);
    expect(one?.reports).toHaveLength(2);
    expect(one?.corroboration).toBe(2);
  });

  it("keeps the reports of one source apart: an aftershock 25 s later and 10 km away is a second incident", () => {
    const main = quake({ key: "us1", magnitude: "4.5" });
    const after = quake({ key: "us2", onset: T0 + 25 * SECOND, northKm: 10, magnitude: "4.0" });
    expect(RULE.matches(main, after)).toBe(false);
    expect(sizes([main, after])).toEqual([1, 1]);
  });

  it("joins two events of one source through a report of another source between them (a known limit)", () => {
    // A1 and A2 are two real events of one source. E1 of another source is near each of them.
    const a1 = quake({ key: "a1", magnitude: "4.5" });
    const a2 = quake({ key: "a2", onset: T0 + 25 * SECOND, northKm: 10, magnitude: "4.0" });
    const e1 = quake({ key: "e1", source: "emsc", onset: T0 + 12 * SECOND, northKm: 5, magnitude: "4.3" });
    expect(sizes([a1, a2, e1])).toEqual([3]);
    expect(sizes([a1, a2])).toEqual([1, 1]);
  });

  it.each<[string, Partial<Quake>, boolean]>([
    ["30 s apart", { onset: T0 + 30 * SECOND }, true],
    ["30.001 s apart", { onset: T0 + 30 * SECOND + 1 }, false],
    ["99 km apart", { northKm: 99 }, true],
    ["101 km apart", { northKm: 101 }, false],
    ["the magnitudes 3.1 and 2.1", { magnitude: "2.1" }, true],
    ["the magnitudes 3.1 and 2.0", { magnitude: "2.0" }, false],
  ])("at the limits of the first policy: %s links is %s", (_name, change, links) => {
    const usgs = quake({ key: "us1", magnitude: "3.1" });
    const emsc = quake({ key: "em1", source: "emsc", magnitude: "3.1", ...change });
    expect(RULE.matches(usgs, emsc)).toBe(links);
    expect(RULE.matches(emsc, usgs)).toBe(links);
    expect(sizes([usgs, emsc])).toEqual(links ? [2] : [1, 1]);
  });

  it("measures the distances of the limit cases with the great circle", () => {
    expect(distanceKm(HERE, { lat: at(99)[1], lon: at(99)[0] })).toBeCloseTo(99, 6);
    expect(distanceKm(HERE, { lat: at(101)[1], lon: at(101)[0] })).toBeCloseTo(101, 6);
  });

  it("links an onset at each side of the start of a slot", () => {
    const before = quake({ key: "us1", onset: T0 - 10 * SECOND });
    const after = quake({ key: "em1", source: "emsc", onset: T0 + 10 * SECOND });
    const blocksOf = (report: Report): Set<string> => new Set(RULE.blocks(report));
    expect([...blocksOf(before)].some((block) => blocksOf(after).has(block))).toBe(true);
    expect(sizes([before, after])).toEqual([2]);
  });

  it.each<[string, Partial<Quake>]>([
    ["no onset", { onset: null }],
    ["no circle area", { areas: [{ type: "code", system: "fips", code: "020173" }] }],
    ["no magnitude", { magnitude: null }],
    ["a magnitude that is not a number", { magnitude: "4.5 mb" }],
    ["an empty magnitude", { magnitude: "" }],
  ])("links a report with %s to no report", (_name, change) => {
    const usgs = quake({ key: "us1" });
    const emsc = quake({ key: "em1", source: "emsc", ...change });
    expect(RULE.blocks(emsc)).toEqual([]);
    expect(RULE.matches(usgs, emsc)).toBe(false);
    expect(sizes([usgs, emsc])).toEqual([1, 1]);
  });

  it("links a report with no magnitude when the policy has no limit of the magnitude", () => {
    const rule = linkRule({ families: [{ family: "geo.earthquake", windowMs: 30_000, distanceKm: 100 }] });
    const usgs = quake({ key: "us1" });
    const emsc = quake({ key: "em1", source: "emsc", magnitude: null });
    expect(rule.matches(usgs, emsc)).toBe(true);
    expect(sizes([usgs, emsc], rule)).toEqual([2]);
  });

  it("links a report with two values of the magnitude to no report", () => {
    const usgs = quake({ key: "us1" });
    const emsc: Report = { ...quake({ key: "em1", source: "emsc" }), parameters: { [MAGNITUDE_PARAMETER]: ["4.5", "4.6"] } };
    expect(RULE.matches(usgs, emsc)).toBe(false);
  });

  it("links no report of another kind, and no report of another status", () => {
    const usgs = quake({ key: "us1" });
    const tsunami = quake({ key: "ts1", source: "ptwc", kind: "geo.tsunami" });
    const exercise = quake({ key: "em1", source: "emsc", status: "exercise" });
    expect(RULE.blocks(tsunami)).toEqual([]);
    expect(RULE.matches(usgs, tsunami)).toBe(false);
    expect(sizes([usgs, tsunami, exercise])).toEqual([1, 1, 1]);
  });

  it("takes the families of the policy as data", () => {
    const policy: LinkPolicy = { families: [...DEFAULT_LINK_POLICY.families, { family: "geo.tsunami", windowMs: 10 * 60_000, distanceKm: 500 }] };
    const rule = linkRule(policy);
    const first = quake({ key: "ts1", source: "ptwc", kind: "geo.tsunami", magnitude: null });
    const second = quake({ key: "ts2", source: "ntwc", kind: "geo.tsunami", onset: T0 + 5 * 60_000, northKm: 300, magnitude: null });
    expect(sizes([first, second])).toEqual([1, 1]);
    expect(sizes([first, second], rule)).toEqual([2]);
    // The earthquakes keep the limits of their own family.
    expect(sizes([quake({ key: "us1" }), quake({ key: "em1", source: "emsc", onset: T0 + 60 * SECOND })], rule)).toEqual([1, 1]);
  });

  it.each([0, -1, Number.NaN])("refuses a window of %s ms", (windowMs) => {
    expect(() => linkRule({ families: [{ family: "geo.earthquake", windowMs, distanceKm: 100 }] })).toThrow(RangeError);
  });

  it("links no report for a policy with no family", () => {
    const rule = linkRule({ families: [] });
    expect(sizes([quake({ key: "us1" }), quake({ key: "em1", source: "emsc" })], rule)).toEqual([1, 1]);
  });
});

// A random report near HERE, so that some pairs link and some do not.
function randomQuake(r: Random, index: number): Report {
  return quake({
    key: `q${index}`,
    source: r.pick(["usgs", "emsc", "gfz"]),
    status: r.chance(0.9) ? "actual" : "exercise",
    kind: r.chance(0.9) ? "geo.earthquake" : "geo.tsunami",
    onset: r.chance(0.08) ? null : T0 + r.int(-90, 90) * SECOND + r.below(SECOND),
    northKm: r.int(0, 300),
    magnitude: r.chance(0.08) ? null : r.chance(0.05) ? "M4" : (r.int(20, 60) / 10).toFixed(1),
    ...(r.chance(0.08) ? { areas: [{ type: "code" as const, system: "fips", code: "020173" }] } : {}),
  });
}

// The incidents of the brute force: the connected components of the graph of each pair that matches.
function bruteForce(reports: readonly Report[], rule: LinkRule): string[][] {
  const parent = reports.map((_, index) => index);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  for (let i = 0; i < reports.length; i += 1) {
    for (let j = i + 1; j < reports.length; j += 1) {
      if (reports[i]!.status === reports[j]!.status && rule.matches(reports[i]!, reports[j]!)) parent[root(i)] = root(j);
    }
  }
  const groups = new Map<number, string[]>();
  reports.forEach((report, index) => groups.set(root(index), [...(groups.get(root(index)) ?? []), report.id]));
  return [...groups.values()].map((group) => group.sort()).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

describe("the laws of the link rule", () => {
  it.each(SEEDS)("is symmetric, never links one source, and each match shares a block (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 400; round += 1) {
      const a = randomQuake(r, 0);
      const b = randomQuake(r, 1);
      const matches = RULE.matches(a, b);
      expect(RULE.matches(b, a)).toBe(matches);
      if (a.source === b.source) expect(matches).toBe(false);
      if (matches) expect(RULE.blocks(a).some((block) => RULE.blocks(b).includes(block))).toBe(true);
    }
  });

  it.each(SEEDS)("gives the incidents of the brute force for each order of the reports (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 40; round += 1) {
      const reports = Array.from({ length: r.int(0, 25) }, (_, index) => randomQuake(r, index));
      const expected = bruteForce(normalize({ reports }).reports, RULE);
      const found = incidents(normalize({ reports: r.shuffle(reports) }), T0, { link: RULE }).map((incident) => [...incident.reports]);
      expect(found).toEqual(expected);
    }
  });
});
