import { distanceKm, locatePoint } from "@mark1russell7/geo";
import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type {
  AssessedLevel,
  Incident,
  LevelRule,
  LevelTable,
  PersonId,
  PersonWatch,
  PlaceId,
  Position,
  ReportId,
  Severity,
  Status,
  Urgency,
  WatchedPlace,
} from "./contracts.ts";
import { ASSESSED_LEVELS } from "./contracts.ts";
import {
  DEFAULT_ASSESS_POLICY,
  LIFE_SAFETY_KINDS,
  admits,
  assess,
  classOf,
  hasKind,
  higherLevel,
  matchPlaces,
  matchSubjects,
  regionCovers,
  tableLevel,
} from "./assess.ts";
import { assessmentSchema } from "./schemas.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

// The CAP values from the lowest, without `unknown`.
const SEVERITIES: readonly Severity[] = ["minor", "moderate", "severe", "extreme"];
const URGENCIES: readonly Urgency[] = ["past", "future", "expected", "immediate"];
const STATUSES: readonly Status[] = ["actual", "exercise", "system", "test", "draft"];

// Public places in Kansas and Texas: Sedgwick County KS and Bexar County TX.
const home = "place-1" as PlaceId;
const other = "place-2" as PlaceId;
const places: readonly WatchedPlace[] = [
  {
    id: home,
    codes: [
      { system: "ugc", code: "KSZ083" },
      { system: "ugc", code: "KSC173" },
      { system: "same", code: "020173" },
    ],
    bufferKm: 5,
  },
  {
    id: other,
    codes: [
      { system: "ugc", code: "TXC029" },
      { system: "same", code: "048029" },
    ],
    bufferKm: 5,
  },
];
const atHome = [{ type: "code", system: "ugc", code: "KSC173" }] as const;
const atOther = [{ type: "code", system: "same", code: "048029" }] as const;

function person(rules: readonly LevelRule[] = [], watched: readonly PlaceId[] = [home, other]): PersonWatch {
  return { person: "person-1" as PersonId, places: watched, rules };
}

// The builder takes the kind as its code.
type Draft = Omit<Partial<Incident>, "kind"> & { readonly kind?: string };

