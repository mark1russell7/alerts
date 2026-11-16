import { TAXONOMY } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";

import { checkAtlas, coverage, measures, MIN_SOURCES, parentOf, planBlock, unreachedCodes, type Atlas, type Round, type SignalClass, type Source } from "./atlas.ts";
import { readAtlas, workspacePackages } from "./read.ts";

const round: Round = {
  round: 1,
  date: "2026-11-15",
  by: "a test",
  method: "test",
  lists: ["a list"],
  queries: [],
  notes: [],
  studies: [],
  measures: { classes: 0, gaps: 0, adoptedCover: 0 },
};

const klass = (id: string, gap: string | null = null): SignalClass => ({
  id,
  subjectKinds: ["place"],
  examples: [],
  references: ["a list"],
  gap,
  round: 1,
});

const source = (id: string, classes: readonly string[], decision: Source["decision"] = "plan"): Source => ({
  id,
  name: id,
  classes,
  url: "https://example.org/docs",
  access: "api",
  auth: "none",
  terms: { url: null, automated: "unclear", redistribution: "unclear", note: "" },
  cost: "free",
  delay: "unknown",
  history: "unknown",
  rateLimit: "unknown",
  calibration: null,
  coverage: "the test",
  subjectIds: ["point"],
  risks: [],
  decision,
  adapter: decision === "adopt" ? "@mark1russell7/alerts-source-nws-api" : null,
  reason: "A test record.",
  evidence: ["https://example.org/docs"],
  round: 1,
});

const atlas = (classes: readonly SignalClass[], sources: readonly Source[]): Atlas => ({ classes, sources, rounds: [round] });

describe("the committed atlas", () => {
  const committed = readAtlas();

  it("passes the gate: each class is a code of the taxonomy with 2 or more sources with no risk, or a reason, and a class reaches each code", () => {
    expect(checkAtlas(committed, { packages: workspacePackages(), codes: Object.keys(TAXONOMY) })).toEqual([]);
  });

  it("has prediction markets as a class with 2 or more sources", () => {
    const markets = coverage(committed).find((row) => row.id === "market.prediction");
    expect(markets?.sources.length).toBeGreaterThanOrEqual(MIN_SOURCES);
  });

  it("has a record of each round", () => {
    const rounds = new Set(committed.rounds.map((item) => item.round));
    for (const item of [...committed.classes, ...committed.sources]) expect(rounds.has(item.round), item.id).toBe(true);
  });

  it("names the risk of the IPAWS feed in the gap of each class that counts on it", () => {
    for (const row of coverage(committed)) {
      if (!row.atRisk.includes("ipaws-open") || row.sources.length - row.atRisk.length >= MIN_SOURCES) continue;
      expect(row.gap, row.id).toContain("ipaws-open");
    }
  });
});

describe("the gate of coverage", () => {
  it("counts the adopted and planned sources of a class and of its descendants", () => {
    const classes = [klass("infra.power"), klass("infra.power.outage")];
    const sources = [source("a", ["infra.power.outage"], "adopt"), source("b", ["infra.power"]), source("c", ["infra.power.outage"], "reject"), source("d", ["infra.power.outage"], "later")];
    expect(coverage(atlas(classes, sources))).toEqual([
      { id: "infra.power", sources: ["a", "b"], atRisk: [], adopted: ["a"], gap: null },
      { id: "infra.power.outage", sources: ["a"], atRisk: [], adopted: ["a"], gap: null },
    ]);
  });

  it("stops a class with fewer than 2 sources and no reason, and a reason that is out of date", () => {
    const sources = [source("a", ["infra.power.outage"]), source("b", ["infra.power"])];
    expect(checkAtlas(atlas([klass("infra.power"), klass("infra.power.outage")], sources))).toEqual([
      { at: "class infra.power.outage", problem: "the class has 1 sources with no risk and no reason of a gap" },
    ]);
    const withGap = [klass("infra.power", "an old reason"), klass("infra.power.outage", "Only one operator publishes the data.")];
    expect(checkAtlas(atlas(withGap, sources))).toEqual([{ at: "class infra.power", problem: "the class has 2 sources with no risk, so its reason of a gap is out of date" }]);
  });

  it("does not count a source with a risk", () => {
    const risky = { ...source("b", ["safety.evacuation"]), risks: ["The provider can ask for an agreement."] };
    const classes = [klass("safety.evacuation")];
    const sources = [source("a", ["safety.evacuation"]), risky];
    expect(coverage(atlas(classes, sources))[0]?.atRisk).toEqual(["b"]);
    expect(checkAtlas(atlas(classes, sources))).toEqual([{ at: "class safety.evacuation", problem: "the class has 1 sources with no risk and no reason of a gap" }]);
    expect(checkAtlas(atlas([klass("safety.evacuation", "b has a risk.")], sources))).toEqual([]);
  });

  it("stops a bad record", () => {
    const classes = [klass("weather.rain"), klass("cyber.dns", "no source yet"), klass("cyber.Bad")];
    const bad = { ...source("Bad_Id", ["infra.nothing"]), url: "ftp://example.org", subjectIds: ["zip-code"], evidence: [], reason: " ", adapter: "x", risks: [" "] } as unknown as Source;
    const adopted = { ...source("no-adapter", ["cyber.dns"], "adopt"), adapter: null, subjectIds: null };
    const absent = { ...source("absent", ["cyber.dns"], "adopt"), adapter: "@mark1russell7/alerts-source-none" };
    const paid = { ...source("paid", ["cyber.dns"]), auth: "paid" } as const;
    const page = { ...source("page", ["cyber.dns"]), access: "page" } as const;
    const problems = checkAtlas(atlas(classes, [bad, adopted, absent, paid, page]), { packages: new Set(["@mark1russell7/alerts-source-nws-api"]) }).map((item) => `${item.at}: ${item.problem}`);
    expect(problems).toEqual(
      expect.arrayContaining([
        "class weather.rain: the id is not a code of the taxonomy of the core",
        "class cyber.Bad: the id is not a dotted id in lower case",
        "source Bad_Id: the id is not in lower case with hyphens",
        "source Bad_Id: the class infra.nothing is not in the atlas",
        "source Bad_Id: the url is not an http or https URL",
        "source Bad_Id: the decision has no reason",
        "source Bad_Id: the subject id zip-code is not a system of the core",
        "source Bad_Id: a risk is empty",
        "source Bad_Id: an adopted or planned source has no evidence",
        "source Bad_Id: only an adopted source has an adapter",
        "source no-adapter: an adopted source has no adapter",
        "source no-adapter: an adopted source has no subject ids",
        "source absent: the adapter @mark1russell7/alerts-source-none is not a package of the workspace",
        "source paid: the decision plan has a block: the auth is paid",
        "source page: the decision plan has a block: a page source needs terms that let automated reading",
      ]),
    );
  });
});

