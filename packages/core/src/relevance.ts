// The relevance of an incident for one person: a calculation over the interest graph (AL-35, `docs/RELEVANCE.md`).

import {
  NUMBER_RING,
  pathSetReliability,
  twoTerminalReliability,
  type OrderedRing,
  type TwoTerminalReliability,
} from "@mark1russell7/collections/graph";
import { hasKind } from "./assess.ts";
import type {
  Estimate,
  Instant,
  InterestEdge,
  InterestGraph,
  Mute,
  MuteEffect,
  NodeKey,
  Relevance,
  RelevancePath,
  RelevancePolicy,
  SubjectEntry,
  WhyRecord,
} from "./contracts.ts";

/** The incident, as the relevance reads it. */
export interface RelevanceInput {
  /** The taxonomy code of the kind of the incident. A mute matches it by prefix. */
  readonly kind: string;
  /** The subjects of the incident that are nodes of the graph. Two entries of one node count as one, with the larger hit. */
  readonly entries: readonly SubjectEntry[];
  /** The time of the calculation. A mute with an end at this time or before it has no effect. */
  readonly at: Instant;
  /** True when the incident is of the mandatory class. Then a mute has the effect `policy.mandatory`. */
  readonly mandatory: boolean;
}

/** The options of the relevance. */
export interface RelevanceOptions {
  /** The largest count of steps of each exact sum, as in `twoTerminalReliability`. The default is 1000000. */
  readonly maxSteps?: number;
}

/** The arithmetic of the exact sum: a ring, and the function that puts a chance into the ring. */
export interface ReachArithmetic<N> {
  readonly ring: OrderedRing<N>;
  readonly of: (chance: number) => N;
}

/** The arithmetic of production: floats. */
export const FLOAT_REACH: ReachArithmetic<number> = { ring: NUMBER_RING, of: (chance) => chance };

/** One end of the intervals of the weights and of the hits. */
export type ReachEnd = "low" | "value" | "high";

// The virtual source node of the event. The empty text is not a node key, so it is not a node of a graph.
const EVENT = "";
const PERSON: NodeKey = "person";

// One edge of the reliability problem: a hit edge from the event to an entry, or an edge of the graph that is on.
interface Part {
  readonly from: NodeKey;
  readonly to: NodeKey;
  readonly weight: Estimate;
  readonly entry?: SubjectEntry;
  readonly edge?: InterestEdge;
}

// Code-point order. It does not depend on the locale.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The mutes that have effect at the time of the input, and whose kinds match its kind or that have no kinds.
function activeMutes(input: RelevanceInput, graph: InterestGraph): readonly Mute[] {
  return graph.mutes
    .filter((mute) => mute.until === undefined || mute.until > input.at)
    .filter((mute) => mute.kinds === undefined || hasKind(mute.kinds, input.kind));
}

// The nodes that the active mutes cut from the graph: their subjects. An incident of the mandatory class under the policy
// `silent` has no cut, because a mute changes only its sound.
function cutOf(input: RelevanceInput, graph: InterestGraph, policy: RelevancePolicy): ReadonlySet<NodeKey> {
  if (input.mandatory && policy.mandatory === "silent") return new Set();
  return new Set(activeMutes(input, graph).flatMap((mute) => mute.subjects ?? []));
}

// The hit edges in the order of their nodes, then the edges of the graph that are on, in the order of their ids. Each
// edge into or out of a node of the cut is off. Thus the order of the entries, of the edges and of a file has no effect
// on the result.
function partsOf(input: RelevanceInput, graph: InterestGraph, policy: RelevancePolicy): readonly Part[] {
  const cut = cutOf(input, graph, policy);
  const entries = new Map<NodeKey, SubjectEntry>();
  for (const entry of input.entries) {
    if (entry.node === PERSON) throw new RangeError("An entry of an incident is a subject, not the person.");
    const known = entries.get(entry.node);
    entries.set(entry.node, known === undefined ? entry : larger(known, entry));
  }
  const ids = new Set<string>();
  const edges: InterestEdge[] = [];
  for (const edge of graph.edges) {
    if (ids.has(edge.id)) throw new RangeError(`The id ${edge.id} is on two edges of the graph.`);
    ids.add(edge.id);
    if (edge.from === PERSON) throw new RangeError(`The edge ${edge.id} starts at the person.`);
    if (edge.on && !cut.has(edge.from) && !cut.has(edge.to)) edges.push(edge);
  }
  edges.sort((a, b) => byText(a.id, b.id));
  const hits = [...entries.values()].filter((entry) => !cut.has(entry.node)).sort((a, b) => byText(a.node, b.node));
  return [
    ...hits.map((entry): Part => ({ from: EVENT, to: entry.node, weight: entry.hit, entry })),
    ...edges.map((edge): Part => ({ from: edge.from, to: edge.to, weight: edge.weight, edge })),
  ];
}

