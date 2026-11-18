import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { EdgeOrigin, Estimate, InterestEdge, InterestGraph, NodeKey, PersonId, PlaceId, RelevancePolicy, SubjectEntry } from "./contracts.ts";
import {
  composeInterests,
  defaultEdgeId,
  ORIGIN_RANK,
  placesLayer,
  servicesLayer,
  UNKNOWN_WEIGHT,
  WORK_DEFAULTS,
  WORK_DEFAULTS_DATE,
  workLayer,
} from "./interest-defaults.ts";
import { canReach, relevance, topicEntry, type RelevanceInput } from "./relevance.ts";
import { interestGraphSchema } from "./schemas.ts";
import { TAXONOMY } from "./taxonomy.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
// A made-up person and made-up places.
const PERSON = "ana" as PersonId;
const POLICY: RelevancePolicy = { hopCap: 4, topPaths: 2, mandatory: "silent" };
const AT = Date.UTC(2026, 10, 20);
const point = (value: number): Estimate => ({ value, low: value, high: value });
const ownGraph = (edges: readonly InterestEdge[], extra: Partial<InterestGraph> = {}): InterestGraph => ({ format: "alerts-interest/1", person: PERSON, edges, mutes: [], ...extra });
const input = (kind: string, entries: readonly SubjectEntry[]): RelevanceInput => ({ kind, entries, at: AT, mandatory: false });
const placeEntry = (node: NodeKey): SubjectEntry => ({ node, kind: "place", hit: point(1) });
const edgeOf = (id: string, from: NodeKey, to: NodeKey, origin: EdgeOrigin, weight = point(0.5), on = true): InterestEdge => ({
  id,
  from,
  to,
  kind: to === "person" ? "interest" : "physical",
  weight,
  origin,
  on,
});

describe("the layers", () => {
  it("gives one edge of weight 1 from each watched place, once for each place", () => {
    const layer = placesLayer(["shop", "farm", "shop"] as PlaceId[]);
    expect(layer).toEqual([
      { id: "places/place:farm>person", from: "place:farm", to: "person", kind: "interest", weight: point(1), origin: "places", on: true },
      { id: "places/place:shop>person", from: "place:shop", to: "person", kind: "interest", weight: point(1), origin: "places", on: true },
    ]);
  });

  it("gives the topics of each kind of work with the unknown weight, and names each work of a topic", () => {
    const table = { a: { label: "A", topics: ["infra.cloud"] }, b: { label: "B", topics: ["infra.cloud", "infra.saas"] } };
    expect(workLayer(["b", "a", "b"], table, "2026-01-02")).toEqual([
      { id: defaultEdgeId("work", "topic:infra.cloud", "person"), from: "topic:infra.cloud", to: "person", kind: "interest", weight: UNKNOWN_WEIGHT, origin: "work", source: "work:a,b", date: "2026-01-02", on: true },
      { id: defaultEdgeId("work", "topic:infra.saas", "person"), from: "topic:infra.saas", to: "person", kind: "interest", weight: UNKNOWN_WEIGHT, origin: "work", source: "work:b", date: "2026-01-02", on: true },
    ]);
    const software = workLayer(["software"]);
    expect(software.map((edge) => edge.from)).toEqual(WORK_DEFAULTS["software"]!.topics.map((topic) => `topic:${topic}`).sort());
    expect(software.every((edge) => edge.date === WORK_DEFAULTS_DATE && edge.source === "work:software")).toBe(true);
  });

  it("names only codes of the taxonomy in the table of the kinds of work", () => {
    for (const [work, { topics }] of Object.entries(WORK_DEFAULTS)) for (const topic of topics) expect(Object.hasOwn(TAXONOMY, topic), `${work}: ${topic}`).toBe(true);
  });

  it("gives one edge with the unknown weight from each named service", () => {
    expect(servicesLayer(["domain:example.com", "asn:64500", "domain:example.com"]).map((edge) => [edge.id, edge.weight])).toEqual([
      ["services/asn:64500>person", UNKNOWN_WEIGHT],
      ["services/domain:example.com>person", UNKNOWN_WEIGHT],
    ]);
  });

  it("refuses an unknown work, a topic that is not a code and a service that is not an entity", () => {
    expect(() => workLayer(["astronomy"])).toThrow(RangeError);
    expect(() => workLayer(["a"], { a: { label: "A", topics: ["not.a.code"] } })).toThrow(RangeError);
    expect(() => servicesLayer(["place:farm"])).toThrow(RangeError);
    expect(() => servicesLayer(["topic:infra.cloud"])).toThrow(RangeError);
  });
});

describe("the gate: compatibility", () => {
  it.each(SEEDS)("gives the place routing of the first releases for a graph of the layer places alone (seed %i)", (seed) => {
    const r = random(seed);
    const places = ["a", "b", "c", "d"] as PlaceId[];
    for (let round = 0; round < 50; round += 1) {
      const watched = r.shuffle(places).slice(0, r.int(0, 4));
      const { graph } = composeInterests(PERSON, [placesLayer(watched)]);
      const hit = r.shuffle(places).slice(0, r.int(0, 4));
      const result = relevance(input("met.tornado", hit.map((place) => placeEntry(`place:${place}`))), graph, POLICY);
      const matched = hit.some((place) => watched.includes(place));
      expect(result.reach).toEqual(matched ? point(1) : point(0));
      expect(result.why?.rule).toBe(matched ? "reach.place.places" : undefined);
    }
  });
});

