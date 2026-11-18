// The defaults of an interest graph: a layer for each origin, joined with the rows of the person (AL-35,
// `docs/RELEVANCE.md`, the section "The defaults").

import { compareCodeUnits } from "@mark1russell7/text/order";
import type { ChannelDescriptor, EdgeOrigin, Estimate, InterestEdge, InterestGraph, NodeKey, PersonId, PlaceId } from "./contracts.ts";
import { TAXONOMY } from "./taxonomy.ts";
import { kindOfNode, placeNode } from "./why.ts";

/**
 * The rank of each origin, the strongest first. At one pair of nodes, the graph holds the edges of the strongest
 * origin. Each other edge at that pair stays as a row.
 *
 * The choice of the person comes first. A measure of the system comes before public data. A service that the person names comes before a service of a channel of the person. Both
 * come before a default of a kind of work. The watched places come before the human base.
 */
export const ORIGIN_RANK: readonly EdgeOrigin[] = ["person", "measured", "data", "services", "delivery", "work", "places", "base"];

/**
 * The weight of an edge with an unknown chance: the full interval, with the mean of a uniform chance as its value. An
 * unknown part is exposure, not nothing. A calibration from the event log can give a narrower interval later.
 */
export const UNKNOWN_WEIGHT: Estimate = { value: 0.5, low: 0, high: 1 };

const CERTAIN: Estimate = { value: 1, low: 1, high: 1 };

/** The topics of one kind of work. Each topic is a code of `TAXONOMY`. */
export interface WorkDefaults {
  readonly label: string;
  readonly topics: readonly string[];
}

/** The day of the table `WORK_DEFAULTS`. Each row of the layer `work` shows it. */
export const WORK_DEFAULTS_DATE = "2026-11-17";

/**
 * The topics of each kind of work. A topic edge reaches the person from each place on the Earth. Thus the table names
 * only the topics that touch the work wherever they occur. The places of the person cover the local events.
 */
export const WORK_DEFAULTS: Readonly<Record<string, WorkDefaults>> = {
  software: {
    label: "Software",
    topics: ["infra.cloud", "infra.saas", "infra.internet.dns-cdn", "infra.internet.bgp", "cyber.vulnerability.exploited"],
  },
  finance: {
    label: "Finance",
    topics: ["market.exchange", "market.halt.marketwide", "market.bank.failure", "market.broker.outage", "infra.payments"],
  },
};

/** One row of the graph of a person: an edge and, for a replaced default, the edge that replaced it. */
export interface InterestRow {
  readonly edge: InterestEdge;
  /** The id of the edge that replaced this edge: an edge of a stronger origin at the same pair. It is absent when the graph holds this edge. */
  readonly replacedBy?: string;
}

/** The graph of a person from the layers, and a row for each edge of the layers and of the person. */
export interface ComposedInterests {
  readonly graph: InterestGraph;
  readonly rows: readonly InterestRow[];
}

/** This function gives the id of a default edge from its origin and its pair. Thus a default has the same id at each build. */
export function defaultEdgeId(origin: EdgeOrigin, from: NodeKey, to: NodeKey): string {
  return `${origin}/${from}>${to}`;
}

function interestEdge(origin: EdgeOrigin, from: NodeKey, weight: Estimate, extra: { readonly source?: string; readonly date?: string } = {}): InterestEdge {
  return { id: defaultEdgeId(origin, from, "person"), from, to: "person", kind: "interest", weight, origin, ...extra, on: true };
}

/**
 * This function gives the layer `places`: one edge from each watched place to the person, with the weight 1. A graph
 * with only this layer gives the routing of the first releases. This is the compatibility gate of `docs/RELEVANCE.md`.
 */
export function placesLayer(places: readonly PlaceId[]): readonly InterestEdge[] {
  return [...new Set(places)].sort(compareCodeUnits).map((place) => interestEdge("places", placeNode(place), CERTAIN));
}

/**
 * This function gives the layer `work`: one edge from each topic of each kind of work to the person. The table gives
 * the topics, not the chances, so each edge has `UNKNOWN_WEIGHT`. The source of an edge names each work that gives
 * the topic. The function throws a `RangeError` for a work that the table does not have, and for a topic that is not
 * a code of `TAXONOMY`.
 */
export function workLayer(works: readonly string[], table: Readonly<Record<string, WorkDefaults>> = WORK_DEFAULTS, date: string = WORK_DEFAULTS_DATE): readonly InterestEdge[] {
  const byTopic = new Map<string, string[]>();
  for (const work of [...new Set(works)].sort(compareCodeUnits)) {
    if (!Object.hasOwn(table, work)) throw new RangeError(`The table of the kinds of work does not have the work "${work}".`);
    for (const topic of table[work]!.topics) {
      if (!Object.hasOwn(TAXONOMY, topic)) throw new RangeError(`The topic "${topic}" of the work "${work}" is not a code of the taxonomy.`);
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), work]);
    }
  }
  return [...byTopic]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([topic, from]) => interestEdge("work", `topic:${topic}`, UNKNOWN_WEIGHT, { source: `work:${from.join(",")}`, date }));
}