// Of two entries of one node, the entry with the larger hit at each end. The kind comes from the first in the order of
// the kinds, so the result does not depend on the order of the entries.
function larger(a: SubjectEntry, b: SubjectEntry): SubjectEntry {
  const hit = { value: Math.max(a.hit.value, b.hit.value), low: Math.max(a.hit.low, b.hit.low), high: Math.max(a.hit.high, b.hit.high) };
  return { node: a.node, kind: byText(a.kind, b.kind) <= 0 ? a.kind : b.kind, hit };
}

function solve<N>(parts: readonly Part[], end: ReachEnd, arithmetic: ReachArithmetic<N>, policy: RelevancePolicy, maxSteps: number | undefined): TwoTerminalReliability<N> {
  const edges = parts.map((part) => ({ from: part.from, to: part.to, chance: arithmetic.of(part.weight[end]) }));
  // The hit edge is not an edge of the graph, so the cap of the sum is one edge more than the cap of the policy.
  return twoTerminalReliability(edges, EVENT, PERSON, arithmetic.ring, { hopCap: policy.hopCap + 1, maxSteps });
}

/**
 * This function gives the reach of an incident at one end of the intervals, in the arithmetic of `arithmetic`. It
 * applies the cut of the mutes, and not the match of `muteOf`. The result is the result of `twoTerminalReliability`
 * over the hit edges and the edges that are on. No edge goes into or out of a muted subject. The gates use it with
 * exact rationals.
 */
export function reachOf<N>(
  input: RelevanceInput,
  graph: InterestGraph,
  policy: RelevancePolicy,
  arithmetic: ReachArithmetic<N>,
  end: ReachEnd = "value",
  options: RelevanceOptions = {},
): TwoTerminalReliability<N> {
  return solve(partsOf(input, graph, policy), end, arithmetic, policy, options.maxSteps);
}

/**
 * This function gives the mute of the graph that matches the incident, and its effect, or `undefined`. A mute has
 * effect when it has no end or its end is after `input.at`. A mute with subjects matches when one of its subjects is
 * an entry. Of two matched mutes, the mute with the first id wins. A mute with subjects that does not match cuts its
 * subjects from the graph (`reachOf`).
 */
export function muteOf(input: RelevanceInput, graph: InterestGraph, policy: RelevancePolicy): { readonly mute: string; readonly effect: MuteEffect } | undefined {
  const nodes = new Set(input.entries.map((entry) => entry.node));
  const matched = activeMutes(input, graph)
    .filter((mute) => mute.subjects === undefined || mute.subjects.some((node) => nodes.has(node)))
    .sort((a, b) => byText(a.id, b.id));
  const first = matched[0];
  if (first === undefined) return undefined;
  return { mute: first.id, effect: input.mandatory ? policy.mandatory : "absent" };
}

/**
 * This function gives the entry of the topic of a kind, or `undefined`. The node is `topic:<prefix>` for the longest
 * prefix of the kind that starts an edge of the graph. An edge that is off counts too, so it turns off its level only.
 */
export function topicEntry(kind: string, graph: InterestGraph): SubjectEntry | undefined {
  let found: string | undefined;
  for (const edge of graph.edges) {
    if (!edge.from.startsWith("topic:")) continue;
    const prefix = edge.from.slice("topic:".length);
    if (hasKind([prefix], kind) && (found === undefined || prefix.length > found.length)) found = prefix;
  }
  return found === undefined ? undefined : { node: `topic:${found}`, kind: "topic", hit: { value: 1, low: 1, high: 1 } };
}

const NONE: Estimate = { value: 0, low: 0, high: 0 };

// The low and the high reach of one result. A result of the budget gives its bounds: the best path is a floor. Noisy-OR
// is a ceiling of the result `bounds`, and the result `partial` has no ceiling but 1.
function lowOf(result: TwoTerminalReliability<number>): number {
  return result.kind === "exact" ? result.value : result.best;
}

function highOf(result: TwoTerminalReliability<number>): number {
  return result.kind === "exact" ? result.value : result.kind === "bounds" ? result.noisyOr : 1;
}