function incident({ kind = "met.tornado", ...fields }: Draft = {}): Incident {
  return {
    anchor: "a".repeat(64) as ReportId,
    reports: ["a".repeat(64) as ReportId],
    status: "actual",
    kind: { code: kind, label: kind },
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    areas: atHome,
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

const rank = (level: AssessedLevel): number => ASSESSED_LEVELS.indexOf(level);

describe("the first table", () => {
  // The CAP values that the NWS gives to these products.
  const products: readonly [string, Draft, AssessedLevel][] = [
    ["a tornado warning", { kind: "met.tornado", severity: "extreme", urgency: "immediate" }, "life-safety"],
    ["a tornado watch", { kind: "met.tornado", severity: "extreme", urgency: "future" }, "urgent"],
    ["a flash flood warning", { kind: "met.flood.flash", severity: "severe", urgency: "immediate" }, "life-safety"],
    ["a severe thunderstorm warning", { kind: "met.thunderstorm.severe", severity: "severe", urgency: "immediate" }, "urgent"],
    ["a severe thunderstorm watch", { kind: "met.thunderstorm.severe", severity: "severe", urgency: "future" }, "notice"],
    ["a winter storm warning", { kind: "met.winter.storm", severity: "moderate", urgency: "expected" }, "notice"],
    ["a wind advisory", { kind: "met.wind.high", severity: "minor", urgency: "expected" }, "digest"],
    ["a tornado warning that passed", { kind: "met.tornado", severity: "extreme", urgency: "past" }, "digest"],
    ["an Emergency Action Notification", { kind: "safety.national-emergency", severity: "extreme", urgency: "immediate" }, "life-safety"],
    ["a typhoon warning", { kind: "met.tropical.typhoon", severity: "extreme", urgency: "expected" }, "life-safety"],
    ["a debris flow warning", { kind: "geo.debris-flow", severity: "severe", urgency: "immediate" }, "life-safety"],
    ["a volcano warning", { kind: "geo.volcano.eruption", severity: "extreme", urgency: "immediate" }, "life-safety"],
    // The eruption is a child of `geo.volcano`, so the ashfall codes stay out of the class.
    ["an ashfall warning", { kind: "geo.volcano.ashfall", severity: "severe", urgency: "expected" }, "urgent"],
  ];
  it.each(products)("gives %s the level %s", (_, fields, level) => {
    expect(assess(incident(fields), person(), places).level).toBe(level);
  });

  it("gives life-safety exactly as the rule of docs/CONTRACTS.md tells", () => {
    const kinds = ["met.tornado", "met.thunderstorm.severe"];
    for (const status of STATUSES) {
      for (const kind of kinds) {
        for (const severity of [...SEVERITIES, "unknown"] as const) {
          for (const urgency of [...URGENCIES, "unknown"] as const) {
            const level = assess(incident({ status, kind, severity, urgency }), person(), places).level;
            const expected =
              status === "actual" &&
              hasKind(LIFE_SAFETY_KINDS, kind) &&
              ["severe", "extreme", "unknown"].includes(severity) &&
              ["immediate", "expected", "unknown"].includes(urgency);
            expect([status, kind, severity, urgency, level === "life-safety"]).toEqual([status, kind, severity, urgency, expected]);
          }
        }
      }
    }
  });

  it("gives a level that only grows with the severity and the urgency", () => {
    const tables: readonly LevelTable[] = [...DEFAULT_ASSESS_POLICY.classes, DEFAULT_ASSESS_POLICY.otherwise];
    for (const table of tables) {
      const bySeverity = SEVERITIES.map((severity) => rank(table.severity[severity]));
      const byUrgency = URGENCIES.map((urgency) => rank(table.urgency[urgency]));
      expect(bySeverity).toEqual([...bySeverity].sort((a, b) => a - b));
      expect(byUrgency).toEqual([...byUrgency].sort((a, b) => a - b));
    }
  });

  it("does not give life-safety to a kind out of the list, and does not give a life-safety kind less than another kind", () => {
    const [lifeSafety] = DEFAULT_ASSESS_POLICY.classes;
    const otherwise = DEFAULT_ASSESS_POLICY.otherwise;
    for (const severity of [...SEVERITIES, "unknown"] as const) {
      expect(otherwise.severity[severity]).not.toBe("life-safety");
      expect(rank(lifeSafety!.severity[severity])).toBeGreaterThanOrEqual(rank(otherwise.severity[severity]));
    }
    for (const urgency of [...URGENCIES, "unknown"] as const) {
      expect(otherwise.urgency[urgency]).not.toBe("life-safety");
      expect(rank(lifeSafety!.urgency[urgency])).toBeGreaterThanOrEqual(rank(otherwise.urgency[urgency]));
    }
  });

  it("tells the class and the two lookups", () => {
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "met.tornado", label: "Tornado Watch" }, severity: "extreme", urgency: "future" })).toEqual({
      class: "life-safety",
      bySeverity: "life-safety",
      byUrgency: "urgent",
      level: "urgent",
    });
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "met.fog", label: "Dense Fog Advisory" }, severity: "minor", urgency: "expected" })).toEqual({
      bySeverity: "digest",
      byUrgency: "urgent",
      level: "digest",
    });
  });
});

describe("hasKind", () => {
  it("ends a prefix at a dot", () => {
    expect(hasKind(["met.flood"], "met.flood")).toBe(true);
    expect(hasKind(["met.flood"], "met.flood.flash")).toBe(true);
    expect(hasKind(["met.fl"], "met.flood")).toBe(false);
    expect(hasKind(["met.flood.flash"], "met.flood")).toBe(false);
    expect(hasKind(["cbrne"], "cbrne.radiological")).toBe(true);
    expect(hasKind([], "met.tornado")).toBe(false);
  });
});

