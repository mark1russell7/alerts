import { describe, expect, it } from "vitest";
import { CONFIG_FORMAT, personInterests, type AlertConfig, type PersonConfig } from "./config.ts";
import type { InterestEdge, InterestGraph, NodeKey, PersonId, PlaceId } from "./contracts.ts";
import { composeInterests, placesLayer, workLayer } from "./interest-defaults.ts";
import { INTERESTS_FORMAT, interestsPayload } from "./interests-payload.ts";
import { interestsPayloadSchema } from "./schemas.ts";
import { kindLabel } from "./taxonomy.ts";

// Made-up people and places.
const farm = "farm" as PlaceId;
const ana = "ana" as PersonId;
const ben = "ben" as PersonId;
const cy = "cy" as PersonId;
const dee = "dee" as PersonId;
const CERTAIN = { value: 1, low: 1, high: 1 };

const off: InterestEdge = { id: "mine", from: "topic:infra.cloud", to: "person", kind: "interest", weight: CERTAIN, origin: "person", on: false };
const graphOf = (person: PersonId, edges: readonly InterestEdge[], extra: Partial<InterestGraph> = {}): InterestGraph => ({ format: "alerts-interest/1", person, edges, mutes: [], ...extra });
const person = (id: PersonId, fields: Partial<PersonConfig> = {}, interests?: InterestGraph): PersonConfig => ({
  watch: { person: id, places: [farm], rules: [], ...(interests === undefined ? {} : { interests }) },
  ...fields,
});

function configOf(people: readonly PersonConfig[]): AlertConfig {
  return {
    format: CONFIG_FORMAT,
    places: [{ id: farm, label: "The farm", at: [-97.3, 37.7], codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 5 }],
    people,
    contacts: [],
    policies: [],
  };
}

describe("the payload of the interests", () => {
  it("gives the rows of the join, the routing, the mutes and the labels of each person", () => {
    const mutes = [{ id: "quiet", subjects: ["domain:example.com" as NodeKey], date: "2026-11-17" }];
    const own = graphOf(ana, [off], { mutes, labels: { "domain:example.com": "The shop site" } });
    const joined = person(ana, { label: "Ana", defaults: { works: ["software"] } }, own);
    const payload = interestsPayload(configOf([joined, person(ben)]));
    expect(payload.format).toBe(INTERESTS_FORMAT);
    // The page reads the payload through the schema. A payload of the runtime passes it.
    expect(interestsPayloadSchema.safeParse(payload).success).toBe(true);
    const [first, second] = payload.people;
    expect(first).toEqual({
      person: ana,
      label: "Ana",
      routing: "graph",
      rows: composeInterests(ana, [placesLayer([farm]), workLayer(["software"])], own).rows,
      mutes,
      labels: expect.objectContaining({ "place:farm": "The farm", "topic:infra.cloud": kindLabel("infra.cloud"), "domain:example.com": "The shop site" }),
    });
    expect(first!.rows.find((row) => row.edge.id === "work/topic:infra.cloud>person")?.replacedBy).toBe("mine");
    // A person with no graph and no defaults: the places decide, and the person has no row.
    expect(second).toEqual({ person: ben, routing: "places", rows: [], mutes: [], labels: {} });
  });

  it("gives the problem of the join, and the rows of the graph that the person keeps", () => {
    const own = graphOf(cy, [off]);
    const refused = person(cy, { defaults: { works: ["astronomy"] } }, own);
    const [view] = interestsPayload(configOf([refused])).people;
    expect(view?.problem).toBe(`The table of the kinds of work does not have the work "astronomy".`);
    expect(view?.routing).toBe("graph");
    expect(view?.rows).toEqual([{ edge: off }]);
    expect(personInterests(refused).watch).toBe(refused.watch);
  });

  it("tells that the places decide for a graph of another person", () => {
    const [view] = interestsPayload(configOf([person(dee, { defaults: {} }, graphOf(ana, [off]))])).people;
    expect(view?.routing).toBe("places");
    expect(view?.problem).toBe("The interest graph is of the person ana. The relevance fails, and the places decide.");
    expect(view?.rows).toEqual([{ edge: off }]);
  });
});
