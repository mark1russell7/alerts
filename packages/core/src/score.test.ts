import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { assess, LIFE_SAFETY_KINDS } from "./assess.ts";
import type {
  Area,
  Certainty,
  Estimate,
  Incident,
  KindPrior,
  LevelRule,
  PersonId,
  PersonWatch,
  PlaceId,
  ReportId,
  ScorePriors,
  Severity,
  Significance,
  Status,
  Urgency,
  WatchedPlace,
} from "./contracts.ts";
import { ASSESSED_LEVELS } from "./contracts.ts";
import { assessmentSchema, scorePriorsSchema, shadowScoreSchema } from "./schemas.ts";
import { assessWithShadow, PRIORS_FORMAT, shadowScore } from "./score.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

// Made-up values. They are not the public measures.
const estimate = (value: number, low: number, high: number): Estimate => ({ value, low, high });
const PRIORS: ScorePriors = {
  format: PRIORS_FORMAT,
  kinds: {
    met: { deaths: estimate(0.01, 0.005, 0.02), injuries: estimate(0.05, 0.03, 0.08) },
    "met.tornado": { verified: estimate(0.3, 0.28, 0.33), deaths: estimate(0.04, 0.03, 0.06), injuries: estimate(0.6, 0.4, 0.9) },
    "met.flood.flash": { deaths: estimate(0.02, 0.01, 0.03), injuries: estimate(0.01, 0.005, 0.02) },
  },
  certainty: {
    observed: estimate(1, 1, 1),
    likely: estimate(0.75, 0.5, 1),
    possible: estimate(0.25, 0, 0.5),
  },
};

const home = "place:home" as PlaceId;
const places: readonly WatchedPlace[] = [{ id: home, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 0 }];
const atHome: readonly Area[] = [{ type: "code", system: "ugc", code: "KSC173" }];
const elsewhere: readonly Area[] = [{ type: "code", system: "ugc", code: "TXC029" }];

function person(rules: readonly LevelRule[] = []): PersonWatch {
  return { person: "person-1" as PersonId, places: [home], rules };
}

