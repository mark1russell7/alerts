// The payload of the route `GET /interests` of the runtime: the rows of the interest graph of each person (AL-35,
// `docs/RELEVANCE.md`, the section "The join of the layers").

import { compareCodeUnits } from "@mark1russell7/text/order";
import { personInterests, placeLabels, type AlertConfig } from "./config.ts";
import type { Mute, NodeKey, PersonId } from "./contracts.ts";
import type { InterestRow } from "./interest-defaults.ts";
import { kindLabel } from "./taxonomy.ts";
import { graphLabels } from "./why.ts";

/** The format of the payload of the route `GET /interests`. */
export const INTERESTS_FORMAT = "alerts-interests/1";

/** The interests of one person: the routing of the alerts, and a row for each edge. */
export interface InterestsPerson {
  readonly person: PersonId;
  /** The name of the person for the UI. */
  readonly label?: string;
  /** The routing of the alerts: `graph` when the relevance decides, `places` when the watched places decide. */
  readonly routing: "graph" | "places";
  /** The rows of the graph: each edge of the layers and of the person. A replaced default has the id of its replacement. */
  readonly rows: readonly InterestRow[];
  /** The mutes of the person. */
  readonly mutes: readonly Mute[];
  /** The label of each node of the rows and the mutes that has one: a place, a label of the graph or a topic. */
  readonly labels: Readonly<Record<string, string>>;
  /** The problem of the join or of the graph. Then the person keeps the watch of the configuration. */
  readonly problem?: string;
}

/** The payload of the route `GET /interests`: the interests of each person, in the order of the configuration. */
export interface InterestsPayload {
  readonly format: typeof INTERESTS_FORMAT;
  readonly people: readonly InterestsPerson[];
}

const TOPIC = "topic:";

/**
 * This function gives the payload of the route `GET /interests` from the configuration. The rows come from the same
 * join as the load (`personInterests`). The payload holds the labels of the places. Thus only the loopback address
 * serves the route.
 */
export function interestsPayload(config: AlertConfig): InterestsPayload {
  const places = placeLabels(config);
  const people = config.people.map((entry): InterestsPerson => {
    const person = entry.watch.person;
    const own = entry.watch.interests;
    const joined = personInterests(entry);
    const graph = joined.watch.interests;
    const other = own !== undefined && own.person !== person ? own.person : undefined;
    const labelOf = graphLabels(places, graph);
    const nodes = new Set<NodeKey>([...joined.rows.flatMap(({ edge }) => [edge.from, edge.to]), ...(graph?.mutes ?? []).flatMap((mute) => mute.subjects ?? [])]);
    const labels = Object.fromEntries(
      [...nodes].sort(compareCodeUnits).flatMap((node) => {
        const label = labelOf(node) ?? (node.startsWith(TOPIC) ? kindLabel(node.slice(TOPIC.length)) : undefined);
        return label === undefined ? [] : [[node, label] as const];
      }),
    );
    const problem = joined.problem ?? (other === undefined ? undefined : `The interest graph is of the person ${other}. The relevance fails, and the places decide.`);
    return {
      person,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      routing: graph !== undefined && other === undefined ? "graph" : "places",
      rows: joined.rows,
      mutes: graph?.mutes ?? [],
      labels,
      ...(problem === undefined ? {} : { problem }),
    };
  });
  return { format: INTERESTS_FORMAT, people };
}
