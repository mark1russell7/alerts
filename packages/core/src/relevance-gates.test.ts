// The gates of the relevance (AL-35, `docs/RELEVANCE.md`, the section "The gates"). Each graph here is made up.

import { RATIONAL_RING, ZERO, compare, fromFloat, type Rational } from "@mark1russell7/rational";
import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { Estimate, InterestEdge, InterestGraph, Mute, NodeKey, PersonId, RelevancePolicy, SubjectEntry, SubjectKind } from "./contracts.ts";
import { reachOf, relevance, muteOf, topicEntry, type ReachArithmetic, type RelevanceInput } from "./relevance.ts";
import { relevanceSchema } from "./schemas.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

// The exact arithmetic of the gates: the ring of the rationals, and each float weight as its exact rational.
const EXACT: ReachArithmetic<Rational> = { ring: RATIONAL_RING, of: fromFloat };

const POLICY: RelevancePolicy = { hopCap: 4, topPaths: 2, mandatory: "silent" };
const AT = Date.UTC(2026, 10, 20);
const point = (value: number, doubt = 0): Estimate => ({ value, low: Math.max(0, value - doubt), high: Math.min(1, value + doubt) });
const graphOf = (edges: readonly InterestEdge[], mutes: readonly Mute[] = []): InterestGraph => ({
  format: "alerts-interest/1",
  person: "person:example" as PersonId,
  edges,
  mutes,
});
const entry = (node: NodeKey, kind: SubjectKind, hit = point(1)): SubjectEntry => ({ node, kind, hit });
const input = (kind: string, entries: readonly SubjectEntry[], mandatory = false): RelevanceInput => ({ kind, entries, at: AT, mandatory });

// A made-up person: a home and a work place, a power utility, a DNS provider, two web services and a cloud region.
const EDGES: readonly InterestEdge[] = [
  { id: "e3", from: "wikidata:Q123", to: "place:home", kind: "physical", weight: point(0.5, 0.2), origin: "data", source: "eia-861/2025", date: "2026-11-15", on: true },
  { id: "e7", from: "domain:dns.example", to: "domain:bank.example", kind: "cyber", weight: point(0.9, 0.1), origin: "measured", date: "2026-11-15", on: true },
  { id: "e8", from: "domain:dns.example", to: "domain:web.example", kind: "cyber", weight: point(0.4, 0.1), origin: "measured", date: "2026-11-15", on: true },
  { id: "e9", from: "provider-region:cloud/east-1", to: "domain:dns.example", kind: "cyber", weight: point(0.5), origin: "measured", date: "2026-11-15", on: true },
  { id: "i1", from: "place:home", to: "person", kind: "interest", weight: point(1), origin: "base", on: true },
  { id: "i2", from: "place:work", to: "person", kind: "interest", weight: point(0.6, 0.1), origin: "places", on: true },
  { id: "i3", from: "iso3166:US-KS", to: "person", kind: "interest", weight: point(0.15, 0.1), origin: "places", on: false },
  { id: "i4", from: "domain:bank.example", to: "person", kind: "interest", weight: point(0.7), origin: "person", date: "2026-11-15", on: true },
  { id: "i5", from: "domain:web.example", to: "person", kind: "interest", weight: point(0.4, 0.2), origin: "work", on: true },
  { id: "t1", from: "topic:infra", to: "person", kind: "interest", weight: point(0.1), origin: "work", on: true },
  { id: "t2", from: "topic:infra.telecom", to: "person", kind: "interest", weight: point(0.3, 0.1), origin: "work", on: true },
];
const MUTES: readonly Mute[] = [{ id: "m1", kinds: ["met.tornado"], until: Date.UTC(2026, 11, 1), date: "2026-11-15" }];
const PERSON_GRAPH = graphOf(EDGES, MUTES);

// The tornado warning near the home: it hits the home with a chance of 0.6 and the lines of the utility with 0.3.
const TORNADO = [entry("place:home", "place", point(0.6)), entry("wikidata:Q123", "entity", point(0.3))];