function incident(kind: string, fields: Partial<Omit<Incident, "kind">> = {}, significance?: Significance): Incident {
  return {
    anchor: "a".repeat(64) as ReportId,
    reports: ["a".repeat(64) as ReportId],
    status: "actual",
    kind: significance === undefined ? { code: kind, label: kind } : { code: kind, significance, label: kind },
    severity: "extreme",
    urgency: "immediate",
    certainty: "likely",
    areas: atHome,
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

describe("shadowScore", () => {
  it("gives a warning the verified share of its kind, and not the certainty word", () => {
    const score = shadowScore(incident("met.tornado", {}, "warning"), PRIORS);
    expect(score).toEqual({
      read: true,
      probability: { estimate: estimate(0.3, 0.28, 0.33), from: { table: "kinds", key: "met.tornado" } },
      deaths: { estimate: estimate(0.04, 0.03, 0.06), from: { table: "kinds", key: "met.tornado" } },
      injuries: { estimate: estimate(0.6, 0.4, 0.9), from: { table: "kinds", key: "met.tornado" } },
    });
    expect(shadowScoreSchema.safeParse(score).success).toBe(true);
  });

  it("gives an observed event the probability of the certainty observed", () => {
    const score = shadowScore(incident("met.tornado", { certainty: "observed" }, "warning"), PRIORS);
    expect(score.read && score.probability).toEqual({ estimate: estimate(1, 1, 1), from: { table: "certainty", key: "observed" } });
  });

  it("gives the certainty to a watch, and to a warning of a kind with no verified share", () => {
    const watch = shadowScore(incident("met.tornado", { certainty: "possible" }, "watch"), PRIORS);
    expect(watch.read && watch.probability.from).toEqual({ table: "certainty", key: "possible" });
    const flood = shadowScore(incident("met.flood.flash", {}, "warning"), PRIORS);
    expect(flood.read && flood.probability.from).toEqual({ table: "certainty", key: "likely" });
    expect(flood.read && flood.deaths.from).toEqual({ table: "kinds", key: "met.flood.flash" });
  });

  it("takes each field from the longest prefix of the kind with that field", () => {
    const wind = shadowScore(incident("met.wind.high", {}, "warning"), PRIORS);
    expect(wind.read && [wind.probability.from.key, wind.deaths.from.key, wind.injuries.from.key]).toEqual(["likely", "met", "met"]);
    const tornado = shadowScore(incident("met.tornado.waterspout", {}, "warning"), PRIORS);
    expect(tornado.read && tornado.probability.from.key).toBe("met.tornado");
  });

  it("has no read when the priors do not give a factor, and names each missing factor", () => {
    expect(shadowScore(incident("geo.earthquake", { certainty: "unknown" }), PRIORS)).toEqual({ read: false, missing: ["probability", "deaths", "injuries"] });
    expect(shadowScore(incident("geo.earthquake"), PRIORS)).toEqual({ read: false, missing: ["deaths", "injuries"] });
    // A prefix ends at a dot: `met` is not a prefix of `metro.transit`.
    expect(shadowScore(incident("metro.transit"), PRIORS)).toEqual({ read: false, missing: ["deaths", "injuries"] });
    const partial: ScorePriors = { ...PRIORS, kinds: { "met.tornado": { deaths: estimate(0.04, 0.03, 0.06) } } };
    expect(shadowScore(incident("met.tornado", {}, "warning"), partial)).toEqual({ read: false, missing: ["injuries"] });
  });
});

describe("scorePriorsSchema", () => {
  it("accepts the priors of the tests", () => {
    expect(scorePriorsSchema.safeParse(PRIORS).success).toBe(true);
  });

  it("refuses an interval that does not hold its value, a probability above 1 and an unknown field", () => {
    const withKind = (prior: KindPrior): unknown => ({ ...PRIORS, kinds: { met: prior } });
    expect(scorePriorsSchema.safeParse(withKind({ deaths: estimate(0.5, 0.6, 0.7) })).success).toBe(false);
    expect(scorePriorsSchema.safeParse(withKind({ verified: estimate(1.2, 1, 1.4) })).success).toBe(false);
    expect(scorePriorsSchema.safeParse(withKind({ deaths: estimate(-1, -1, 0) })).success).toBe(false);
    expect(scorePriorsSchema.safeParse({ ...PRIORS, certainty: { sure: estimate(1, 1, 1) } }).success).toBe(false);
    expect(scorePriorsSchema.safeParse({ ...PRIORS, format: "alerts-priors/2" }).success).toBe(false);
  });
});

describe("assessWithShadow", () => {
  it("adds the score as the last reason, and keeps the level and the reasons of the table", () => {
    const tornado = incident("met.tornado", {}, "warning");
    const plain = assess(tornado, person(), places);
    const shadow = assessWithShadow(tornado, person(), places, PRIORS);
    expect(shadow.level).toBe("life-safety");
    expect(shadow).toEqual({ ...plain, reasons: [...plain.reasons, { kind: "shadow", score: shadowScore(tornado, PRIORS) }] });
    expect(assessmentSchema.safeParse(shadow).success).toBe(true);
  });

  it("adds no score to an assessment with no reason of the table", () => {
    for (const draft of [incident("met.tornado", { areas: elsewhere }), incident("met.tornado", { live: false }), incident("met.tornado", { status: "test" })]) {
      expect(assessWithShadow(draft, person(), places, PRIORS)).toEqual(assess(draft, person(), places));
    }
  });
});

// The gate of the shadow: the table decides each send. A score of each shape keeps the level and the
// reasons of `assess`. A change that lets the score decide fails this test.
describe("the gate of the shadow score", () => {
  const KINDS = [...LIFE_SAFETY_KINDS, "met.wind.high", "met.tornado.waterspout", "infra.power.outage", "metro.transit"];
  const SEVERITIES: readonly Severity[] = ["minor", "moderate", "severe", "extreme", "unknown"];
  const URGENCIES: readonly Urgency[] = ["past", "future", "expected", "immediate", "unknown"];
  const CERTAINTIES: readonly Certainty[] = ["observed", "likely", "possible", "unlikely", "unknown"];
  const SIGNIFICANCES: readonly (Significance | undefined)[] = [undefined, "warning", "watch", "advisory", "statement"];
  const STATUSES: readonly Status[] = ["actual", "actual", "actual", "exercise", "test"];
  const pick = <T,>(r: Random, values: readonly T[]): T => values[r.int(0, values.length - 1)]!;
  const draw = (r: Random, max: number): Estimate => {
    const [a, b, c] = [r.int(0, 100), r.int(0, 100), r.int(0, 100)].sort((x, y) => x - y) as [number, number, number];
    return estimate((b / 100) * max, (a / 100) * max, (c / 100) * max);
  };
  const somePriors = (r: Random): ScorePriors => {
    const kinds: Record<string, KindPrior> = {};
    for (const key of ["met", "met.tornado", "met.flood", "geo", "safety.civil-danger"]) {
      if (r.chance(0.3)) continue;
      kinds[key] = {
        ...(r.chance(0.6) ? { verified: draw(r, 1) } : {}),
        ...(r.chance(0.7) ? { deaths: draw(r, 5) } : {}),
        ...(r.chance(0.7) ? { injuries: draw(r, 50) } : {}),
      };
    }
    const certainty: Partial<Record<Certainty, Estimate>> = {};
    for (const value of CERTAINTIES) if (r.chance(0.7)) certainty[value] = draw(r, 1);
    return { format: PRIORS_FORMAT, kinds, certainty };
  };
  const someRules = (r: Random): LevelRule[] =>
    Array.from({ length: r.int(0, 2) }, () => ({ ...(r.chance(0.5) ? { kinds: [pick(r, KINDS)] } : {}), max: pick(r, ASSESSED_LEVELS) }));

  it.each(SEEDS)("keeps the level and the reasons of the table for each score (seed %i)", (seed) => {
    const r = random(seed);
    let scored = 0;
    for (let n = 0; n < 200; n++) {
      const draft = incident(
        pick(r, KINDS),
        {
          status: pick(r, STATUSES),
          severity: pick(r, SEVERITIES),
          urgency: pick(r, URGENCIES),
          certainty: pick(r, CERTAINTIES),
          areas: r.chance(0.8) ? atHome : elsewhere,
          live: r.chance(0.9),
        },
        pick(r, SIGNIFICANCES),
      );
      const who = person(someRules(r));
      const priors = somePriors(r);
      expect(scorePriorsSchema.safeParse(priors).success).toBe(true);
      const plain = assess(draft, who, places);
      const shadow = assessWithShadow(draft, who, places, priors);
      expect(shadow.level).toBe(plain.level);
      expect(shadow.reasons.filter((reason) => reason.kind !== "shadow")).toEqual(plain.reasons);
      expect(shadow.reasons.filter((reason) => reason.kind === "shadow").length).toBeLessThanOrEqual(1);
      expect(assessmentSchema.safeParse(shadow).success).toBe(true);
      if (shadow.reasons.length > plain.reasons.length) scored++;
    }
    // The draws reach the score: a gate that sees no score cannot hold the rule.
    expect(scored).toBeGreaterThan(50);
  });
});
