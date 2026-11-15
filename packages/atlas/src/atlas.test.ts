import { describe, expect, it } from "vitest";

import { checkAtlas, coverage, MIN_SOURCES, parentOf, planBlock, type Atlas, type SignalClass, type Source } from "./atlas.ts";
import { readAtlas, workspacePackages } from "./read.ts";

const round = { round: 1, date: "2026-11-15", by: "a test", method: "test", lists: ["a list"], queries: [], notes: [], studies: [] };

const klass = (id: string, gap: string | null = null): SignalClass => ({
  id,
  label: id,
  summary: `The class ${id}.`,
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

  it("passes the gate: each class has 2 or more sources with no risk, or a reason", () => {
    expect(checkAtlas(committed, { packages: workspacePackages() })).toEqual([]);
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
      { id: "infra.power", sources: ["a", "b"], atRisk: [], gap: null },
      { id: "infra.power.outage", sources: ["a"], atRisk: [], gap: null },
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
        "class weather.rain: the first part of the id is not a category of the core",
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