// ---------------------------------------------------------------------------------------------------------------------
// Random graphs and a brute force
// ---------------------------------------------------------------------------------------------------------------------

const SUBJECTS: readonly (readonly [NodeKey, SubjectKind])[] = [
  ["place:a", "place"],
  ["place:b", "place"],
  ["domain:x.example", "entity"],
  ["domain:y.example", "entity"],
  ["topic:met", "topic"],
];
const ORIGINS = ["base", "places", "services", "delivery", "work", "data", "measured", "person"] as const;

// A weight in sixteenths, so each sum is exact in floats too, with an interval that holds it.
function weight(r: Random): Estimate {
  const value = r.int(0, 16);
  return { value: value / 16, low: r.int(0, value) / 16, high: r.int(value, 16) / 16 };
}

interface Case {
  readonly graph: InterestGraph;
  readonly input: RelevanceInput;
  readonly policy: RelevancePolicy;
}

function randomCase(r: Random): Case {
  const edges: InterestEdge[] = [];
  const count = r.int(0, 7);
  for (let at = 0; at < count; at += 1) {
    const [from] = r.pick(SUBJECTS);
    const to = r.chance(0.4) ? "person" : r.pick(SUBJECTS)[0];
    if (from === to) continue;
    edges.push({ id: `e${at}`, from, to, kind: to === "person" ? "interest" : "cyber", weight: weight(r), origin: r.pick(ORIGINS), on: r.chance(0.85) });
  }
  const entries = r.shuffle(SUBJECTS).slice(0, r.int(0, 3)).map(([node, kind]) => entry(node, kind, weight(r)));
  const policy: RelevancePolicy = { hopCap: r.int(1, 4), topPaths: r.int(1, 3), mandatory: r.pick(["absent", "silent"] as const) };
  return { graph: graphOf(edges), input: input(r.pick(["met.tornado", "infra.telecom", "other.unknown"]), entries), policy };
}

// The edges of the problem: one edge from the event to each entry, then each edge that is on.
function problem(c: Case): { from: string; to: string; chance: number }[] {
  return [
    ...c.input.entries.map((e) => ({ from: "", to: e.node, chance: e.hit.value })),
    ...c.graph.edges.filter((e) => e.on).map((e) => ({ from: e.from, to: e.to, chance: e.weight.value })),
  ];
}

// The chance that one set of edges or more of `sets` works, by a sum over each state of the edges.
function bruteForce(chances: readonly number[], works: (mask: number) => boolean): number {
  let total = 0;
  for (let mask = 0; mask < 1 << chances.length; mask += 1) {
    if (!works(mask)) continue;
    let chance = 1;
    for (const [index, p] of chances.entries()) chance *= (mask & (1 << index)) !== 0 ? p : 1 - p;
    total += chance;
  }
  return total;
}

// The reach by a brute force: a breadth-first search over the working edges, with the hop cap of the policy plus the hit edge.
function bruteReach(c: Case): number {
  const edges = problem(c);
  return bruteForce(
    edges.map((e) => e.chance),
    (mask) => {
      const distance = new Map<string, number>([["", 0]]);
      const queue = [""];
      while (queue.length > 0) {
        const node = queue.shift()!;
        const next = distance.get(node)! + 1;
        if (next > c.policy.hopCap + 1) continue;
        for (const [index, e] of edges.entries()) {
          if ((mask & (1 << index)) === 0 || e.from !== node || distance.has(e.to)) continue;
          if (e.to === "person") return true;
          distance.set(e.to, next);
          queue.push(e.to);
        }
      }
      return false;
    },
  );
}

const exactValue = (c: Case, end: "low" | "value" | "high" = "value"): Rational => {
  const result = reachOf(c.input, c.graph, c.policy, EXACT, end);
  if (result.kind !== "exact") throw new Error("The budget ended a small sum.");
  return result.value;
};