/**
 * This function gives the relevance of an incident for one person.
 *
 * - A mute with the effect `absent` gives a reach of 0 and no path.
 * - A mute with subjects cuts each subject from the graph: each edge into or out of a muted subject is off. Thus no
 *   path goes through a muted subject. An incident of the mandatory class under the policy `silent` has no cut.
 * - The reach is the exact two-terminal reliability from the event to the person, over paths of `policy.hopCap` edges
 *   of the graph or fewer. The interval comes from the low and the high ends of the weights and the hits.
 * - When the budget of steps ends a sum, the field `bound` tells it. The reach is then the ceiling, so an alert is not lost.
 * - The why comes from the strongest path. Its coverage is the reach of the shown paths alone, divided by the reach.
 */
export function relevance(input: RelevanceInput, graph: InterestGraph, policy: RelevancePolicy, options: RelevanceOptions = {}): Relevance {
  const muted = muteOf(input, graph, policy);
  if (muted?.effect === "absent") return { reach: NONE, best: 0, noisyOr: 0, paths: [], muted };
  const parts = partsOf(input, graph, policy);
  const point = solve(parts, "value", FLOAT_REACH, policy, options.maxSteps);
  // A float sum can pass 1 by a unit in the last place, so each end stays in the unit interval.
  const low = Math.min(1, lowOf(solve(parts, "low", FLOAT_REACH, policy, options.maxSteps)));
  const high = Math.min(1, highOf(solve(parts, "high", FLOAT_REACH, policy, options.maxSteps)));
  const value = Math.min(Math.max(highOf(point), low), high);
  const shown = point.paths.filter((path) => path.chance > 0).slice(0, policy.topPaths);
  const paths = shown.map((path): RelevancePath => {
    const [hit, ...rest] = path.edges;
    return { subject: parts[hit!]!.to, edges: rest.map((index) => parts[index]!.edge!.id), chance: path.chance };
  });
  const base: Relevance = {
    reach: { value, low: Math.min(low, value), high },
    best: point.best,
    noisyOr: point.kind === "partial" ? 1 : point.noisyOr,
    paths,
    ...(point.kind === "exact" ? {} : { bound: point.kind }),
    ...(muted === undefined ? {} : { muted }),
  };
  const top = shown[0];
  if (top === undefined) return base;
  const chances = parts.map((part) => part.weight.value);
  const alone = pathSetReliability(
    shown.map((path) => path.edges),
    chances,
    NUMBER_RING,
    options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps },
  );
  // Within the budget, the coverage is exact. Out of it, the strongest path alone is a floor of the coverage.
  const covered = alone.kind === "exact" ? alone.value : top.chance;
  const why = whyOf(parts, top.edges, value === 0 ? 0 : Math.min(1, covered / value));
  return { ...base, why, ...(point.kind === "exact" ? weakOf(parts, point.importance) : {}) };
}

// The why of one path: its subject, the first node after the subject when two nodes or more are between the subject
// and the person, the last node before the person, and the origin of the interest edge.
function whyOf(parts: readonly Part[], indices: readonly number[], coverage: number): WhyRecord {
  const [hit, ...rest] = indices;
  const entry = parts[hit!]!.entry!;
  const edges = rest.map((index) => parts[index]!.edge!);
  const last = edges[edges.length - 1]!;
  return {
    rule: `reach.${entry.kind}.${last.origin}`,
    subject: entry.node,
    kind: entry.kind,
    ...(edges.length >= 3 ? { via: edges[0]!.to } : {}),
    anchor: last.from,
    origin: last.origin,
    coverage,
  };
}

// The weakest edge and the next question. Each is the first edge in the order of the ids with the largest value, and
// it is absent when the largest value is 0.
function weakOf(parts: readonly Part[], importance: readonly number[]): Pick<Relevance, "weakest" | "next"> {
  let weakest: { readonly edge: string; readonly importance: number } | undefined;
  let next: { readonly edge: string; readonly gain: number } | undefined;
  for (const [index, part] of parts.entries()) {
    const edge = part.edge;
    if (edge === undefined) continue;
    const value = Math.min(1, importance[index]!);
    if (value > 0 && (weakest === undefined || value > weakest.importance)) weakest = { edge: edge.id, importance: value };
    const gain = value * (edge.weight.high - edge.weight.low);
    if (edge.origin !== "person" && gain > 0 && (next === undefined || gain > next.gain)) next = { edge: edge.id, gain };
  }
  return { ...(weakest === undefined ? {} : { weakest }), ...(next === undefined ? {} : { next }) };
}