describe("the adopted cover", () => {
  it("counts the classes with 2 or more adopted sources with no risk, next to the gaps", () => {
    const classes = [klass("infra.power"), klass("infra.power.outage", "one planned source"), klass("infra.water", "no source")];
    const risky = { ...source("c", ["infra.power"], "adopt"), risks: ["The provider can ask for an agreement."] };
    const sources = [source("a", ["infra.power.outage"], "adopt"), source("b", ["infra.power"], "adopt"), risky];
    expect(measures(atlas(classes, sources))).toEqual({ classes: 3, gaps: 2, adoptedCover: 1 });
    expect(measures(atlas(classes, [...sources.slice(0, 1), { ...source("b", ["infra.power"]) }]))).toEqual({ classes: 3, gaps: 2, adoptedCover: 0 });
  });

  it("stops a change that makes the adopted cover fall below the measure of a round", () => {
    const classes = [klass("infra.power")];
    const covered = atlas(classes, [source("a", ["infra.power"], "adopt"), source("b", ["infra.power"], "adopt")]);
    const recorded: Atlas = { ...covered, rounds: [{ ...round, measures: { classes: 1, gaps: 0, adoptedCover: 1 } }] };
    expect(checkAtlas(recorded)).toEqual([]);
    const fallen: Atlas = { ...recorded, sources: [source("a", ["infra.power"], "adopt"), source("b", ["infra.power"])] };
    expect(checkAtlas(fallen)).toEqual([{ at: "atlas", problem: "the adopted cover is 0 classes, below the 1 classes of a round" }]);
    const bad: Atlas = { ...recorded, rounds: [{ ...round, measures: { classes: -1, gaps: 0.5, adoptedCover: 1 } }] };
    expect(checkAtlas(bad).map((item) => item.problem)).toEqual(["the measure -1 is not a count", "the measure 0.5 is not a count"]);
    const { measures: _gone, ...unmeasured } = round;
    expect(checkAtlas({ ...recorded, rounds: [unmeasured as Round] })).toEqual([{ at: "round 1", problem: "the round has no measures" }]);
  });

  it("has the measures of the committed atlas at or above the last round", () => {
    const committed = readAtlas();
    const last = committed.rounds.at(-1);
    expect(measures(committed).adoptedCover).toBeGreaterThanOrEqual(last?.measures.adoptedCover ?? 0);
  });
});

describe("the reach of the taxonomy", () => {
  it("needs a class at each code, an ancestor of it or a descendant of it, except the system and other codes", () => {
    const codes = ["infra", "infra.power", "infra.power.outage", "infra.water", "system.test", "other.unknown", "met.flood", "met.flood.flash"];
    expect(unreachedCodes([klass("infra.power"), klass("met.flood.flash")], codes)).toEqual(["infra.water"]);
    expect(unreachedCodes([], ["met.fl", "met.flood"])).toEqual(["met.fl", "met.flood"]);
    expect(unreachedCodes([klass("met.flood")], ["met.fl"])).toEqual(["met.fl"]);
  });

  it("stops an atlas that does not reach a code of the context", () => {
    const classes = [klass("infra.power", "no source yet")];
    expect(checkAtlas(atlas(classes, []), { codes: ["infra.power.outage", "infra.water"] })).toEqual([
      { at: "code infra.water", problem: "no class is the code, an ancestor of it or a descendant of it" },
    ]);
  });
});

describe("the calculations", () => {
  it("gives the parent: the longest prefix that is a class", () => {
    const ids = new Set(["market.price", "market.price.fuel", "infra.power.outage"]);
    expect(parentOf("market.price.fuel", ids)).toBe("market.price");
    expect(parentOf("market.price.fuel.diesel", ids)).toBe("market.price.fuel");
    expect(parentOf("infra.power.outage", ids)).toBeNull();
    expect(parentOf("market.price", ids)).toBeNull();
  });

  it("gives the block of a plan from the facts of the source", () => {
    const base = source("a", ["cyber.dns"]);
    expect(planBlock(base)).toBeNull();
    expect(planBlock({ ...base, auth: "unknown" })).toBe("the auth is unknown");
    expect(planBlock({ ...base, cost: "paid" })).toBe("the cost is paid");
    expect(planBlock({ ...base, terms: { ...base.terms, automated: "forbidden" } })).toBe("the terms forbid automated reading");
    expect(planBlock({ ...base, access: "page", terms: { ...base.terms, automated: "limited" } })).toBeNull();
  });
});
