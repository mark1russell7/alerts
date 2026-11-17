import { DIMENSION_IDS, TAXONOMY } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";

import {
  checkAtlas,
  coverage,
  dimensionCoverage,
  LAYERS,
  leafCodes,
  measures,
  MIN_SOURCES,
  mostDisjoint,
  originsAt,
  pairClaims,
  parentOf,
  planBlock,
  UNKNOWN,
  unreachedCodes,
  type Atlas,
  type Layers,
  type PathKind,
  type Region,
  type RegionalOrigins,
  type Round,
  type SignalClass,
  type Source,
} from "./atlas.ts";
import { readAtlas, workspacePackages } from "./read.ts";

const layers = (adopted: number, paths: number, origins: number): Layers => ({ adopted, paths, origins });
const NONE = layers(0, 0, 0);

const round: Round = {
  round: 1,
  date: "2026-11-15",
  by: "a test",
  method: "test",
  lists: ["a list"],
  queries: [],
  notes: [],
  studies: [],
  measures: { classes: 0, gaps: 0, cover: NONE, total: NONE, unknownOrigins: 0, unknownPaths: 0, cause: "a test" },
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
  origins: ["test-origin"],
  path: [`${id}.example.org`],
  subjectIds: ["point"],
  risks: [],
  decision,
  adapter: decision === "adopt" ? "@mark1russell7/alerts-source-nws-api" : null,
  reason: "A test record.",
  evidence: ["https://example.org/docs"],
  round: 1,
});

const WORLD: Region = { id: "world", name: "The whole Earth", parent: null, note: "a test" };
const US: Region = { id: "us", name: "The United States", parent: "world", note: "a test" };

// The atlas of a test lists each origin and each part of a path that its sources name. A first part is a host.
const atlas = (classes: readonly SignalClass[], sources: readonly Source[], regions: readonly Region[] = [WORLD]): Atlas => {
  const named = (pick: (source: Source) => readonly string[]): string[] => [...new Set(sources.flatMap(pick))].filter((id) => id !== UNKNOWN);
  const hosts = new Set(sources.map((source) => source.path[0]));
  return {
    classes,
    sources,
    rounds: [round],
    origins: named((source) => [...source.origins, ...(source.regionalOrigins ?? []).flatMap((entry) => entry.origins)]).map((id) => ({ id, name: id, issues: null, note: "a test" })),
    paths: named((source) => source.path).map((id) => ({ id, name: id, kind: hosts.has(id) ? "host" : (id.slice(0, id.indexOf(":")) as PathKind), note: "a test" })),
    regions,
  };
};

describe("the committed atlas", () => {
  const committed = readAtlas();

  it("passes the gate: each class is a code of the taxonomy with 2 or more sources with no risk, or a reason, and a class reaches each code", () => {
    expect(checkAtlas(committed, { packages: workspacePackages(), codes: Object.keys(TAXONOMY) })).toEqual([]);
  });

  it("has prediction markets as a class with 2 or more sources", () => {
    const markets = coverage(committed).find((row) => row.id === "market.prediction");
    expect(markets?.shared).toBeGreaterThanOrEqual(MIN_SOURCES);
  });

  it("has a record of each round", () => {
    const rounds = new Set(committed.rounds.map((item) => item.round));
    for (const item of [...committed.classes, ...committed.sources]) expect(rounds.has(item.round), item.id).toBe(true);
  });

  it("names the risk of the IPAWS feed in the gap of each class that counts on it", () => {
    for (const row of coverage(committed)) {
      if (!row.atRisk.includes("ipaws-open") || row.shared >= MIN_SOURCES) continue;
      expect(row.gap, row.id).toContain("ipaws-open");
    }
  });
});