describe("the places", () => {
  it("matches a code of one system only", () => {
    expect(regionCovers({ system: "ugc", code: "KSC173" }, { system: "ugc", code: "KSC173" })).toBe(true);
    expect(regionCovers({ system: "ugc", code: "KSC173" }, { system: "same", code: "KSC173" })).toBe(false);
    expect(regionCovers({ system: "ugc", code: "KSC173" }, { system: "ugc", code: "KSZ083" })).toBe(false);
  });

  it("matches a part of a SAME county to the full county, and not to another part", () => {
    const same = (code: string) => ({ system: "same", code });
    expect(regionCovers(same("120173"), same("020173"))).toBe(true);
    expect(regionCovers(same("020173"), same("120173"))).toBe(true);
    expect(regionCovers(same("120173"), same("120173"))).toBe(true);
    expect(regionCovers(same("120173"), same("220173"))).toBe(false);
    expect(regionCovers(same("020173"), same("020175"))).toBe(false);
  });

  it("gives the places in their order, with the codes that matched", () => {
    const areas = [...atOther, ...atHome, { type: "code", system: "same", code: "320173" }] as const;
    expect(matchPlaces({ areas }, places)).toEqual([
      { place: home, codes: [{ system: "ugc", code: "KSC173" }, { system: "same", code: "020173" }] },
      { place: other, codes: [{ system: "same", code: "048029" }] },
    ]);
  });

  it("gives none, with the reason, when the areas are shapes and no place has a position", () => {
    const ring = [[-97.5, 37.5], [-97.2, 37.5], [-97.2, 37.8], [-97.5, 37.5]] as const;
    const result = assess(incident({ areas: [{ type: "polygon", rings: [ring] }] }), person(), places);
    expect(result.level).toBe("none");
    expect(result.reasons).toEqual([{ kind: "no-codes" }]);
  });

  it("gives none when no place of the person is in the areas", () => {
    const result = assess(incident({ areas: [{ type: "code", system: "ugc", code: "KSC015" }] }), person(), places);
    expect(result).toMatchObject({ level: "none", places: [], reasons: [{ kind: "no-place" }] });
  });

  it("tells of a place id with no watched place, and assesses the other places", () => {
    const missing = "place-9" as PlaceId;
    const result = assess(incident(), person([], [missing, home]), places);
    expect(result.level).toBe("life-safety");
    expect(result.reasons[0]).toEqual({ kind: "unknown-place", place: missing });
  });
});