// ---------------------------------------------------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------------------------------------------------

describe("the gate: an opt-out wins", () => {
  it.each(SEEDS)("gives 0 and no path for each matched mute, on each graph with each weight (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 100; round += 1) {
      const c = randomCase(r);
      const node = c.input.entries[0]?.node;
      const mute: Mute =
        node !== undefined && r.chance(0.5)
          ? { id: "m", subjects: [node], ...(r.chance(0.5) ? { until: AT + 1 } : {}), date: "2026-11-15" }
          : { id: "m", kinds: [c.input.kind.split(".")[0]!], date: "2026-11-15" };
      const muted = { ...c, graph: graphOf(c.graph.edges, [mute]) };
      expect(relevance(muted.input, muted.graph, c.policy)).toEqual({ reach: { value: 0, low: 0, high: 0 }, best: 0, noisyOr: 0, paths: [], muted: { mute: "m", effect: "absent" } });
      // The mandatory class: the policy gives the effect. With `silent`, the reach stays and the sound goes.
      const mandatory = { ...muted.input, mandatory: true };
      const plain = relevance(c.input, c.graph, c.policy);
      if (c.policy.mandatory === "silent") expect(relevance(mandatory, muted.graph, c.policy)).toEqual({ ...plain, muted: { mute: "m", effect: "silent" } });
      else expect(relevance(mandatory, muted.graph, c.policy).reach).toEqual({ value: 0, low: 0, high: 0 });
      // A mute that ended has no effect.
      const ended = graphOf(c.graph.edges, [{ ...mute, until: AT }]);
      expect(relevance(c.input, ended, c.policy)).toEqual(plain);
    }
  });

  it.each(SEEDS)("does not raise the reach when an edge goes off, and no why names a node of an edge that is off (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 100; round += 1) {
      const c = randomCase(r);
      if (c.graph.edges.length === 0) continue;
      const off = r.int(0, c.graph.edges.length - 1);
      const edges = c.graph.edges.map((e, at) => (at === off ? { ...e, on: false } : e));
      const less = { ...c, graph: graphOf(edges) };
      const label = `seed ${seed} round ${round}`;
      expect(compare(exactValue(less), exactValue(c)), label).toBeLessThanOrEqual(0);
      const why = relevance(less.input, less.graph, c.policy).why;
      if (why === undefined) continue;
      const on = edges.filter((e) => e.on);
      expect(on.some((e) => e.from === why.anchor && e.to === "person"), label).toBe(true);
      if (why.via !== undefined) expect(on.some((e) => e.from === why.subject && e.to === why.via), label).toBe(true);
    }
  });

  it.each(SEEDS)("cuts each muted subject that is not an entry: each path through it goes, and the reach does not rise (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 100; round += 1) {
      const c = randomCase(r);
      const entries = new Set(c.input.entries.map((e) => e.node));
      const others = SUBJECTS.map(([node]) => node).filter((node) => !entries.has(node));
      const subjects = r.shuffle(others).slice(0, r.int(1, 2));
      if (subjects.length === 0) continue;
      const mute: Mute = { id: "m", subjects, ...(r.chance(0.5) ? { kinds: [c.input.kind.split(".")[0]!] } : {}), date: "2026-11-15" };
      const muted: Case = { ...c, graph: graphOf(c.graph.edges, [mute]) };
      // The same graph with each edge into or out of a muted subject off.
      const cut: Case = { ...c, graph: graphOf(c.graph.edges.map((e) => (subjects.includes(e.from) || subjects.includes(e.to) ? { ...e, on: false } : e))) };
      const label = `seed ${seed} round ${round}`;
      for (const end of ["low", "value", "high"] as const) expect(exactValue(muted, end), label).toEqual(exactValue(cut, end));
      expect(compare(exactValue(muted), exactValue(c)), label).toBeLessThanOrEqual(0);
      const result = relevance(muted.input, muted.graph, c.policy);
      expect(result, label).toEqual(relevance(cut.input, cut.graph, c.policy));
      expect(result.muted, label).toBeUndefined();
      const named = [result.why?.subject, result.why?.via, result.why?.anchor, ...result.paths.map((path) => path.subject)];
      expect(named.some((node) => node !== undefined && subjects.includes(node)), label).toBe(false);
      const ids = new Set(c.graph.edges.filter((e) => subjects.includes(e.from) || subjects.includes(e.to)).map((e) => e.id));
      expect(result.paths.some((path) => path.edges.some((id) => ids.has(id))), label).toBe(false);
      // The mandatory class: under the policy `silent`, a mute changes only the sound, so it cuts nothing.
      const mandatory = { ...c.input, mandatory: true };
      const expected = c.policy.mandatory === "silent" ? relevance(mandatory, c.graph, c.policy) : relevance(mandatory, cut.graph, c.policy);
      expect(relevance(mandatory, muted.graph, c.policy), label).toEqual(expected);
      // A mute of another kind and a mute that ended cut nothing.
      const plain = relevance(c.input, c.graph, c.policy);
      expect(relevance(c.input, graphOf(c.graph.edges, [{ ...mute, kinds: ["zz"] }]), c.policy), label).toEqual(plain);
      expect(relevance(c.input, graphOf(c.graph.edges, [{ ...mute, until: AT }]), c.policy), label).toEqual(plain);
    }
  });
});