describe("the gate: the person wins", () => {
  it("turns a default off with an edge of the person that is off, and keeps the default as a row", () => {
    const mine = edgeOf("mine", "topic:infra.cloud", "person", "person", point(1), false);
    const { graph, rows } = composeInterests(PERSON, [workLayer(["software"])], ownGraph([mine]));
    const work = defaultEdgeId("work", "topic:infra.cloud", "person");
    expect(graph.edges.map((edge) => edge.id)).toContain("mine");
    expect(graph.edges.map((edge) => edge.id)).not.toContain(work);
    expect(rows).toContainEqual({ edge: expect.objectContaining({ id: work }), replacedBy: "mine" });
    const cloud = input("infra.cloud.outage", [topicEntry("infra.cloud.outage", graph)!]);
    expect(canReach(cloud, graph, POLICY)).toBe(false);
    const saas = input("infra.saas.outage", [topicEntry("infra.saas.outage", graph)!]);
    expect(canReach(saas, graph, POLICY)).toBe(true);
  });
});

describe("the gate: rank", () => {
  it("keeps the edge of the stronger origin of each two origins at one pair", () => {
    for (const [at, strong] of ORIGIN_RANK.entries()) {
      for (const weak of ORIGIN_RANK.slice(at + 1)) {
        const strongEdge = edgeOf(`s-${strong}`, "domain:example.com", "person", strong);
        const weakEdge = edgeOf(`w-${weak}`, "domain:example.com", "person", weak);
        const result = strong === "person" ? composeInterests(PERSON, [[weakEdge]], ownGraph([strongEdge])) : composeInterests(PERSON, [[weakEdge], [strongEdge]]);
        expect(result.graph.edges, `${strong} over ${weak}`).toEqual([strongEdge]);
        expect(result.rows).toEqual([{ edge: strongEdge }, { edge: weakEdge, replacedBy: strongEdge.id }]);
      }
    }
  });

  it("keeps each edge of the strongest origin at one pair as a route", () => {
    const one = edgeOf("d1", "wikidata:Q1", "place:farm", "data");
    const two = edgeOf("d2", "wikidata:Q1", "place:farm", "data");
    expect(composeInterests(PERSON, [[two, one]]).graph.edges).toEqual([one, two]);
  });
});

// A set of layers with each origin, and edges of different origins at the same pairs.
function layersOf(): { readonly layers: readonly (readonly InterestEdge[])[]; readonly own: InterestGraph } {
  const data = [edgeOf("d-utility", "wikidata:Q1", "place:farm", "data", point(0.3)), edgeOf("d-isp", "asn:64500", "domain:example.com", "data", point(0.2))];
  const measured = [edgeOf("m-isp", "asn:64500", "domain:example.com", "measured", point(0.6))];
  const base = [edgeOf("b-farm", "place:farm", "person", "base", point(1))];
  const own = ownGraph([edgeOf("mine", "topic:infra.saas", "person", "person", point(0.9))], {
    mutes: [{ id: "quiet", kinds: ["market"], date: "2026-11-17" }],
    labels: { "place:farm": "Farm" },
  });
  return { layers: [placesLayer(["farm", "shop"] as PlaceId[]), workLayer(["software", "finance"]), servicesLayer(["domain:example.com"]), data, measured, base], own };
}

describe("the gate: order-free", () => {
  it.each(SEEDS)("gives one result for each order of the layers and of their edges (seed %i)", (seed) => {
    const r = random(seed);
    const { layers, own } = layersOf();
    const reference = composeInterests(PERSON, layers, own);
    for (let round = 0; round < 20; round += 1) {
      const shuffled = r.shuffle(layers.map((layer) => r.shuffle(layer)));
      const ownShuffled = { ...own, edges: r.shuffle(own.edges) };
      expect(composeInterests(PERSON, shuffled, ownShuffled)).toEqual(reference);
    }
  });
});

describe("the gate: idempotent", () => {
  it("gives the same result for a second join of a joined graph", () => {
    const { layers, own } = layersOf();
    const first = composeInterests(PERSON, layers, own);
    expect(composeInterests(PERSON, layers, first.graph)).toEqual(first);
  });
});

describe("the gate: each default stays a row", () => {
  it("gives a row for each edge, and the graph holds each row that nothing replaced", () => {
    const { layers, own } = layersOf();
    const { graph, rows } = composeInterests(PERSON, layers, own);
    const ids = new Set([...layers.flat(), ...own.edges].map((edge) => edge.id));
    expect(rows.map((row) => row.edge.id).sort()).toEqual([...ids].sort());
    expect(graph.edges).toEqual(rows.filter((row) => row.replacedBy === undefined).map((row) => row.edge).sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(rows.filter((row) => row.replacedBy !== undefined).map((row) => [row.edge.id, row.replacedBy])).toEqual([
      ["d-isp", "m-isp"],
      ["b-farm", "places/place:farm>person"],
      ["work/topic:infra.saas>person", "mine"],
    ]);
    expect(graph.mutes).toEqual(own.mutes);
    expect(graph.labels).toEqual(own.labels);
    expect(interestGraphSchema.parse(graph)).toEqual(graph);
  });
});

describe("the refusals", () => {
  it("refuses a layer edge of the person, two different edges with one id and a graph of another person", () => {
    expect(() => composeInterests(PERSON, [[edgeOf("x", "domain:example.com", "person", "person")]])).toThrow(RangeError);
    const layer = placesLayer(["farm"] as PlaceId[]);
    const changed = { ...layer[0]!, weight: point(0.5) };
    expect(() => composeInterests(PERSON, [layer], ownGraph([changed]))).toThrow(RangeError);
    expect(() => composeInterests(PERSON, [layer], { ...ownGraph([]), person: "ben" as PersonId })).toThrow(RangeError);
  });
});
