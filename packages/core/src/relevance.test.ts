import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  SUBJECT_SYSTEMS,
  type EdgeKind,
  type EdgeOrigin,
  type InterestEdge,
  type InterestGraph,
  type Mute,
  type MuteEffect,
  type NodeKey,
  type PersonId,
  type Relevance,
  type RelevancePath,
  type RelevancePolicy,
  type SubjectEntry,
  type SubjectKind,
  type WhyRecord,
} from "./contracts.ts";
import {
  edgeKindSchema,
  edgeOriginSchema,
  interestEdgeSchema,
  interestGraphSchema,
  muteEffectSchema,
  muteSchema,
  nodeKeySchema,
  relevancePathSchema,
  relevancePolicySchema,
  relevanceSchema,
  subjectEntrySchema,
  subjectKindSchema,
  whyRecordSchema,
} from "./schemas.ts";

function fails(schema: z.ZodType, value: unknown): void {
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
}

function holds(schema: z.ZodType, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
}

const point = (value: number, doubt = 0) => ({ value, low: Math.max(0, value - doubt), high: Math.min(1, value + doubt) });

// A made-up person with a home, a work place, a power utility and two web services. The example of `docs/RELEVANCE.md`.
const EDGES: readonly InterestEdge[] = [
  { id: "e3", from: "wikidata:Q123", to: "place:home", kind: "physical", weight: point(0.5, 0.2), origin: "data", source: "eia-861/2025", date: "2026-11-15", on: true },
  { id: "e7", from: "domain:dns.example", to: "domain:bank.example", kind: "cyber", weight: point(0.9, 0.1), origin: "measured", date: "2026-11-15", on: true },
  { id: "e8", from: "domain:dns.example", to: "domain:web.example", kind: "cyber", weight: point(0.4, 0.1), origin: "measured", date: "2026-11-15", on: true },
  { id: "i1", from: "place:home", to: "person", kind: "interest", weight: point(1), origin: "base", on: true },
  { id: "i2", from: "place:work", to: "person", kind: "interest", weight: point(0.6, 0.1), origin: "places", on: true },
  { id: "i3", from: "iso3166:US-KS", to: "person", kind: "interest", weight: point(0.15, 0.1), origin: "places", on: false },
  { id: "i4", from: "domain:bank.example", to: "person", kind: "interest", weight: point(0.7), origin: "person", date: "2026-11-15", on: true },
  { id: "i5", from: "domain:web.example", to: "person", kind: "interest", weight: point(0.4, 0.2), origin: "work", on: true },
];

const GRAPH: InterestGraph = {
  format: "alerts-interest/1",
  person: "person:example" as PersonId,
  edges: EDGES,
  mutes: [{ id: "m1", kinds: ["met.tornado"], until: Date.UTC(2026, 11, 1), date: "2026-11-15" }],
  labels: { "place:home": "Home", "wikidata:Q123": "Power utility" },
};

// The tornado warning near the home: it hits the home with a chance of 0.6 and the lines of the utility with 0.3.
// The reach is 1 - 0.4 * (1 - 0.3 * 0.5) = 0.66. The ends of the weight of e3 (0.3 and 0.7) give 0.636 and 0.684.
// The importance of e3 is 0.72 - 0.6 = 0.12, and its gain is 0.12 times the width 0.4.
const RELEVANCE: Relevance = {
  reach: { value: 0.66, low: 0.636, high: 0.684 },
  best: 0.6,
  noisyOr: 0.66,
  paths: [
    { subject: "place:home", edges: ["i1"], chance: 0.6 },
    { subject: "wikidata:Q123", edges: ["e3", "i1"], chance: 0.15 },
  ],
  why: { rule: "reach.place.base", subject: "place:home", kind: "place", anchor: "place:home", origin: "base", coverage: 1 },
  weakest: { edge: "i1", importance: 0.66 },
  next: { edge: "e3", gain: 0.048 },
};