describe("the shapes", () => {
  // Made-up positions in the ocean near 0, 0, with the codes of Kansas. No position is a real place.
  const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]] as const;
  const polygon = { type: "polygon", rings: [square] } as const;
  const placed = (at: Position, bufferKm: number): WatchedPlace => ({ ...(places[0] as WatchedPlace), at, bufferKm });
  const point = (at: Position) => ({ lat: at[1], lon: at[0] });
  // A position on the equator at a distance east of 0, 0.
  const east = (km: number): Position => [km / ((6371.0088 * Math.PI) / 180), 0];
  const byCode = { place: home, codes: [{ system: "ugc", code: "KSC173" }] };

  it("matches a place in a polygon, with the distance 0", () => {
    expect(matchPlaces({ areas: [polygon] }, [placed([0.5, 0.5], 0)])).toEqual([{ place: home, codes: [], distanceKm: 0 }]);
    expect(matchPlaces({ areas: [polygon] }, [placed([1, 0.5], 0)])).toEqual([{ place: home, codes: [], distanceKm: 0 }]);
  });

  it("matches a place out of a polygon when the polygon is in the buffer of the place", () => {
    const at: Position = [1.05, 0.5];
    const gap = distanceKm(point(at), point([1, 0.5]));
    const [match] = matchPlaces({ areas: [polygon] }, [placed(at, 6)]);
    expect(match?.distanceKm).toBeCloseTo(gap, 3);
    expect(gap).toBeGreaterThan(5);
    expect(matchPlaces({ areas: [polygon] }, [placed(at, 5)])).toEqual([]);
  });

  it("lets the shapes decide over the codes for a place with a position", () => {
    const areas = [polygon, ...atHome];
    expect(matchPlaces({ areas }, [placed([1.5, 0.5], 5)])).toEqual([]);
    const result = assess(incident({ areas }), person([], [home]), [placed([1.5, 0.5], 5)]);
    expect(result).toMatchObject({ level: "none", places: [], reasons: [{ kind: "no-place" }] });
  });

  it("lets the codes decide for a place with no position", () => {
    expect(matchPlaces({ areas: [polygon, ...atHome] }, places)).toEqual([byCode]);
  });

  it("matches a circle with its radius and the buffer of the place", () => {
    const circle = { type: "circle", center: [0, 0], radiusKm: 10 } as const;
    expect(matchPlaces({ areas: [circle] }, [placed(east(9), 0)])).toEqual([{ place: home, codes: [], distanceKm: 0 }]);
    const [near] = matchPlaces({ areas: [circle] }, [placed(east(14), 5)]);
    expect(near?.distanceKm).toBeCloseTo(4, 6);
    expect(matchPlaces({ areas: [circle] }, [placed(east(16), 5)])).toEqual([]);
  });

  it("gives the distance to the nearest shape", () => {
    const far = { type: "polygon", rings: [[[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]] } as const;
    const at: Position = [1.05, 0.5];
    const [match] = matchPlaces({ areas: [far, polygon] }, [placed(at, 10)]);
    expect(match?.distanceKm).toBeCloseTo(distanceKm(point(at), point([1, 0.5])), 3);
  });

  it("lets the codes decide too when geo refuses a shape, on the safe side", () => {
    const broken = { type: "polygon", rings: [[[0, 0], [1, 0], [0, 0]]] } as const;
    expect(matchPlaces({ areas: [broken, ...atHome] }, [placed([5, 5], 0)])).toEqual([byCode]);
    expect(matchPlaces({ areas: [broken, polygon, ...atHome] }, [placed([5, 5], 0)])).toEqual([byCode]);
    expect(matchPlaces({ areas: [broken] }, [placed([5, 5], 0)])).toEqual([]);
    expect(matchPlaces({ areas: [broken, polygon] }, [placed([0.5, 0.5], 0)])).toEqual([{ place: home, codes: [], distanceKm: 0 }]);
  });

  it("matches an area of the place when the areas also have shapes", () => {
    expect(matchPlaces({ areas: [polygon, { type: "place", place: home }] }, [placed([5, 5], 0)])).toEqual([{ place: home, codes: [] }]);
  });

  it("gives the distance in the reason of the assessment, and the schema accepts the assessment", () => {
    const result = assess(incident({ areas: [polygon] }), person([], [home]), [placed([1.05, 0.5], 10)]);
    expect(result.level).toBe("life-safety");
    const reason = result.reasons.find((one) => one.kind === "place");
    expect(reason).toMatchObject({ kind: "place", place: home, codes: [] });
    expect(reason?.kind === "place" ? reason.distanceKm : undefined).toBeGreaterThan(5);
    expect(assessmentSchema.safeParse(result).success).toBe(true);
  });

  it.each(SEEDS)("matches more places with a larger buffer, and a buffer of 0 matches the polygon (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 200; round += 1) {
      const at: Position = [r.range(-1, 2), r.range(-1, 2)];
      const matched = (bufferKm: number): boolean => matchPlaces({ areas: [polygon] }, [placed(at, bufferKm)]).length === 1;
      expect(matched(0)).toBe(locatePoint(point(at), { type: "Polygon", coordinates: [square] }) !== "outside");
      const buffer = r.range(0, 200);
      if (matched(buffer)) expect(matched(buffer * 2)).toBe(true);
    }
  });
});