describe("the gate: one answer in any order", () => {
  it.each(SEEDS)("gives the same reach, bit for bit, for each order of the edges, the entries and the mutes (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 100; round += 1) {
      const c = randomCase(r);
      const mutes: Mute[] = [
        { id: "m2", subjects: ["place:a"], date: "2026-11-15" },
        { id: "m1", kinds: ["infra"], date: "2026-11-15" },
      ];
      const shuffled: Case = { ...c, graph: graphOf(r.shuffle(c.graph.edges), r.shuffle(mutes)), input: { ...c.input, entries: r.shuffle(c.input.entries) } };
      const sorted: Case = { ...c, graph: graphOf(c.graph.edges, mutes) };
      for (const end of ["low", "value", "high"] as const) expect(exactValue(shuffled, end)).toEqual(exactValue(sorted, end));
      expect(relevance(shuffled.input, shuffled.graph, c.policy)).toEqual(relevance(sorted.input, sorted.graph, c.policy));
    }
  });
});

describe("the gate: monotone", () => {
  it.each(SEEDS)("does not lower the reach when a weight or a hit goes up (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 100; round += 1) {
      const c = randomCase(r);
      const parts = c.graph.edges.length + c.input.entries.length;
      if (parts === 0) continue;
      const at = r.int(0, parts - 1);
      const up = (w: Estimate): Estimate => {
        const value = r.int(w.value * 16, 16) / 16;
        return { value, low: w.low, high: Math.max(w.high, value) };
      };
      const higher: Case =
        at < c.graph.edges.length
          ? { ...c, graph: graphOf(c.graph.edges.map((e, i) => (i === at ? { ...e, weight: up(e.weight) } : e))) }
          : { ...c, input: { ...c.input, entries: c.input.entries.map((e, i) => (i === at - c.graph.edges.length ? { ...e, hit: up(e.hit) } : e)) } };
      expect(compare(exactValue(higher), exactValue(c)), `seed ${seed} round ${round}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the gate: inside the bounds", () => {
  it.each(SEEDS)("gives best <= R <= noisyOr, and R equals a brute force (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 100; round += 1) {
      const c = randomCase(r);
      const label = `seed ${seed} round ${round}`;
      const exact = reachOf(c.input, c.graph, c.policy, EXACT);
      if (exact.kind !== "exact") throw new Error(label);
      expect(compare(exact.best, exact.value), label).toBeLessThanOrEqual(0);
      expect(compare(exact.value, exact.noisyOr), label).toBeLessThanOrEqual(0);
      // The weights are sixteenths, so the float sum of the brute force is exact.
      expect(exact.value, label).toEqual(fromFloat(bruteReach(c)));
      for (const end of ["low", "value"] as const) {
        expect(compare(exactValue(c, end), exactValue(c, end === "low" ? "value" : "high")), label).toBeLessThanOrEqual(0);
      }
    }
  });
});

describe("the gate: hop cap and cycles", () => {
  // A chain from a place to the person: place:a -> domain:x -> domain:y -> person, 3 edges, at the cap 3.
  const chain = (r: Random): InterestEdge[] => [
    { id: "c1", from: "place:a", to: "domain:x.example", kind: "cyber", weight: weight(r), origin: "data", on: true },
    { id: "c2", from: "domain:x.example", to: "domain:y.example", kind: "cyber", weight: weight(r), origin: "data", on: true },
    { id: "c3", from: "domain:y.example", to: "person", kind: "interest", weight: weight(r), origin: "services", on: true },
  ];
  const extra = (id: string, from: NodeKey, to: NodeKey, r: Random): InterestEdge => ({ id, from, to, kind: "cyber", weight: weight(r), origin: "data", on: true });

  it.each(SEEDS)("does not change for an edge that adds only a cycle, a path over the cap or a dead end (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 50; round += 1) {
      const edges = chain(r);
      const base: Case = { graph: graphOf(edges), input: input("infra.telecom", [entry("place:a", "place", weight(r))]), policy: { ...POLICY, hopCap: 3 } };
      const value = exactValue(base);
      const added = [
        [extra("x1", "domain:y.example", "domain:x.example", r)],
        [extra("x1", "place:a", "place:b", r), extra("x2", "place:b", "domain:x.example", r)],
        [extra("x1", "domain:x.example", "domain:dead.example", r)],
      ];
      for (const more of added) expect(exactValue({ ...base, graph: graphOf([...edges, ...more]) }), JSON.stringify(more)).toEqual(value);
      // The cap is a real limit: with the cap 2, the chain does not count.
      expect(exactValue({ ...base, policy: { ...base.policy, hopCap: 2 } })).toEqual(ZERO);
    }
  });
});

describe("the gate: an honest why", () => {
  it.each(SEEDS)("gives the reach of the shown paths alone, divided by the reach, as the coverage (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 100; round += 1) {
      const c = randomCase(r);
      const label = `seed ${seed} round ${round}`;
      const result = relevance(c.input, c.graph, c.policy);
      expect(relevanceSchema.parse(result), label).toEqual(result);
      expect(result.reach.value, label).toBeCloseTo(bruteReach(c), 12);
      if (result.why === undefined) {
        expect(result.paths, label).toEqual([]);
        continue;
      }
      // The shown paths, as sets of the edges of the problem: the hit edge of the subject and the edges of the graph.
      const edges = problem(c);
      const hitOf = (node: NodeKey) => edges.findIndex((e) => e.from === "" && e.to === node);
      const indexOf = (id: string) => c.input.entries.length + c.graph.edges.filter((e) => e.on).findIndex((e) => e.id === id);
      const sets = result.paths.map((path) => [hitOf(path.subject), ...path.edges.map(indexOf)]);
      const alone = bruteForce(
        edges.map((e) => e.chance),
        (mask) => sets.some((set) => set.every((index) => (mask & (1 << index)) !== 0)),
      );
      expect(result.why.coverage, label).toBeCloseTo(alone / result.reach.value, 12);
      expect(result.why.subject, label).toBe(result.paths[0]!.subject);
    }
  });
});

describe("the gate: who each class reaches", () => {
  // Each row: a class of event for the made-up person, and the expected reach and why. The tier of each row comes when
  // the score of AL-31 reads the reach.
  const rows: readonly {
    readonly name: string;
    readonly input: RelevanceInput;
    readonly policy?: RelevancePolicy;
    readonly reach: Estimate;
    readonly why?: { readonly rule: string; readonly anchor: NodeKey; readonly via?: NodeKey; readonly coverage: number };
    readonly muted?: string;
    /** The mutes of the row, after the mutes of the person. */
    readonly mutes?: readonly Mute[];
  }[] = [
    {
      name: "a tornado warning near the home, after the mute ends",
      input: { ...input("met.tornado", TORNADO), at: Date.UTC(2026, 11, 2) },
      reach: { value: 0.66, low: 0.636, high: 0.684 },
      why: { rule: "reach.place.base", anchor: "place:home", coverage: 1 },
    },
    { name: "a tornado warning in the mute", input: input("met.tornado", TORNADO), reach: { value: 0, low: 0, high: 0 }, muted: "absent" },
    {
      name: "a tornado warning of the mandatory class in the mute, with the policy silent",
      input: input("met.tornado", TORNADO, true),
      reach: { value: 0.66, low: 0.636, high: 0.684 },
      why: { rule: "reach.place.base", anchor: "place:home", coverage: 1 },
      muted: "silent",
    },
    {
      name: "a tornado warning of the mandatory class in the mute, with the policy absent",
      input: input("met.tornado", TORNADO, true),
      policy: { ...POLICY, mandatory: "absent" },
      reach: { value: 0, low: 0, high: 0 },
      muted: "absent",
    },
    {
      name: "an outage of the DNS provider",
      input: input("infra.telecom", [entry("domain:dns.example", "entity")]),
      // 1 - (1 - 0.9 * 0.7) * (1 - 0.4 * 0.4)
      reach: { value: 0.6892, low: 0.5864, high: 0.79 },
      why: { rule: "reach.entity.person", anchor: "domain:bank.example", coverage: 1 },
    },
    {
      name: "an outage of the DNS provider, with the bank muted",
      input: input("infra.telecom", [entry("domain:dns.example", "entity")]),
      mutes: [{ id: "m2", subjects: ["domain:bank.example"], date: "2026-11-15" }],
      // Only the path through the web service stays: 0.4 * 0.4.
      reach: { value: 0.16, low: 0.06, high: 0.3 },
      why: { rule: "reach.entity.work", anchor: "domain:web.example", coverage: 1 },
    },
    {
      name: "an outage of the DNS provider, with a mute of the weather alerts about the bank",
      input: input("infra.telecom", [entry("domain:dns.example", "entity")]),
      mutes: [{ id: "m2", kinds: ["met"], subjects: ["domain:bank.example"], date: "2026-11-15" }],
      reach: { value: 0.6892, low: 0.5864, high: 0.79 },
      why: { rule: "reach.entity.person", anchor: "domain:bank.example", coverage: 1 },
    },
    {
      name: "an outage of the cloud region, with one shown path",
      input: input("infra.telecom", [entry("provider-region:cloud/east-1", "entity")]),
      policy: { ...POLICY, topPaths: 1 },
      reach: { value: 0.3446, low: 0.2932, high: 0.395 },
      // The path region -> DNS -> bank -> person has two nodes between the subject and the person.
      why: { rule: "reach.entity.person", anchor: "domain:bank.example", via: "domain:dns.example", coverage: 0.315 / 0.3446 },
    },
    { name: "an event in a state with its edge off", input: input("met.flood.flash", [entry("iso3166:US-KS", "place")]), reach: { value: 0, low: 0, high: 0 } },
    {
      name: "an event at the work place",
      input: input("met.flood.flash", [entry("place:work", "place")]),
      reach: { value: 0.6, low: 0.5, high: 0.7 },
      why: { rule: "reach.place.places", anchor: "place:work", coverage: 1 },
    },
    {
      name: "a 911 outage far away, by its topic",
      input: input("infra.telecom.911-outage", [topicEntry("infra.telecom.911-outage", PERSON_GRAPH)!]),
      reach: { value: 0.3, low: 0.2, high: 0.4 },
      why: { rule: "reach.topic.work", anchor: "topic:infra.telecom", coverage: 1 },
    },
  ];

  it.each(rows)("$name", (row) => {
    const graph = row.mutes === undefined ? PERSON_GRAPH : graphOf(EDGES, [...MUTES, ...row.mutes]);
    const result = relevance(row.input, graph, row.policy ?? POLICY);
    expect(relevanceSchema.parse(result)).toEqual(result);
    expect(result.reach.value).toBeCloseTo(row.reach.value, 12);
    expect(result.reach.low).toBeCloseTo(row.reach.low, 12);
    expect(result.reach.high).toBeCloseTo(row.reach.high, 12);
    expect(result.muted?.effect).toBe(row.muted);
    if (row.why === undefined) {
      expect(result.why).toBeUndefined();
      return;
    }
    const { coverage, ...why } = result.why!;
    expect({ rule: why.rule, anchor: why.anchor, via: why.via }).toEqual({ rule: row.why.rule, anchor: row.why.anchor, via: row.why.via });
    expect(coverage).toBeCloseTo(row.why.coverage, 12);
  });

  it("gives the weakest edge and the next question of the tornado warning", () => {
    const result = relevance({ ...input("met.tornado", TORNADO), at: Date.UTC(2026, 11, 2) }, PERSON_GRAPH, POLICY);
    expect(result.paths).toEqual([
      { subject: "place:home", edges: ["i1"], chance: 0.6 },
      { subject: "wikidata:Q123", edges: ["e3", "i1"], chance: 0.15 },
    ]);
    expect(result.weakest?.edge).toBe("i1");
    expect(result.weakest?.importance).toBeCloseTo(0.66, 12);
    // The importance of e3 is 0.72 - 0.6 = 0.12, and its width is 0.4. The edge i1 has no doubt, so its gain is 0.
    expect(result.next?.edge).toBe("e3");
    expect(result.next?.gain).toBeCloseTo(0.048, 12);
  });
});

describe("the gate: compatibility", () => {
  it.each(SEEDS)("gives the place routing of the first releases for a graph of place edges of weight 1 (seed %i)", (seed) => {
    const r = random(seed);
    const places = ["place:a", "place:b", "place:c", "place:d"];
    for (let round = 0; round < 100; round += 1) {
      const watched = r.shuffle(places).slice(0, r.int(0, 4));
      const graph = graphOf(watched.map((node, at) => ({ id: `p${at}`, from: node, to: "person", kind: "interest", weight: point(1), origin: "places", on: true })));
      const hit = r.shuffle(places).slice(0, r.int(0, 4));
      const result = relevance(input("met.tornado", hit.map((node) => entry(node, "place"))), graph, POLICY);
      const matched = hit.some((node) => watched.includes(node));
      expect(result.reach).toEqual(matched ? { value: 1, low: 1, high: 1 } : { value: 0, low: 0, high: 0 });
      expect(result.why?.rule).toBe(matched ? "reach.place.places" : undefined);
      if (matched) expect(watched.includes(result.why!.anchor) && hit.includes(result.why!.anchor)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The other rules
// ---------------------------------------------------------------------------------------------------------------------

describe("relevance", () => {
  it("gives the ceiling and the field bound when the budget ends the sum", () => {
    // Each pair of 5 domains has an edge both ways, so the 41 paths share many edges. The path search takes 206 steps.
    const nodes = ["a", "b", "c", "d", "e"].map((name) => `domain:${name}.example`);
    const edges: InterestEdge[] = [];
    for (const from of nodes) {
      edges.push({ id: `${from}>person`, from, to: "person", kind: "interest", weight: point(0.5), origin: "services", on: true });
      for (const to of nodes) if (from !== to) edges.push({ id: `${from}>${to}`, from, to, kind: "cyber", weight: point(0.5), origin: "measured", on: true });
    }
    const event = input("infra.telecom", [entry(nodes[0]!, "entity")]);
    const bounded = relevance(event, graphOf(edges), POLICY, { maxSteps: 400 });
    expect(bounded.bound).toBe("bounds");
    expect(bounded.reach.value).toBe(bounded.noisyOr);
    expect(bounded.weakest).toBeUndefined();
    const partial = relevance(event, graphOf(edges), POLICY, { maxSteps: 100 });
    expect(partial).toMatchObject({ bound: "partial", noisyOr: 1, reach: { value: 1, high: 1 } });
    expect(relevanceSchema.parse(partial)).toEqual(partial);
    expect(relevance(event, graphOf(edges), POLICY).bound).toBeUndefined();
  });

  it("counts two entries of one node as one, with the larger hit", () => {
    const graph = graphOf(EDGES);
    const one = relevance(input("met.flood.flash", [entry("place:work", "place", point(0.5))]), graph, POLICY);
    const two = relevance(input("met.flood.flash", [entry("place:work", "place", point(0.25)), entry("place:work", "place", point(0.5))]), graph, POLICY);
    expect(two).toEqual(one);
  });

  it("refuses an entry of the person, an edge from the person and two edges with one id", () => {
    expect(() => relevance(input("x", [entry("person", "place")]), graphOf([]), POLICY)).toThrow(RangeError);
    const from: InterestEdge = { id: "a", from: "person", to: "place:a", kind: "geographic", weight: point(1), origin: "base", on: true };
    expect(() => relevance(input("x", []), graphOf([from]), POLICY)).toThrow(RangeError);
    const twice = [EDGES[0]!, { ...EDGES[1]!, id: EDGES[0]!.id }];
    expect(() => relevance(input("x", []), graphOf(twice), POLICY)).toThrow(RangeError);
  });
});

describe("muteOf", () => {
  const mutes: Mute[] = [
    { id: "m2", kinds: ["met"], date: "2026-11-15" },
    { id: "m1", kinds: ["met.tornado"], subjects: ["place:home"], date: "2026-11-15" },
  ];
  const graph = graphOf([], mutes);

  it("matches a kind by its prefix at a dot, and needs both lists when a mute has both", () => {
    expect(muteOf(input("met.tornado", [entry("place:home", "place")]), graph, POLICY)).toEqual({ mute: "m1", effect: "absent" });
    expect(muteOf(input("met.tornado", [entry("place:work", "place")]), graph, POLICY)).toEqual({ mute: "m2", effect: "absent" });
    expect(muteOf(input("metro.closure", [entry("place:home", "place")]), graph, POLICY)).toBeUndefined();
  });

  it("does not match a mute of a subject that is not an entry: that mute cuts its subject", () => {
    const bank = graphOf(EDGES, [{ id: "m3", subjects: ["domain:bank.example"], date: "2026-11-15" }]);
    expect(muteOf(input("infra.telecom", [entry("domain:dns.example", "entity")]), bank, POLICY)).toBeUndefined();
    expect(muteOf(input("infra.telecom", [entry("domain:bank.example", "entity")]), bank, POLICY)).toEqual({ mute: "m3", effect: "absent" });
  });
});

describe("topicEntry", () => {
  it("gives the node of the longest prefix with an edge, also an edge that is off", () => {
    expect(topicEntry("infra.telecom.911-outage", PERSON_GRAPH)?.node).toBe("topic:infra.telecom");
    expect(topicEntry("infra.power.outage", PERSON_GRAPH)?.node).toBe("topic:infra");
    expect(topicEntry("met.tornado", PERSON_GRAPH)).toBeUndefined();
    const off = graphOf(PERSON_GRAPH.edges.map((e) => (e.id === "t2" ? { ...e, on: false } : e)));
    expect(topicEntry("infra.telecom", off)?.node).toBe("topic:infra.telecom");
    expect(relevance(input("infra.telecom", [topicEntry("infra.telecom", off)!]), off, POLICY).reach.value).toBe(0);
  });
});
