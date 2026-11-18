/**
 * The panel of the interests of the local page. It tells the interest graph of each person: each edge, its origin and
 * its weight. An edge of the person replaces a default edge at the same pair, and the panel keeps the default as a row.
 *
 * The data function is pure. The draw function makes the elements of the panel from that data.
 */

import { kindLabel, type EdgeOrigin, type Estimate, type InterestsPerson, type Mute, type NodeKey } from "@mark1russell7/alerts";
import { h } from "@mark1russell7/site-pages/chrome";
import { countOf } from "@mark1russell7/text/english";
import { toneChip } from "./draw.ts";
import type { Tone } from "./health-look.ts";
import type { Verdict } from "./health-view.ts";
import type { InterestsRead } from "./interests-read.ts";

/** The state of one row: the graph uses it, the person turned it off, or an edge of a stronger origin replaced it. */
export type InterestState = "used" | "off" | "replaced";

/** One row of the graph of a person. */
export interface InterestLine {
  /** The two nodes of the edge, with their labels. */
  readonly text: string;
  /** The words of the origin of the edge. */
  readonly origin: string;
  readonly weight: string;
  readonly state: InterestState;
  /** The words of the state. A replaced row names the origin of the edge that replaced it. */
  readonly word: string;
}

/** The data of one person: the chip, a sentence of the counts, the notes and the rows. */
export interface InterestPerson {
  readonly name: string;
  readonly tone: Tone;
  readonly word: string;
  readonly text: string;
  /** The problem of the interests, then one sentence for each mute. */
  readonly notes: readonly string[];
  /** The rows in use first, then the rows that are off, then the replaced rows. */
  readonly lines: readonly InterestLine[];
}

/** The data of the panel: one sentence for all the people, and one entry for each person. */
export interface InterestPanel {
  readonly verdict: Verdict;
  readonly people: readonly InterestPerson[];
}

/** The sentence of a runtime with no interests route. */
export const NO_ROUTE_TEXT = "This runtime gives no interests. The runtime of the version of this page gives them.";

/** The sentence of a person with no interest graph. */
export const PLACES_TEXT = "The watched places decide. The person has no interest graph.";

/** The words of each origin of an edge. */
export const ORIGIN_WORDS: Readonly<Record<EdgeOrigin, string>> = {
  person: "Own choice",
  measured: "Measured",
  data: "Public data",
  services: "Named service",
  delivery: "Path of the alerts",
  work: "Kind of work",
  places: "Watched place",
  base: "Base of each person",
};

const STATE_RANK: Readonly<Record<InterestState, number>> = { used: 0, off: 1, replaced: 2 };

const number = (value: number): string => String(Math.round(value * 100) / 100);

/** This function gives the words of a weight. The full interval is an unknown weight, not a weight of zero. */
export function weightText(weight: Estimate): string {
  if (weight.low === weight.high) return `Weight ${number(weight.value)}`;
  if (weight.low === 0 && weight.high === 1) return "Weight unknown, 0 to 1";
  return `Weight ${number(weight.value)}, ${number(weight.low)} to ${number(weight.high)}`;
}

// The prefix of the source of each origin whose words name the items of the source.
const SOURCE_PREFIX: Partial<Readonly<Record<EdgeOrigin, string>>> = { work: "work:", delivery: "channel:" };

/**
 * This function gives the words of the origin of an edge. An edge of a kind of work also names each work, and an edge
 * of the path of the alerts names each channel.
 */
export function originText(origin: EdgeOrigin, source: string | undefined): string {
  const prefix = SOURCE_PREFIX[origin];
  const items = prefix !== undefined && source?.startsWith(prefix) === true ? source.slice(prefix.length).split(",").join(", ") : "";
  return items === "" ? ORIGIN_WORDS[origin] : `${ORIGIN_WORDS[origin]}: ${items}`;
}

function muteText(mute: Mute, labelOf: (node: NodeKey) => string): string {
  const subjects = mute.subjects === undefined || mute.subjects.length === 0 ? "each subject" : mute.subjects.map(labelOf).join(", ");
  const kinds = mute.kinds === undefined || mute.kinds.length === 0 ? "" : ` for ${mute.kinds.map(kindLabel).join(", ")}`;
  return `Mute: ${subjects}${kinds}.`;
}