describe("the gate of coverage", () => {
  it("counts the adopted and planned sources of a class and of its descendants", () => {
    const classes = [klass("infra.power"), klass("infra.power.outage")];
    const sources = [source("a", ["infra.power.outage"], "adopt"), source("b", ["infra.power"]), source("c", ["infra.power.outage"], "reject"), source("d", ["infra.power.outage"], "later")];
    expect(coverage(atlas(classes, sources))).toEqual([
      { id: "infra.power", sources: ["a", "b"], atRisk: [], adopted: ["a"], shared: 2, layers: layers(1, 1, 1), gap: null },
      { id: "infra.power.outage", sources: ["a"], atRisk: [], adopted: ["a"], shared: 1, layers: layers(1, 1, 1), gap: null },
    ]);
  });

  it("stops a class with fewer than 2 sources and no reason, and a reason that is out of date", () => {
    const sources = [source("a", ["infra.power.outage"]), source("b", ["infra.power"])];
    expect(checkAtlas(atlas([klass("infra.power"), klass("infra.power.outage")], sources))).toEqual([
      { at: "class infra.power.outage", problem: "the class has 1 sources with no risk at one leaf code and no reason of a gap" },
    ]);
    const withGap = [klass("infra.power", "an old reason"), klass("infra.power.outage", "Only one operator publishes the data.")];
    expect(checkAtlas(atlas(withGap, sources))).toEqual([{ at: "class infra.power", problem: "the class has 2 sources with no risk at one leaf code, so its reason of a gap is out of date" }]);
  });

  it("does not count a source with a risk", () => {
    const risky = { ...source("b", ["safety.evacuation"]), risks: ["The provider can ask for an agreement."] };
    const classes = [klass("safety.evacuation")];
    const sources = [source("a", ["safety.evacuation"]), risky];
    expect(coverage(atlas(classes, sources))[0]?.atRisk).toEqual(["b"]);
    expect(checkAtlas(atlas(classes, sources))).toEqual([{ at: "class safety.evacuation", problem: "the class has 1 sources with no risk at one leaf code and no reason of a gap" }]);
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

describe("the layers of the cover", () => {
  it("counts the cover and the total of each layer next to the gaps", () => {
    const classes = [klass("infra.power"), klass("infra.power.outage", "one planned source"), klass("infra.water", "no source")];
    const risky = { ...source("c", ["infra.power"], "adopt"), risks: ["The provider can ask for an agreement."] };
    const sources = [source("a", ["infra.power.outage"], "adopt"), source("b", ["infra.power"], "adopt"), risky];
    // infra.power counts a and b: 2 paths with no shared part, and 1 origin. infra.power.outage counts a.
    expect(measures(atlas(classes, sources))).toEqual({ classes: 3, gaps: 2, cover: layers(1, 1, 0), total: layers(3, 3, 2), unknownOrigins: 0, unknownPaths: 0, dimensions: 0 });
    expect(measures(atlas(classes, [...sources.slice(0, 1), source("b", ["infra.power"])]))).toEqual({
      classes: 3,
      gaps: 2,
      cover: NONE,
      total: layers(2, 2, 2),
      unknownOrigins: 0,
      unknownPaths: 0,
      dimensions: 0,
    });
  });

  it("keeps each source at the adopted layer, and counts the shared origin and path once at their layers", () => {
    const shared = (id: string): Source => ({ ...source(id, ["met.flood"], "adopt"), origins: ["nws"], path: ["api.example.org"] });
    const world = atlas([klass("met.flood")], [shared("a"), shared("b")]);
    expect(coverage(world)[0]?.layers).toEqual(layers(2, 1, 1));
    expect(measures(world).cover).toEqual(layers(1, 0, 0));
    expect(checkAtlas(world)).toEqual([]);
  });

  it("counts the most paths with no shared part, the origins that issue the class, and the unknowns apart", () => {
    const at = (id: string, origins: string[], path: string[]): Source => ({ ...source(id, ["met.flood"], "adopt"), origins, path });
    const sources = [
      at("a", ["nws"], ["api.example.org", "cdn:edge"]),
      at("b", ["nws"], ["mirror.example.org", "cdn:edge"]),
      at("c", ["county"], ["c.example.org"]),
      at("d", [UNKNOWN], [UNKNOWN]),
    ];
    const plain = atlas([klass("met.flood")], sources);
    // The county issues safety codes only, so it is not an origin of met.flood.
    const world: Atlas = { ...plain, origins: plain.origins.map((origin) => (origin.id === "county" ? { ...origin, issues: ["safety"] } : origin)) };
    expect(coverage(world)[0]?.layers).toEqual(layers(4, 2, 1));
    expect(measures(world)).toMatchObject({ unknownOrigins: 1, unknownPaths: 1 });
    expect(checkAtlas(world)).toEqual([]);
    expect(coverage(plain)[0]?.layers).toEqual(layers(4, 2, 2));
  });

  it("counts a parent class at one leaf code: two sources of two different children are not a pair", () => {
    const classes = [klass("market.crypto"), klass("market.crypto.depeg", "one source"), klass("market.crypto.hack", "one source")];
    const apart = [source("a", ["market.crypto.depeg"], "adopt"), source("b", ["market.crypto.hack"], "adopt")];
    expect(coverage(atlas(classes, apart))[0]).toMatchObject({ sources: ["a", "b"], shared: 1, layers: layers(1, 1, 1) });
    expect(checkAtlas(atlas(classes, apart))).toEqual([{ at: "class market.crypto", problem: "the class has 1 sources with no risk at one leaf code and no reason of a gap" }]);
    expect(pairClaims(atlas(classes, apart))).toEqual([]);
    // A source of the parent itself reaches each leaf code, so it makes a pair with each child.
    const withParent = atlas(classes, [...apart, source("c", ["market.crypto"], "adopt")]);
    expect(coverage(withParent)[0]).toMatchObject({ shared: 2, layers: layers(2, 2, 1) });
    expect(checkAtlas(withParent)).toEqual([]);
    expect(pairClaims(withParent).map((claim) => `${claim.a} ${claim.b} ${claim.classes.join(",")}`)).toEqual(["a c market.crypto", "b c market.crypto"]);
  });

  it("counts an origin at a leaf code only when it issues the code or an ancestor of it", () => {
    // One source carries two origins, and each origin issues a different child. No leaf code has 2 origins.
    const plain = atlas([klass("geo.volcano", "one source")], [{ ...source("a", ["geo.volcano"], "adopt"), origins: ["ash-center", "observatory"] }]);
    const issuing = (ash: string[], observatory: string[]): Atlas => ({
      ...plain,
      origins: [
        { id: "ash-center", name: "ash-center", issues: ash, note: "a test" },
        { id: "observatory", name: "observatory", issues: observatory, note: "a test" },
      ],
    });
    expect(coverage(issuing(["geo.volcano.ashfall"], ["geo.volcano.eruption"]))[0]?.layers).toEqual(layers(1, 1, 1));
    // An origin of the parent code issues each leaf code of it.
    expect(coverage(issuing(["geo.volcano.ashfall"], ["geo.volcano"]))[0]?.layers).toEqual(layers(1, 1, 2));
  });

  it("counts the origins in the part of the Earth with the fewest: a relay of a network adds no origin in its region", () => {
    const at = (id: string, origins: string[], regionalOrigins?: RegionalOrigins[]): Source => ({
      ...source(id, ["geo.earthquake"], "adopt"),
      origins,
      ...(regionalOrigins === undefined ? {} : { regionalOrigins }),
    });
    const network = at("network", ["network"]);
    const relay = at("relay", ["relay", "network"], [{ region: "us", origins: ["network"], note: "a test" }]);
    const world = atlas([klass("geo.earthquake")], [network, relay], [WORLD, US]);
    // In the United States both sources give the solutions of the network. In the rest of the Earth the relay adds its own.
    expect(coverage(world)[0]?.layers).toEqual(layers(2, 2, 1));
    expect(checkAtlas(world)).toEqual([]);
    expect(pairClaims(world)).toEqual([{ a: "network", b: "relay", classes: ["geo.earthquake"], origins: ["network"], path: [] }]);
    // With no regional entry, the relay counts as a second origin.
    expect(coverage(atlas([klass("geo.earthquake")], [network, at("relay", ["relay", "network"])]))[0]?.layers).toEqual(layers(2, 2, 2));
    // An origin in each part of the Earth makes the fewest 2.
    const withThird = atlas([klass("geo.earthquake")], [network, relay, at("authorities", ["authorities"])], [WORLD, US]);
    expect(coverage(withThird)[0]?.layers).toEqual(layers(3, 3, 2));
    expect(measures(withThird).total.origins).toBe(2);
  });

  it("gives the origins of the smallest region that holds a part of the Earth, else the field origins", () => {
    const region = (id: string, parent: string): Region => ({ id, name: id, parent, note: "a test" });
    const regions = [WORLD, region("americas", "world"), region("us", "americas"), region("europe", "world")];
    const relay = {
      origins: ["relay"],
      regionalOrigins: [
        { region: "americas", origins: ["continent"], note: "a test" },
        { region: "us", origins: ["network"], note: "a test" },
      ],
    };
    expect(["world", "americas", "us", "europe"].map((id) => originsAt(relay, id, regions))).toEqual([["relay"], ["continent"], ["network"], ["relay"]]);
    expect(originsAt({ origins: ["relay"] }, "us", regions)).toEqual(["relay"]);
  });

  it("gives the most sets with no shared item by an exact search", () => {
    expect(mostDisjoint([])).toBe(0);
    expect(mostDisjoint([["a"], ["a"], ["b"]])).toBe(2);
    // The first set shares an item with each other set, so a greedy choice of the first set gives 1.
    expect(mostDisjoint([["a", "b"], ["a"], ["b"]])).toBe(2);
    expect(mostDisjoint([["a"], ["b"], ["c"], ["a", "c"]])).toBe(3);
  });

  it("stops a change that makes a layer fall below the measure of the latest round", () => {
    const covered = atlas([klass("infra.power")], [source("a", ["infra.power"], "adopt"), source("b", ["infra.power"], "adopt")]);
    const measured = { classes: 1, gaps: 0, cover: layers(1, 1, 0), total: layers(2, 2, 1), unknownOrigins: 0, unknownPaths: 0, cause: "a test" };
    const recorded: Atlas = { ...covered, rounds: [{ ...round, measures: measured }] };
    expect(checkAtlas(recorded)).toEqual([]);
    const fallen: Atlas = { ...recorded, sources: [source("a", ["infra.power"], "adopt"), source("b", ["infra.power"])] };
    expect(checkAtlas(fallen)).toEqual([
      { at: "atlas", problem: "the cover of the layer adopted is 0, below the 1 of round 1" },
      { at: "atlas", problem: "the cover of the layer paths is 0, below the 1 of round 1" },
      { at: "atlas", problem: "the total of the layer adopted is 1, below the 2 of round 1" },
      { at: "atlas", problem: "the total of the layer paths is 1, below the 2 of round 1" },
    ]);
    // A shared path does not lower the adopted layer: only the path layer falls.
    const onePath: Atlas = { ...recorded, sources: recorded.sources.map((item) => ({ ...item, path: ["a.example.org"] })), paths: [recorded.paths[0]!] };
    expect(checkAtlas(onePath).map((item) => item.problem)).toEqual([
      "the cover of the layer paths is 0, below the 1 of round 1",
      "the total of the layer paths is 1, below the 2 of round 1",
    ]);
    const bad: Atlas = { ...recorded, rounds: [{ ...round, measures: { ...measured, classes: -1, gaps: 0.5, cause: " " } }] };
    expect(checkAtlas(bad).map((item) => item.problem)).toEqual(["the measure -1 is not a count", "the measure 0.5 is not a count", "the measures have no cause"]);
    const { cover: _cover, ...noCover } = measured;
    expect(checkAtlas({ ...recorded, rounds: [{ ...round, measures: noCover as Round["measures"] }] }).map((item) => item.problem)).toEqual([
      "the measure undefined is not a count",
      "the measure undefined is not a count",
      "the measure undefined is not a count",
    ]);
    const { measures: _gone, ...unmeasured } = round;
    expect(checkAtlas({ ...recorded, rounds: [unmeasured as Round] })).toEqual([{ at: "round 1", problem: "the round has no measures" }]);
  });

  it("takes the floor from the latest round, so a loss passes only with a new round that names it", () => {
    const ids = ["infra.power", "infra.water", "met.flood"];
    // The first `count` classes have 2 adopted sources each, on 2 paths, from 1 origin. The other classes have no source.
    const covering = (count: number): Atlas =>
      atlas(
        ids.map((id, index) => klass(id, index < count ? null : "no source")),
        ids.slice(0, count).flatMap((id, index) => [source(`s${String(index)}a`, [id], "adopt"), source(`s${String(index)}b`, [id], "adopt")]),
      );
    const measured = (number: number, count: number, cause: string): Round => ({
      ...round,
      round: number,
      measures: { classes: 3, gaps: 3 - count, cover: layers(count, count, 0), total: layers(2 * count, 2 * count, count), unknownOrigins: 0, unknownPaths: 0, cause },
    });
    const rounds = [measured(1, 3, "a test"), measured(2, 2, "A source lost its terms of use.")];
    expect(checkAtlas({ ...covering(2), rounds })).toEqual([]);
    expect(checkAtlas({ ...covering(2), rounds: [...rounds].reverse() })).toEqual([]);
    expect(checkAtlas({ ...covering(1), rounds }).map((item) => item.problem)).toEqual([
      "the cover of the layer adopted is 1, below the 2 of round 2",
      "the cover of the layer paths is 1, below the 2 of round 2",
      "the total of the layer adopted is 2, below the 4 of round 2",
      "the total of the layer paths is 2, below the 4 of round 2",
      "the total of the layer origins is 1, below the 2 of round 2",
    ]);
    // With no new round, the loss stops at the gate.
    expect(checkAtlas({ ...covering(2), rounds: rounds.slice(0, 1) }).map((item) => item.problem)).toEqual([
      "the cover of the layer adopted is 2, below the 3 of round 1",
      "the cover of the layer paths is 2, below the 3 of round 1",
      "the total of the layer adopted is 4, below the 6 of round 1",
      "the total of the layer paths is 4, below the 6 of round 1",
      "the total of the layer origins is 2, below the 3 of round 1",
    ]);
    expect(checkAtlas({ ...covering(3), rounds: [...rounds, measured(2, 3, "a copy")] })).toEqual([{ at: "atlas", problem: "two records of rounds have one number" }]);
  });

  it("stops a bad origin, a bad part of a path and a bad list of a source", () => {
    const classes = [klass("met.flood", "a test")];
    const empty = { ...source("empty", ["met.flood"]), origins: [], path: [] };
    const twice = { ...source("twice", ["met.flood"]), origins: ["nws", "nws"], path: ["cdn:edge"] };
    const ghost = { ...source("ghost", ["met.flood"]), origins: ["nowhere"], path: ["no.example.org"] };
    const world: Atlas = {
      ...atlas(classes, [source("a", ["met.flood"])]),
      sources: [source("a", ["met.flood"]), empty, twice, ghost],
      origins: [
        { id: "test-origin", name: "a test", issues: null, note: "a test" },
        { id: "nws", name: "a test", issues: ["met.fl"], note: "a test" },
        { id: "nws", name: "a test", issues: null, note: "a test" },
        { id: "unused", name: "a test", issues: null, note: " " },
        { id: "Bad Id", name: "a test", issues: null, note: "a test" },
      ],
      paths: [
        { id: "a.example.org", name: "a test", kind: "host", note: "a test" },
        { id: "cdn:edge", name: "a test", kind: "cdn", note: "a test" },
        { id: "cdn:b.example.org", name: "a test", kind: "host", note: "a test" },
        { id: "noaaport", name: "a test", kind: "carrier", note: "a test" },
        { id: "provider:x", name: "a test", kind: "cdn", note: "a test" },
        { id: "cable", name: "a test", kind: "cable" as string as "host", note: "" },
      ],
    };
    expect(checkAtlas(world).map((item) => `${item.at}: ${item.problem}`)).toEqual(
      expect.arrayContaining([
        "origin nws: the code met.fl is not in the taxonomy",
        "origin nws: the id is not unique",
        "origin unused: the origin has no name or no note",
        "origin unused: no source names the origin",
        "origin Bad Id: the id is not in lower case with hyphens and dots, or it is unknown",
        "path cable: the kind cable is not known",
        "path cdn:b.example.org: the id of a host has no prefix",
        "path noaaport: the id of a part of the kind carrier starts with carrier:",
        "path provider:x: the id of a part of the kind cdn starts with cdn:",
        "path cable: the part has no name or no note",
        "path cable: no source names the part",
        "source empty: the source has no origins: give the ids, or unknown",
        "source empty: the source has no path: give the ids, or unknown",
        "source twice: the origins have a duplicate",
        "source twice: the first part of the path is not a host",
        "source ghost: the id nowhere of the origins is not in its list",
        "source ghost: the id no.example.org of the path is not in its list",
      ]),
    );
  });

  it("reads a source with no lists as a source with unknown lists", () => {
    const { origins: _origins, ...old } = source("a", ["met.flood"], "adopt");
    const world: Atlas = { ...atlas([klass("met.flood", "one source")], [source("a", ["met.flood"])]), sources: [old as Source] };
    expect(coverage(world)[0]?.layers).toEqual(layers(1, 1, 0));
    expect(measures(world).unknownOrigins).toBe(1);
    expect(checkAtlas(world)).toEqual([{ at: "source a", problem: "the source has no origins: give the ids, or unknown" }]);
  });

  it("stops a tree of regions with two roots, a lost parent or a cycle, and a region that no source names", () => {
    const region = (id: string, parent: string | null): Region => ({ id, name: id, parent, note: "a test" });
    const entry = (id: string): RegionalOrigins => ({ region: id, origins: ["test-origin"], note: "a test" });
    const regions = [WORLD, region("moon", null), region("loop-a", "loop-b"), region("loop-b", "loop-a"), region("lost", "nowhere"), region("child", "loop-a"), region("spare", "world")];
    const named = { ...source("a", ["met.flood"], "adopt"), regionalOrigins: ["loop-a", "loop-b", "lost", "child"].map(entry) };
    expect(checkAtlas(atlas([klass("met.flood", "one source")], [named], regions))).toEqual([
      { at: "regions", problem: "the tree has 2 roots, not 1" },
      { at: "region loop-a", problem: "the chain of parents of the region has a cycle" },
      { at: "region loop-b", problem: "the chain of parents of the region has a cycle" },
      { at: "region lost", problem: "the parent nowhere is not a region" },
      { at: "region child", problem: "the chain of parents of the region has a cycle" },
      { at: "region spare", problem: "no source names the region" },
    ]);
  });

  it("stops a regional entry with no shape, the root, a second entry, a lost region, no note, or a bad list", () => {
    const entry = (id: string, origins: string[], note = "a test"): RegionalOrigins => ({ region: id, origins, note });
    const bad = {
      ...source("a", ["met.flood"], "adopt"),
      regionalOrigins: [
        entry("world", ["test-origin"]),
        entry("us", ["test-origin"]),
        entry("us", ["nowhere", "test-origin", "test-origin"]),
        entry("mars", [], " "),
        { region: "eu" } as unknown as RegionalOrigins,
      ],
    };
    const plain = atlas([klass("met.flood", "one source")], [bad], [WORLD, US]);
    const world: Atlas = { ...plain, origins: plain.origins.filter((origin) => origin.id === "test-origin") };
    expect(checkAtlas(world).map((item) => `${item.at}: ${item.problem}`)).toEqual([
      "source a: each regional origin needs a region, a list of origins and a note",
      "source a: the region world is the root: give its origins in the field origins",
      "source a: the region us has two entries",
      "source a: the region mars is not a region of the tree",
      "source a: the entry of the region mars has no note",
      "source a: the origins in us have a duplicate",
      "source a: the id nowhere of the origins in us is not in its list",
      "source a: the source has no origins in mars: give the ids, or unknown",
    ]);
    // An unknown origin in a regional entry counts as an unknown origin of the source.
    const unknownThere = { ...source("b", ["met.flood"], "adopt"), regionalOrigins: [entry("us", [UNKNOWN])] };
    expect(measures(atlas([klass("met.flood", "one source")], [unknownThere], [WORLD, US])).unknownOrigins).toBe(1);
  });

  it("has the layers of the committed atlas at or above the last round", () => {
    const committed = readAtlas();
    const last = committed.rounds.at(-1);
    const now = measures(committed);
    for (const name of LAYERS) {
      expect(now.cover[name], name).toBeGreaterThanOrEqual(last?.measures.cover[name] ?? 0);
      expect(now.total[name], name).toBeGreaterThanOrEqual(last?.measures.total[name] ?? 0);
    }
  });
});

describe("the dimensions of indicators", () => {
  const indicator = (id: string, dimensions: readonly string[], decision: Source["decision"] = "plan"): Source => ({ ...source(id, [], decision), dimensions: dimensions as Source["dimensions"] });
  const classes = [klass("met.flood", "no source")];

  it("takes a source with a dimension and no class, and stops a source with no class and no dimension", () => {
    expect(checkAtlas(atlas(classes, [indicator("a", ["road-traffic"])]))).toEqual([]);
    expect(checkAtlas(atlas(classes, [source("b", [])]))).toEqual([{ at: "source b", problem: "the source has no class and no dimension" }]);
  });

  it("stops an empty list, a duplicate and an id that is not a dimension of the core", () => {
    const problems = checkAtlas(atlas(classes, [indicator("a", []), indicator("b", ["rail", "rail"]), indicator("c", ["rail-delays"])])).map((item) => `${item.at}: ${item.problem}`);
    expect(problems).toEqual([
      "source a: the field dimensions has no id: give one or more, or no field",
      "source b: the dimensions have a duplicate",
      "source c: the dimension rail-delays is not in DIMENSIONS of the core",
    ]);
  });

  it("counts the adopted and planned sources with no risk of each dimension, in the order of the core", () => {
    const risky = { ...indicator("c", ["rail"]), risks: ["The terms can change."] };
    const sources = [indicator("a", ["rail", "air-traffic"]), indicator("b", ["rail"], "adopt"), risky, indicator("d", ["air-traffic"], "later")];
    const rows = dimensionCoverage(atlas(classes, sources));
    expect(rows.map((row) => row.id)).toEqual(DIMENSION_IDS);
    expect(rows.find((row) => row.id === "rail")?.sources).toEqual(["a", "b"]);
    expect(rows.find((row) => row.id === "air-traffic")?.sources).toEqual(["a"]);
    expect(measures(atlas(classes, sources)).dimensions).toBe(1);
  });

  it("stops a fall of the dimensions with two live sources below the latest round, and a measure that is not a count", () => {
    const sources = [indicator("a", ["rail"]), indicator("b", ["rail"])];
    const rounds = [{ ...round, measures: { ...round.measures, dimensions: 1 } }];
    expect(checkAtlas({ ...atlas(classes, sources), rounds })).toEqual([]);
    expect(checkAtlas({ ...atlas(classes, sources.slice(0, 1)), rounds })).toEqual([{ at: "atlas", problem: "0 dimensions have 2 live sources, below the 1 of round 1" }]);
    const bad = [{ ...round, measures: { ...round.measures, dimensions: -1 } }];
    expect(checkAtlas({ ...atlas(classes, sources), rounds: bad }).map((item) => item.problem)).toEqual(["the measure -1 is not a count"]);
  });
});

describe("the claims of the pairs", () => {
  it("gives the shared origins and parts of each pair with a shared class, and never a shared unknown", () => {
    const at = (id: string, decision: Source["decision"], origins: string[], path: string[], classes = ["met.flood"]): Source => ({ ...source(id, classes, decision), origins, path });
    const sources = [
      at("a", "adopt", ["nws"], ["api.example.org", "cdn:edge"]),
      at("b", "plan", ["nws"], ["mirror.example.org", "cdn:edge"]),
      at("c", "plan", [UNKNOWN], [UNKNOWN]),
      at("d", "later", ["nws"], ["api.example.org"]),
      at("e", "plan", ["nws"], ["api.example.org"], ["infra.power"]),
      at("f", "plan", [UNKNOWN], [UNKNOWN]),
    ];
    const world = atlas([klass("met.flood"), klass("infra.power")], sources);
    const pair = (a: string, b: string, origins: string[], path: string[]) => ({ a, b, classes: ["met.flood"], origins, path });
    expect(pairClaims(world)).toEqual([
      pair("a", "b", ["nws"], ["cdn:edge"]),
      pair("a", "c", [], []),
      pair("a", "f", [], []),
      pair("b", "c", [], []),
      pair("b", "f", [], []),
      pair("c", "f", [], []),
    ]);
    expect(pairClaims(world, ["adopt", "later"])).toEqual([pair("a", "d", ["nws"], ["api.example.org"])]);
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

  it("gives the leaf codes of a class", () => {
    const codes = ["market.crypto", "market.crypto.depeg", "market.crypto.hack", "market.cryptography", "infra.power"];
    expect(leafCodes("market.crypto", codes)).toEqual(["market.crypto.depeg", "market.crypto.hack"]);
    expect(leafCodes("market.crypto.hack", codes)).toEqual(["market.crypto.hack"]);
    expect(leafCodes("infra.water", codes)).toEqual(["infra.water"]);
    expect(leafCodes("geo.volcano")).toEqual(["geo.volcano.ashfall", "geo.volcano.ashfall-marine", "geo.volcano.eruption"]);
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