describe("the gates", () => {
  it("gives none to an incident that ended", () => {
    expect(assess(incident({ live: false }), person(), places)).toMatchObject({ level: "none", places: [home], reasons: [{ kind: "ended" }] });
  });

  it("gives none to a status that the policy does not send", () => {
    expect(assess(incident({ status: "exercise" }), person(), places).reasons).toEqual([{ kind: "status", status: "exercise" }]);
  });

  it("sends the status system only for the kinds of the core", () => {
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "system", kind: { code: "system.health.failing", label: "" } })).toBe(true);
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "system", kind: { code: "system.coverage.met.tornado", label: "" } })).toBe(true);
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "actual", kind: { code: "system.health.failing", label: "" } })).toBe(false);
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "system", kind: { code: "met.tornado", label: "" } })).toBe(false);
    // The NWS maps an administrative message to `system.admin`. It stays in the table `otherwise`.
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "actual", kind: { code: "system.admin", label: "" } })).toBe(true);
    expect(admits(DEFAULT_ASSESS_POLICY, { status: "system", kind: { code: "system.admin", label: "" } })).toBe(false);
    expect(classOf(DEFAULT_ASSESS_POLICY, "system.admin")).toBeUndefined();
  });

  it("gives the coverage of a life-safety kind its own class, and each other report of the core at most notice", () => {
    const worst = { severity: "extreme", urgency: "immediate" } as const;
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "system.coverage.met.tornado", label: "" }, ...worst })).toMatchObject({ class: "system-coverage", level: "life-safety" });
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "system.coverage.met.winter", label: "" }, ...worst })).toMatchObject({ class: "system", level: "notice" });
    expect(tableLevel(DEFAULT_ASSESS_POLICY, { kind: { code: "system.health.failing", label: "" }, ...worst })).toMatchObject({ class: "system", level: "notice" });
  });
});

describe("the subjects and the areas of a place", () => {
  const source = { system: "alerts.source", id: "api" };
  const down = (fields: Draft = {}): Incident =>
    incident({ status: "system", kind: "system.health.failing", severity: "moderate", urgency: "expected", areas: [], about: [source], ...fields });
  const watcher = (rules: readonly LevelRule[] = [], subjects: PersonWatch["subjects"] = [{ system: "alerts.source" }]): PersonWatch => ({ ...person(rules), subjects });

  it("matches a watched subject by its system, and by its id when the watch has one", () => {
    expect(matchSubjects(down(), [{ system: "alerts.source" }, { system: "alerts.source", id: "api" }, { system: "alerts.source", id: "radio" }, { system: "cloud" }])).toEqual([
      { system: "alerts.source" },
      { system: "alerts.source", id: "api" },
    ]);
    expect(assess(down(), watcher(), places)).toMatchObject({ level: "notice", places: [], reasons: [{ kind: "table" }, { kind: "subject", subject: { system: "alerts.source" } }] });
  });

  it("gives none with the reason no-subject to a person who watches no subject of the incident", () => {
    expect(assess(down(), person(), places).reasons).toEqual([{ kind: "no-subject" }]);
    expect(assess(down(), watcher([], [{ system: "cloud" }]), places).level).toBe("none");
  });

  it("applies a rule with no places to a subject, and not a rule with places", () => {
    expect(assess(down(), watcher([{ places: [home], max: "none" }, { kinds: ["system"], max: "digest" }]), places)).toMatchObject({
      level: "digest",
      reasons: [{ kind: "table" }, { kind: "subject" }, { kind: "rule", index: 1, max: "digest" }],
    });
  });

  it("matches an area of a watched place to that place only", () => {
    const gap = incident({ areas: [{ type: "place", place: other }] });
    expect(matchPlaces(gap, places)).toEqual([{ place: other, codes: [] }]);
    expect(assess(gap, person([], [home]), places).reasons).toEqual([{ kind: "no-place" }]);
  });
});