describe("the type of each relevance schema", () => {
  it("is exactly its contract", () => {
    expectTypeOf<z.output<typeof subjectKindSchema>>().toEqualTypeOf<SubjectKind>();
    expectTypeOf<z.output<typeof nodeKeySchema>>().toEqualTypeOf<NodeKey>();
    expectTypeOf<z.output<typeof edgeKindSchema>>().toEqualTypeOf<EdgeKind>();
    expectTypeOf<z.output<typeof edgeOriginSchema>>().toEqualTypeOf<EdgeOrigin>();
    expectTypeOf<z.output<typeof interestEdgeSchema>>().toEqualTypeOf<InterestEdge>();
    expectTypeOf<z.output<typeof muteSchema>>().toEqualTypeOf<Mute>();
    expectTypeOf<z.output<typeof interestGraphSchema>>().toEqualTypeOf<InterestGraph>();
    expectTypeOf<z.output<typeof subjectEntrySchema>>().toEqualTypeOf<SubjectEntry>();
    expectTypeOf<z.output<typeof relevancePathSchema>>().toEqualTypeOf<RelevancePath>();
    expectTypeOf<z.output<typeof whyRecordSchema>>().toEqualTypeOf<WhyRecord>();
    expectTypeOf<z.output<typeof muteEffectSchema>>().toEqualTypeOf<MuteEffect>();
    expectTypeOf<z.output<typeof relevancePolicySchema>>().toEqualTypeOf<RelevancePolicy>();
    expectTypeOf<z.output<typeof relevanceSchema>>().toEqualTypeOf<Relevance>();
    expectTypeOf<z.input<typeof interestGraphSchema>>().toEqualTypeOf<InterestGraph>();
  });
});

describe("the round trip of the example", () => {
  it("accepts the graph, its entries and its relevance", () => {
    holds(interestGraphSchema, GRAPH);
    const { labels: _labels, ...bare } = GRAPH;
    holds(interestGraphSchema, { ...bare, mutes: [] });
    fails(interestGraphSchema, { ...GRAPH, labels: undefined });
    holds(subjectEntrySchema, { node: "place:home", kind: "place", hit: point(0.6, 0.05) });
    holds(subjectEntrySchema, { node: "topic:met.tornado", kind: "topic", hit: point(1) });
    holds(relevanceSchema, RELEVANCE);
    holds(relevancePolicySchema, { hopCap: 4, topPaths: 3, mandatory: "silent" });
  });

  it("accepts a relevance with no path, and a muted one", () => {
    const none: Relevance = { reach: point(0), best: 0, noisyOr: 0, paths: [] };
    holds(relevanceSchema, none);
    holds(relevanceSchema, { ...none, muted: { mute: "m1", effect: "absent" } });
    holds(relevanceSchema, { ...RELEVANCE, muted: { mute: "m1", effect: "silent" } });
  });
});