/**
 * This function gives the layer `services`: one edge from each service that the person names to the person. The
 * chance is unknown, so each edge has `UNKNOWN_WEIGHT`. The function throws a `RangeError` for a key that is not an
 * entity, for example a place or a topic.
 */
export function servicesLayer(services: readonly NodeKey[]): readonly InterestEdge[] {
  return [...new Set(services)].sort(compareCodeUnits).map((service) => {
    if (kindOfNode(service) !== "entity") throw new RangeError(`The service "${service}" is not the key of an entity, for example domain:example.com.`);
    return interestEdge("services", service, UNKNOWN_WEIGHT);
  });
}

/**
 * This function gives the layer `delivery`: one edge from each service of the given channels to the person. Give the
 * channels where the person has a contact (`contactChannels`). Then the alerts of the person go through each such
 * service, so each edge has the weight 1, as a watched place has. The source of an edge names its channels, for
 * example `channel:twilio-call,twilio-text`. The function throws a `RangeError` for a service that is not the key of
 * an entity.
 */
export function deliveryLayer(channels: readonly ChannelDescriptor[]): readonly InterestEdge[] {
  const byService = new Map<NodeKey, string[]>();
  for (const channel of channels) {
    for (const service of new Set(channel.services ?? [])) {
      if (kindOfNode(service) !== "entity") throw new RangeError(`The service "${service}" of the channel ${channel.id} is not the key of an entity, for example domain:example.com.`);
      byService.set(service, [...(byService.get(service) ?? []), channel.id]);
    }
  }
  return [...byService]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([service, ids]) => interestEdge("delivery", service, CERTAIN, { source: `channel:${[...new Set(ids)].sort(compareCodeUnits).join(",")}` }));
}

const rankOf = (edge: InterestEdge): number => ORIGIN_RANK.indexOf(edge.origin);

function sameEdge(a: InterestEdge, b: InterestEdge): boolean {
  return (
    a.id === b.id &&
    a.from === b.from &&
    a.to === b.to &&
    a.kind === b.kind &&
    a.origin === b.origin &&
    a.on === b.on &&
    a.source === b.source &&
    a.date === b.date &&
    a.weight.value === b.weight.value &&
    a.weight.low === b.weight.low &&
    a.weight.high === b.weight.high
  );
}

/**
 * This function joins the default layers and the graph of the person into one graph, and gives a row for each edge.
 *
 * At each pair of nodes, the graph holds the edges of the strongest origin of `ORIGIN_RANK`. Each weaker edge at
 * that pair stays as a row, with the id of the edge that replaced it. Thus a person turns a default off with an edge
 * of the origin `person` that is off, and the row of the default stays visible. Two edges of one origin at one pair
 * are two routes. The mutes and the labels come from the graph of the person.
 *
 * An edge that is in a layer and in the graph of the person counts once. Thus a second join of a joined graph gives
 * the same result. The order of the layers and of their edges has no effect.
 *
 * The function throws a `RangeError` for a layer edge of the origin `person`. It also throws a `RangeError` for two
 * different edges with one id, and for a graph of another person.
 */
export function composeInterests(person: PersonId, layers: readonly (readonly InterestEdge[])[], own?: InterestGraph): ComposedInterests {
  if (own !== undefined && own.person !== person) throw new RangeError(`The graph of the person "${own.person}" is not the graph of "${person}".`);
  const byId = new Map<string, InterestEdge>();
  const add = (edge: InterestEdge): void => {
    const known = byId.get(edge.id);
    if (known === undefined) byId.set(edge.id, edge);
    else if (!sameEdge(known, edge)) throw new RangeError(`Two different edges have the id "${edge.id}".`);
  };
  for (const layer of layers) {
    for (const edge of layer) {
      if (edge.origin === "person") throw new RangeError(`The default edge "${edge.id}" has the origin person. Only the graph of the person holds such an edge.`);
      add(edge);
    }
  }
  for (const edge of own?.edges ?? []) add(edge);

  const pairs = new Map<string, InterestEdge[]>();
  for (const edge of byId.values()) {
    const key = `${edge.from}\n${edge.to}`;
    pairs.set(key, [...(pairs.get(key) ?? []), edge]);
  }
  const used: InterestEdge[] = [];
  const rows: InterestRow[] = [];
  for (const [, edges] of [...pairs].sort(([a], [b]) => compareCodeUnits(a, b))) {
    const ordered = [...edges].sort((a, b) => rankOf(a) - rankOf(b) || compareCodeUnits(a.id, b.id));
    const winner = ordered[0]!;
    for (const edge of ordered) {
      if (rankOf(edge) === rankOf(winner)) {
        used.push(edge);
        rows.push({ edge });
      } else rows.push({ edge, replacedBy: winner.id });
    }
  }
  const graph: InterestGraph = {
    format: "alerts-interest/1",
    person,
    edges: used.sort((a, b) => compareCodeUnits(a.id, b.id)),
    mutes: own?.mutes ?? [],
    ...(own?.labels === undefined ? {} : { labels: own.labels }),
  };
  return { graph, rows };
}