describe("the rules of a person", () => {
  const others: LevelRule = { places: [other], max: "urgent" };

  it("lowers the level at the places of the rule only", () => {
    expect(assess(incident({ areas: atOther }), person([others]), places)).toMatchObject({
      level: "urgent",
      reasons: [{ kind: "table" }, { kind: "place", place: other }, { kind: "rule", place: other, index: 0, max: "urgent" }],
    });
    expect(assess(incident({ areas: atHome }), person([others]), places).level).toBe("life-safety");
  });

  it("gives the highest level of the places", () => {
    expect(assess(incident({ areas: [...atHome, ...atOther] }), person([others]), places).level).toBe("life-safety");
  });

  it("applies the first rule that matches the place and the kind", () => {
    const worst: LevelRule = { places: [other], kinds: ["met.tornado", "safety.evacuation", "geo.tsunami"], max: "life-safety" };
    expect(assess(incident({ areas: atOther }), person([worst, others]), places).level).toBe("life-safety");
    expect(assess(incident({ areas: atOther, kind: "met.flood.flash" }), person([worst, others]), places).level).toBe("urgent");
    expect(assess(incident(), person([{ max: "digest" }, { max: "none" }]), places).level).toBe("digest");
  });

  it("does not raise the level of the table", () => {
    const result = assess(incident({ severity: "moderate", kind: "met.winter.storm", urgency: "expected" }), person([{ max: "life-safety" }]), places);
    expect(result.level).toBe("notice");
    expect(result.reasons.some((reason) => reason.kind === "rule")).toBe(false);
  });
});

describe("the properties of the assessment", () => {
  const kinds = ["met.tornado", "met.flood.flash", "met.thunderstorm.severe", "met.wind.high", "cbrne.radiological", "system.coverage.met.tornado", "system.health.failing"];
  const levels = ASSESSED_LEVELS;

  function randomIncident(r: Random): Incident {
    const areas = [...(r.chance(0.6) ? atHome : []), ...(r.chance(0.6) ? atOther : [])];
    return incident({
      kind: r.pick(kinds),
      severity: r.pick([...SEVERITIES, "unknown"] as const),
      urgency: r.pick([...URGENCIES, "unknown"] as const),
      status: r.chance(0.8) ? "actual" : r.pick(STATUSES),
      live: r.chance(0.9),
      areas,
    });
  }

  function randomRules(r: Random): LevelRule[] {
    return Array.from({ length: r.int(0, 3) }, () => ({
      ...(r.chance(0.5) ? { places: r.sample([home, other], r.int(1, 2)) } : {}),
      ...(r.chance(0.5) ? { kinds: r.sample(kinds, r.int(1, 2)) } : {}),
      max: r.pick(levels),
    }));
  }

  it.each(SEEDS)("holds over random incidents and rules (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 200; round += 1) {
      const subject = randomIncident(r);
      const rules = randomRules(r);
      const result = assess(subject, person(rules), places);
      const table = tableLevel(DEFAULT_ASSESS_POLICY, subject).level;
      // The rules only lower the level.
      expect(rank(result.level)).toBeLessThanOrEqual(rank(table));
      expect(rank(result.level)).toBeLessThanOrEqual(rank(assess(subject, person(), places).level));
      // A place more never lowers the level.
      const fewer = assess(subject, person(rules, [r.pick([home, other])]), places);
      expect(rank(fewer.level)).toBeLessThanOrEqual(rank(result.level));
      // The level is the highest of the levels at each place alone.
      const alone = [home, other].map((place) => assess(subject, person(rules, [place]), places).level);
      expect(result.level).toBe(alone.reduce(higherLevel, "none"));
    }
  });
});
