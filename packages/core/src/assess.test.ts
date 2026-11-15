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
  assess,
  hasKind,
  higherLevel,
  matchPlaces,
  regionCovers,
  tableLevel,
} from "./assess.ts";

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

  it("gives none, with the reason, when the areas are shapes with no code", () => {
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

describe("the gates", () => {
  it("gives none to an incident that ended", () => {
    expect(assess(incident({ live: false }), person(), places)).toMatchObject({ level: "none", places: [home], reasons: [{ kind: "ended" }] });
  });

  it("gives none to a status that the policy does not send", () => {
    expect(assess(incident({ status: "exercise" }), person(), places).reasons).toEqual([{ kind: "status", status: "exercise" }]);
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
  const kinds = ["met.tornado", "met.flood.flash", "met.thunderstorm.severe", "met.wind.high", "cbrne.radiological"];
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