describe("the rules of the relevance values", () => {
  it("a node key is person, or a known system and an id that is not empty", () => {
    for (const key of ["person", "place:home", "ugc:KSC173", "same:020173", "topic:infra.power.outage", "purl:pkg:npm/example", "cap-category:Met"]) {
      holds(nodeKeySchema, key);
    }
    for (const key of ["", "home", "place:", ":home", "zone:KSZ083", "Place:home", "person:", "place:home\nugc:KSC173"]) fails(nodeKeySchema, key);
    for (const system of Object.keys(SUBJECT_SYSTEMS)) holds(nodeKeySchema, `${system}:x`);
  });

  it("each kind of subject has a system", () => {
    expect(new Set(Object.values(SUBJECT_SYSTEMS))).toEqual(new Set(["place", "topic", "entity"]));
    expect(SUBJECT_SYSTEMS.place).toBe("place");
    expect(SUBJECT_SYSTEMS.topic).toBe("topic");
  });

  it("an edge does not start at the person, joins two nodes, and goes into the person only as an interest", () => {
    const edge = EDGES[0]!;
    holds(interestEdgeSchema, edge);
    fails(interestEdgeSchema, { ...edge, from: "person", to: "place:home" });
    fails(interestEdgeSchema, { ...edge, to: edge.from });
    fails(interestEdgeSchema, { ...edge, to: "person" });
    fails(interestEdgeSchema, { ...edge, kind: "interest" });
    fails(interestEdgeSchema, { ...edge, kind: "social" });
    fails(interestEdgeSchema, { ...edge, origin: "guess" });
  });

  it("a weight is a probability with an interval that holds it", () => {
    const edge = EDGES[0]!;
    fails(interestEdgeSchema, { ...edge, weight: { value: 1.2, low: 1, high: 1.2 } });
    fails(interestEdgeSchema, { ...edge, weight: { value: 0.5, low: 0.6, high: 0.7 } });
    fails(interestEdgeSchema, { ...edge, weight: 0.5 });
    holds(interestEdgeSchema, { ...edge, weight: { value: 0.5, low: 0, high: 1 } });
  });

  it("a day is YYYY-MM-DD, and a source is not empty", () => {
    const edge = EDGES[0]!;
    fails(interestEdgeSchema, { ...edge, date: "2026-11-15T00:00:00Z" });
    fails(interestEdgeSchema, { ...edge, date: "15.11.2026" });
    fails(interestEdgeSchema, { ...edge, source: "" });
    fails(muteSchema, { id: "m1", kinds: ["met"], date: "today" });
  });

  it("a mute has a list of kinds, a list of subjects or both, and no list is empty", () => {
    holds(muteSchema, { id: "m1", kinds: ["met.tornado"], date: "2026-11-15" });
    holds(muteSchema, { id: "m2", subjects: ["domain:web.example"], date: "2026-11-15" });
    holds(muteSchema, { id: "m3", kinds: ["cyber"], subjects: ["domain:web.example"], until: 0, date: "2026-11-15" });
    fails(muteSchema, { id: "m4", date: "2026-11-15" });
    fails(muteSchema, { id: "m5", kinds: [], date: "2026-11-15" });
    fails(muteSchema, { id: "m6", subjects: [], date: "2026-11-15" });
    fails(muteSchema, { id: "m7", subjects: ["home"], date: "2026-11-15" });
    fails(muteSchema, { id: "", kinds: ["met"], date: "2026-11-15" });
  });

  it("the ids of the edges and of the mutes of a graph are unique, and the labels have node keys", () => {
    fails(interestGraphSchema, { ...GRAPH, edges: [...EDGES, EDGES[0]] });
    const mute = GRAPH.mutes[0]!;
    fails(interestGraphSchema, { ...GRAPH, mutes: [mute, { ...mute, kinds: ["cyber"] }] });
    fails(interestGraphSchema, { ...GRAPH, labels: { home: "Home" } });
    fails(interestGraphSchema, { ...GRAPH, format: "alerts-interest/2" });
    fails(interestGraphSchema, { ...GRAPH, extra: true });
  });

  it("a relevance has a why when it has a path, and only then", () => {
    const { why: _why, ...noWhy } = RELEVANCE;
    fails(relevanceSchema, noWhy);
    fails(relevanceSchema, { reach: point(0), best: 0, noisyOr: 0, paths: [], why: RELEVANCE.why });
    fails(relevanceSchema, { ...RELEVANCE, paths: [{ subject: "place:home", edges: [], chance: 0.6 }] });
  });

  it("a mute with the effect absent gives a reach of 0 and no path", () => {
    fails(relevanceSchema, { ...RELEVANCE, muted: { mute: "m1", effect: "absent" } });
    fails(relevanceSchema, { reach: point(0.2), best: 0, noisyOr: 0, paths: [], muted: { mute: "m1", effect: "absent" } });
  });

  it("the policy has whole counts of 1 or more", () => {
    for (const bad of [{ hopCap: 0 }, { hopCap: 2.5 }, { topPaths: 0 }, { mandatory: "loud" }]) {
      fails(relevancePolicySchema, { hopCap: 4, topPaths: 3, mandatory: "silent", ...bad });
    }
  });
});
