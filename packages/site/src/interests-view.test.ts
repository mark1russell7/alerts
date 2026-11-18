import { INTERESTS_FORMAT, kindLabel, type InterestEdge, type InterestsPayload, type InterestsPerson, type PersonId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { OTHER_INTERESTS_TEXT, readInterests } from "./interests-read.ts";
import { interestPanel, interestPerson, NO_ROUTE_TEXT, originText, PLACES_TEXT, weightText } from "./interests-view.ts";

// Made-up people, places and services.
const ana = "ana" as PersonId;
const ben = "ben" as PersonId;
const point = (value: number) => ({ value, low: value, high: value });
const UNKNOWN = { value: 0.5, low: 0, high: 1 };
const edge = (id: string, from: InterestEdge["from"], origin: InterestEdge["origin"], weight = point(1), on = true, source?: string): InterestEdge => ({
  id,
  from,
  to: "person",
  kind: "interest",
  weight,
  origin,
  on,
  ...(source === undefined ? {} : { source }),
});
const place = edge("places/place:farm>person", "place:farm", "places");
const work = edge("work/topic:infra.cloud>person", "topic:infra.cloud", "work", UNKNOWN, true, "work:finance,software");
const saas = edge("work/topic:infra.saas>person", "topic:infra.saas", "work", UNKNOWN, true, "work:software");
const mine = edge("mine", "topic:infra.cloud", "person", point(1), false);
const ANA: InterestsPerson = {
  person: ana,
  label: "Ana",
  routing: "graph",
  rows: [{ edge: place }, { edge: work, replacedBy: "mine" }, { edge: mine }, { edge: saas }],
  mutes: [{ id: "quiet", subjects: ["domain:example.com"], kinds: ["infra.saas"], date: "2026-11-17" }],
  labels: { "place:farm": "The farm", "topic:infra.cloud": "Cloud services", "topic:infra.saas": "Software services" },
};
const BEN: InterestsPerson = { person: ben, routing: "places", rows: [], mutes: [], labels: {} };
const PAYLOAD: InterestsPayload = { format: INTERESTS_FORMAT, people: [ANA, BEN] };

const answer = (body: string, status = 200) => async (): Promise<Response> => new Response(body, { status });

describe("the read of the interests", () => {
  it("gives the payload, no route for a status 404, and a text for each other failure", async () => {
    expect(await readInterests(answer(JSON.stringify(PAYLOAD)))).toEqual({ ok: true, payload: PAYLOAD });
    expect(await readInterests(answer("", 404))).toEqual({ ok: false, absent: true });
    expect(await readInterests(answer(JSON.stringify({ ...PAYLOAD, format: "alerts-interests/2" })))).toEqual({ ok: false, absent: false, text: OTHER_INTERESTS_TEXT });
    const failed = [
      await readInterests(async () => Promise.reject(new Error("refused"))),
      await readInterests(answer("", 500)),
      await readInterests(answer("not json")),
      await readInterests(answer(JSON.stringify({ format: INTERESTS_FORMAT, people: [{ person: ana }] }))),
    ];
    expect(failed.map((read) => (!read.ok && !read.absent ? read.text.split(". ").at(-1) : read))).toEqual([
      "The runtime does not answer.",
      "The runtime answers with the status 500.",
      "The answer of the runtime is not JSON.",
      "The answer of the runtime is not a list of interests.",
    ]);
  });
});

describe("the panel of the interests", () => {
  it("gives the words of a weight and of an origin", () => {
    expect(weightText(point(1))).toBe("Weight 1");
    expect(weightText(UNKNOWN)).toBe("Weight unknown, 0 to 1");
    expect(weightText({ value: 0.333, low: 0.25, high: 0.5 })).toBe("Weight 0.33, 0.25 to 0.5");
    expect(originText("work", "work:finance,software")).toBe("Kind of work: finance, software");
    expect(originText("places", undefined)).toBe("Watched place");
    expect(originText("delivery", "channel:pushover,twilio-call")).toBe("Path of the alerts: pushover, twilio-call");
    expect(originText("delivery", undefined)).toBe("Path of the alerts");
    expect(originText("services", "channel:pushover")).toBe("Named service");
  });

  it("gives the rows in use first, then the rows that are off, then the replaced rows, with the labels", () => {
    const person = interestPerson(ANA);
    expect(person).toMatchObject({ name: "Ana", tone: "good", word: "Graph", text: "2 edges in use, 1 off, 1 default replaced." });
    expect(person.lines.map((line) => [line.text, line.state, line.word])).toEqual([
      ["The farm → Ana", "used", "In use"],
      ["Software services → Ana", "used", "In use"],
      ["Cloud services → Ana", "off", "Off"],
      ["Cloud services → Ana", "replaced", "Replaced by own choice"],
    ]);
    expect(person.notes).toEqual([`Mute: domain:example.com for ${kindLabel("infra.saas")}.`]);
  });

  it("tells a person with the places alone, a problem, and the sentence of the panel", () => {
    expect(interestPerson(BEN)).toEqual({ name: "ben", tone: "quiet", word: "Places", text: PLACES_TEXT, notes: [], lines: [] });
    const refused = interestPerson({ ...BEN, problem: "The table of the kinds of work does not have the work \"astronomy\"." });
    expect([refused.tone, refused.word, refused.notes]).toEqual(["warn", "Problem", ["The table of the kinds of work does not have the work \"astronomy\"."]]);
    expect(interestPanel({ ok: true, payload: PAYLOAD }).verdict).toEqual({ tone: "good", text: "2 people: 1 with an interest graph, 1 with the places alone." });
    expect(interestPanel({ ok: true, payload: { ...PAYLOAD, people: [ANA, { ...BEN, problem: "x" }] } }).verdict.tone).toBe("warn");
    expect(interestPanel({ ok: false, absent: true })).toEqual({ verdict: { tone: "quiet", text: NO_ROUTE_TEXT }, people: [] });
    expect(interestPanel({ ok: false, absent: false, text: "No answer." })).toEqual({ verdict: { tone: "warn", text: "No answer." }, people: [] });
  });
});