/** This function gives the data of one person from the payload. A node with no label shows its key. */
export function interestPerson(view: InterestsPerson): InterestPerson {
  const name = view.label ?? view.person;
  const labelOf = (node: NodeKey): string => (node === "person" ? name : (view.labels[node] ?? node));
  const originOf = new Map(view.rows.map(({ edge }) => [edge.id, edge.origin]));
  const lines = view.rows
    .map(({ edge, replacedBy }): InterestLine => {
      const state: InterestState = replacedBy !== undefined ? "replaced" : edge.on ? "used" : "off";
      const by = replacedBy === undefined ? undefined : originOf.get(replacedBy);
      const word = state === "used" ? "In use" : state === "off" ? "Off" : `Replaced by ${by === undefined ? "another edge" : ORIGIN_WORDS[by].toLowerCase()}`;
      return { text: `${labelOf(edge.from)} → ${labelOf(edge.to)}`, origin: originText(edge.origin, edge.source), weight: weightText(edge.weight), state, word };
    })
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
  const notes = [...(view.problem === undefined ? [] : [view.problem]), ...view.mutes.map((mute) => muteText(mute, labelOf))];
  const count = (state: InterestState): number => lines.filter((line) => line.state === state).length;
  const parts = [`${countOf(count("used"), "edge")} in use`, ...(count("off") > 0 ? [`${String(count("off"))} off`] : []), ...(count("replaced") > 0 ? [`${countOf(count("replaced"), "default")} replaced`] : [])];
  const text = view.routing === "places" ? PLACES_TEXT : `${parts.join(", ")}.`;
  if (view.problem !== undefined) return { name, tone: "warn", word: "Problem", text, notes, lines };
  return view.routing === "graph" ? { name, tone: "good", word: "Graph", text, notes, lines } : { name, tone: "quiet", word: "Places", text, notes, lines };
}

/** This function gives the data of the panel from one read of the interests. */
export function interestPanel(read: InterestsRead): InterestPanel {
  if (!read.ok) return { verdict: read.absent ? { tone: "quiet", text: NO_ROUTE_TEXT } : { tone: "warn", text: read.text }, people: [] };
  const people = read.payload.people.map(interestPerson);
  if (people.length === 0) return { verdict: { tone: "quiet", text: "The configuration has no people." }, people };
  const problems = people.filter((person) => person.tone === "warn").length;
  if (problems > 0) return { verdict: { tone: "warn", text: `${countOf(problems, "person", "people")} with a problem of the interests. The person keeps the watch of the configuration.` }, people };
  const graphs = read.payload.people.filter((person) => person.routing === "graph").length;
  return { verdict: { tone: "good", text: `${countOf(people.length, "person", "people")}: ${String(graphs)} with an interest graph, ${String(people.length - graphs)} with the places alone.` }, people };
}

function drawLine(line: InterestLine): HTMLElement {
  return h(
    "li",
    { class: "interest-row", "data-state": line.state },
    h("span", { class: "interest-edge" }, line.text),
    h("span", { class: "interest-origin" }, line.origin),
    h("span", { class: "interest-weight" }, line.weight),
    h("span", { class: "interest-state" }, line.word),
  );
}

function drawPerson(person: InterestPerson): HTMLElement {
  return h(
    "li",
    { class: "source-row" },
    h("strong", { class: "source-name" }, person.name),
    h("span", { class: "source-state" }, toneChip(person.tone, person.word)),
    h("span", { class: "source-read" }, person.text),
    h(
      "div",
      { class: "source-more" },
      ...person.notes.map((note) => h("p", {}, note)),
      person.lines.length === 0
        ? null
        : h("details", { class: "interest-more" }, h("summary", {}, `The ${countOf(person.lines.length, "row")} of the graph`), h("ul", { class: "interest-rows" }, ...person.lines.map(drawLine))),
    ),
  );
}

/** This function draws the entries of the panel. A panel with no person gives no element. */
export function drawInterests(panel: InterestPanel): HTMLElement[] {
  return panel.people.length === 0 ? [] : [h("ul", { class: "source-list", "aria-label": "The interests of each person" }, ...panel.people.map(drawPerson))];
}
