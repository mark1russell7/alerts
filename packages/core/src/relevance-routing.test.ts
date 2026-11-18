import { describe, expect, it } from "vitest";
import type { AssessPolicy, Assessment, ChannelDescriptor, ChannelId, Incident, InterestEdge, InterestGraph, Mute, NodeKey, PersonId, PersonWatch, PlaceId, Position, ReportId, WatchedPlace } from "./contracts.ts";
import { DEFAULT_ASSESS_POLICY, assess } from "./assess.ts";
import { personInterests } from "./config.ts";
import { DEFAULT_RELEVANCE_POLICY } from "./relevance.ts";
import { assessPolicySchema, assessmentSchema, personWatchSchema } from "./schemas.ts";

// The routing by the relevance (AL-35 step 5, `docs/RELEVANCE.md`). Each graph is made up. The place is a public point in
// Sedgwick County KS, not a watched place of a real person.
const PERSON = "person-1" as PersonId;
const home = "place-1" as PlaceId;
const HOME = "place:place-1";
const point: Position = [-97.33, 37.69];
const places: readonly WatchedPlace[] = [
  {
    id: home,
    at: point,
    codes: [
      { system: "ugc", code: "KSC173" },
      { system: "same", code: "020173" },
    ],
    bufferKm: 10,
  },
];
const atHome = [{ type: "code", system: "ugc", code: "KSC173" }] as const;
const far = [{ type: "code", system: "ugc", code: "KSZ001" }] as const;
const date = "2026-11-16";

// A circle of 1 km at a distance to the north of the place. Its edge is 1 km nearer than its center.
const north = (km: number) => ({ type: "circle" as const, center: [point[0], point[1] + km / ((6371.0088 * Math.PI) / 180)] as Position, radiusKm: 1 });

type Draft = Omit<Partial<Incident>, "kind"> & { readonly kind?: string };

function incident({ kind = "met.tornado", ...fields }: Draft = {}): Incident {
  return {
    anchor: "a".repeat(64) as ReportId,
    reports: ["a".repeat(64) as ReportId],
    status: "actual",
    kind: { code: kind, label: kind },
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    areas: atHome,
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

function edge(id: string, from: string, to = "person", weight = 1, on = true): InterestEdge {
  return { id, from, to, kind: to === "person" ? "interest" : "logical", weight: { value: weight, low: weight, high: weight }, origin: "places", on };
}

function graph(edges: readonly InterestEdge[], mutes: readonly Mute[] = []): InterestGraph {
  return { format: "alerts-interest/1", person: PERSON, edges, mutes };
}

function watcher(interests?: InterestGraph, fields: Partial<PersonWatch> = {}): PersonWatch {
  return { person: PERSON, places: [home], rules: [], ...(interests === undefined ? {} : { interests }), ...fields };
}

// The assessment, after a check by its schema.
function run(found: Incident, watch: PersonWatch, policy: AssessPolicy = DEFAULT_ASSESS_POLICY, at?: number): Assessment {
  const assessment = assess(found, watch, places, policy, at);
  expect(() => assessmentSchema.parse(assessment)).not.toThrow();
  return assessment;
}

const kinds = (assessment: Assessment): string[] => assessment.reasons.map((reason) => reason.kind);
const offHome = graph([edge("e1", HOME, "person", 1, false)]);
const outage = incident({ kind: "infra.internet.outage", areas: [], about: [{ system: "domain", id: "example.com" }] });
const entity = graph([edge("e1", "domain:example.com", "person", 0.5)]);

describe("the routing by the relevance (AL-35 step 5)", () => {
  it("gives the old levels and places with a graph of the places of weight 1", () => {
    const cases = [
      incident(),
      incident({ areas: far }),
      incident({ kind: "met.wind" }),
      incident({ kind: "met.wind", areas: far }),
      incident({ areas: [north(6)] }),
      incident({ areas: [north(30)] }),
      incident({ urgency: "past" }),
      incident({ live: false }),
      incident({ status: "exercise" }),
    ];
    const plain = watcher();
    const placesOnly = watcher(graph([edge("e1", HOME)]));
    for (const found of cases) {
      const old = run(found, plain);
      const routed = run(found, placesOnly);
      expect(routed.level).toBe(old.level);
      expect(routed.places).toEqual(old.places);
      expect(routed.muted).toBeUndefined();
    }
    expect(cases.map((found) => run(found, placesOnly).level)).toEqual(["life-safety", "none", "urgent", "none", "life-safety", "none", "digest", "none", "none"]);
    // A person with no graph keeps the old reasons. A graph adds one reason of the reach.
    expect(kinds(run(incident(), plain))).toEqual(["table", "place"]);
    expect(kinds(run(incident(), placesOnly))).toEqual(["table", "reach", "place"]);
    expect(run(incident({ areas: far }), placesOnly).reasons).toEqual([{ kind: "no-place" }]);
  });

  it("keeps a life-safety warning at a place of the rule, with the edge off, and a mute makes it silent", () => {
    const muted = graph(offHome.edges, [{ id: "m1", kinds: ["met.tornado"], date }]);
    const found = run(incident(), watcher(muted));
    expect(found.level).toBe("life-safety");
    expect(found.muted).toEqual({ mute: "m1", effect: "silent" });
    expect(found.reasons).toContainEqual(expect.objectContaining({ kind: "reach", reached: [HOME], mandatory: [home] }));
    // A warning below life-safety is not under the rule. The edge that is off removes it, and the mute is absent.
    const wind = run(incident({ kind: "met.wind" }), watcher(graph(offHome.edges, [{ id: "m1", kinds: ["met.wind"], date }])));
    expect(wind.level).toBe("none");
    expect(wind.muted).toEqual({ mute: "m1", effect: "absent" });
    // Under the policy absent, the level stays for the record, and the mute removes the incident.
    const absent: AssessPolicy = { ...DEFAULT_ASSESS_POLICY, relevance: { ...DEFAULT_RELEVANCE_POLICY, mandatory: "absent" } };
    expect(run(incident(), watcher(muted), absent).muted).toEqual({ mute: "m1", effect: "absent" });
  });

  it("never puts a transit incident under the rule of the life-safety warnings (AL-73)", () => {
    const transit = incident({ kind: "transport.transit.service-alert", severity: "extreme", urgency: "immediate" });
    // The rule is on, and the match by the codes is in its range. The table gives the digest, so the rule does not apply.
    const ruled = run(transit, watcher(offHome, { mandatory: [{ place: home, on: true, rangeKm: 10 }] }));
    expect(ruled.level).toBe("none");
    expect(ruled.reasons).toContainEqual(expect.objectContaining({ kind: "reach", mandatory: [] }));
    // With the edge on, the place counts, and the level stays at the digest.
    expect(run(transit, watcher(graph([edge("e1", HOME)]), { mandatory: [{ place: home, on: true, rangeKm: 10 }] })).level).toBe("digest");
  });

  it("turns the rule off at a place, and holds its range", () => {
    expect(run(incident(), watcher(offHome, { mandatory: [{ place: home, on: false, rangeKm: 10 }] })).level).toBe("none");
    // The edge of this circle is 5 km from the place, in its buffer of 10 km.
    const near = incident({ areas: [north(6)] });
    expect(run(near, watcher(offHome, { mandatory: [{ place: home, on: true, rangeKm: 2 }] })).level).toBe("none");
    expect(run(near, watcher(offHome, { mandatory: [{ place: home, on: true, rangeKm: 8 }] })).level).toBe("life-safety");
    // With no rule, the range is the buffer of the place.
    expect(run(near, watcher(offHome)).level).toBe("life-safety");
    // A match by the codes is in each range.
    expect(run(incident(), watcher(offHome, { mandatory: [{ place: home, on: true, rangeKm: 0 }] })).level).toBe("life-safety");
  });

  it("falls back to the places and records a fault when the relevance fails", () => {
    const twice = run(incident(), watcher(graph([edge("e1", HOME), edge("e1", "ugc:KSC173")])));
    expect(twice.level).toBe("life-safety");
    expect(twice.reasons[0]).toEqual({ kind: "relevance-fault", message: "The id e1 is on two edges of the graph." });
    expect(kinds(twice)).toEqual(["relevance-fault", "table", "place"]);
    expect(twice.muted).toBeUndefined();
    // The graph of another person is a fault too. The places decide, so the edge that is off has no effect.
    const stranger: InterestGraph = { ...offHome, person: "person-2" as PersonId };
    const wind = run(incident({ kind: "met.wind" }), watcher(stranger));
    expect(wind.reasons[0]).toEqual({ kind: "relevance-fault", message: "The interest graph is of another person." });
    expect(wind.level).toBe("urgent");
  });

  it("reaches the person through a node above or below the subject in a system of paths, and not through a sibling", () => {
    const carrier = graph([edge("e1", "provider-region:example/region-1/sms", "person", 0.5)]);
    const about = (id: string) => incident({ kind: "infra.internet.outage", areas: [], about: [{ system: "provider-region", id }] });
    // An outage of the whole region, and an outage of a part of the product, reach the product.
    expect(run(about("example/region-1"), watcher(carrier)).level).toBe("urgent");
    expect(run(about("example/region-1/sms/part"), watcher(carrier)).level).toBe("urgent");
    // An outage of another product of the region, or of a region with a longer name, does not.
    expect(run(about("example/region-1/voice"), watcher(carrier)).level).toBe("none");
    expect(run(about("example/region-10"), watcher(carrier)).level).toBe("none");
  });

  it("mutes each node below the subject of a mute in a system of paths", () => {
    const sms = "provider-region:example/region-1/sms";
    const voice = "provider-region:example/region-1/voice";
    const carrier = (mutes: readonly Mute[]) => graph([edge("e1", sms, "person", 0.5), edge("e2", voice, "person", 0.5)], mutes);
    const about = (id: string) => incident({ kind: "infra.internet.outage", areas: [], about: [{ system: "provider-region", id }] });
    const mute = (subject: string): Mute => ({ id: "m1", subjects: [subject], date });
    // A mute of the region matches an outage of a product of the region.
    expect(run(about("example/region-1/sms"), watcher(carrier([mute("provider-region:example/region-1")]))).muted).toEqual({ mute: "m1", effect: "absent" });
    // A mute of one product does not match an outage of the other product, and the outage reaches the person.
    const other = run(about("example/region-1/voice"), watcher(carrier([mute(sms)])));
    expect(other.muted).toBeUndefined();
    expect(other.level).toBe("urgent");
  });

  it("reaches the person through a named entity with no place in the areas", () => {
    const found = run(outage, watcher(entity));
    expect(found.level).toBe("urgent");
    expect(found.places).toEqual([]);
    expect(found.reasons).toContainEqual({
      kind: "reach",
      reach: { value: 0.5, low: 0.5, high: 0.5 },
      reached: ["domain:example.com"],
      mandatory: [],
      entryLevel: "urgent",
      why: expect.objectContaining({ subject: "domain:example.com", kind: "entity", coverage: 1 }),
    });
    // With no edge from the entity, the incident does not reach the person.
    expect(run(outage, watcher(graph([edge("e1", HOME)]))).reasons).toEqual([{ kind: "no-subject" }]);
  });

  it("gives an entry that is not a watched place the level urgent at most, unless the policy raises it", () => {
    const report = incident({ areas: far, about: [{ system: "domain", id: "example.com" }] });
    expect(run(report, watcher(entity)).level).toBe("urgent");
    const raised: AssessPolicy = { ...DEFAULT_ASSESS_POLICY, relevance: { ...DEFAULT_RELEVANCE_POLICY, entryMax: "life-safety" } };
    expect(run(report, watcher(entity), raised).level).toBe("life-safety");
    // The topic of the kind is an entry too.
    expect(run(incident({ areas: far }), watcher(graph([edge("e1", "topic:met.tornado")]))).level).toBe("urgent");
  });

  it("removes a place with an edge that is off, and keeps a place with a low weight", () => {
    const wind = incident({ kind: "met.wind" });
    const off = run(wind, watcher(offHome));
    expect(off.level).toBe("none");
    expect(kinds(off)).toEqual(["table", "reach", "place"]);
    expect(run(wind, watcher(graph([edge("e1", HOME, "person", 0.2)]))).level).toBe("urgent");
  });

  it("marks an incident under a mute as absent, keeps its level for the record, and ends the mute at its time", () => {
    const wind = incident({ kind: "met.wind" });
    const muted = watcher(graph([edge("e1", HOME)], [{ id: "m1", kinds: ["met.wind"], until: 1000, date }]));
    const found = run(wind, muted, DEFAULT_ASSESS_POLICY, 500);
    expect(found.muted).toEqual({ mute: "m1", effect: "absent" });
    expect(found.level).toBe("urgent");
    expect(run(wind, muted, DEFAULT_ASSESS_POLICY, 1000).muted).toBeUndefined();
    // With no time, a mute with an end has no effect, so the alert is not lost.
    expect(run(wind, muted).muted).toBeUndefined();
  });

  it("cuts a path through a muted subject that is not an entry", () => {
    const chain = graph([edge("e1", "domain:example.com", "domain:example.net"), edge("e2", "domain:example.net")], [{ id: "m1", subjects: ["domain:example.net"], date }]);
    const found = run(outage, watcher(chain));
    expect(found.level).toBe("none");
    expect(found.muted).toBeUndefined();
    expect(run(outage, watcher(graph(chain.edges))).level).toBe("urgent");
  });

  it("checks the new fields with the schemas", () => {
    const watch = watcher(graph([edge("e1", HOME)]), { mandatory: [{ place: home, on: true, rangeKm: 3 }] });
    expect(personWatchSchema.safeParse(watch).success).toBe(true);
    expect(personWatchSchema.safeParse({ ...watch, mandatory: [{ place: home, on: true, rangeKm: 3 }, { place: home, on: false, rangeKm: 1 }] }).success).toBe(false);
    expect(personWatchSchema.safeParse({ ...watch, mandatory: [{ place: home, on: true, rangeKm: -1 }] }).success).toBe(false);
    expect(personWatchSchema.safeParse({ ...watch, interests: { ...graph([]), format: "alerts-interest/0" } }).success).toBe(false);
    expect(assessPolicySchema.safeParse({ ...DEFAULT_ASSESS_POLICY, relevance: DEFAULT_RELEVANCE_POLICY }).success).toBe(true);
    expect(assessPolicySchema.safeParse({ ...DEFAULT_ASSESS_POLICY, relevance: { ...DEFAULT_RELEVANCE_POLICY, entryMax: "loud" } }).success).toBe(false);
  });
});

// A source of the work topics gives an incident with no area and one subject, as a catalog of exploited flaws does.
describe("the routing of a work topic (AL-35)", () => {
  const flaw = (severity: Incident["severity"]) =>
    incident({ kind: "cyber.vulnerability.exploited", severity, areas: [], about: [{ system: "cve", id: "CVE-2026-0001" }] });
  // The watch of a person with the work software, as the configuration joins it (`personInterests`).
  const worker = (rules: PersonWatch["rules"] = []) => personInterests({ watch: watcher(undefined, { rules }), defaults: { works: ["software"] } }).watch;

  it("sends an exploited flaw to a person with the work software, up to the entry limit", () => {
    // With no work, the flaw has no place and no watched subject.
    expect(run(flaw("moderate"), watcher()).level).toBe("none");
    const moderate = run(flaw("moderate"), worker());
    expect(moderate.level).toBe("notice");
    expect(moderate.places).toEqual([]);
    expect(moderate.reasons).toContainEqual(expect.objectContaining({ kind: "reach", reached: ["topic:cyber.vulnerability.exploited"] }));
    // A severe flaw is urgent, not life-safety: the entry limit of the policy is urgent.
    expect(run(flaw("severe"), worker()).level).toBe("urgent");
    expect(run(flaw("extreme"), worker()).level).toBe("urgent");
  });

  it("lowers the level of a work topic with a rule of the person", () => {
    const digest = worker([{ kinds: ["cyber.vulnerability.exploited"], max: "digest" }]);
    expect(run(flaw("moderate"), digest).level).toBe("digest");
    expect(run(flaw("severe"), digest).level).toBe("digest");
    // A rule of another kind does not change the level.
    expect(run(flaw("moderate"), worker([{ kinds: ["met"], max: "digest" }])).level).toBe("notice");
  });
});

describe("the entries of a rule (AL-35)", () => {
  const down = (severity: Incident["severity"]) => incident({ kind: "infra.saas.outage", severity, areas: [], about: [{ system: "domain", id: "example.com" }] });
  const rules: PersonWatch["rules"] = [
    { kinds: ["infra"], through: ["topic"], max: "digest" },
    { kinds: ["infra"], max: "notice" },
  ];
  const user = (services: readonly NodeKey[]) => personInterests({ watch: watcher(undefined, { rules }), defaults: { works: ["software"], services } }).watch;

  it("lowers an outage that comes only through a topic of the work, and keeps a service that the person names", () => {
    expect(run(down("severe"), user([])).level).toBe("digest");
    // The service is a second entry. The first rule does not match through it, so the second rule applies.
    const named = run(down("severe"), user(["domain:example.com"]));
    expect(named.level).toBe("notice");
    expect(named.reasons).toContainEqual(expect.objectContaining({ kind: "reach", reached: expect.arrayContaining(["domain:example.com", "topic:infra.saas"]) }));
    expect(run(down("moderate"), user(["domain:example.com"])).level).toBe("notice");
    expect(run(down("minor"), user(["domain:example.com"])).level).toBe("digest");
  });

  it("sends an outage of a service of a channel of the person as a named service, and the switch delivery turns it off", () => {
    const push: ChannelDescriptor = { id: "push" as ChannelId, title: "Push", dependsOn: [], services: ["domain:example.com"], uses: ["internet"], breaksThrough: true, repeats: true, ack: "poll", maxTitle: 100, maxBody: 100 };
    const reached = (delivery?: boolean) =>
      personInterests({ watch: watcher(undefined, { rules }), defaults: { works: ["software"], ...(delivery === undefined ? {} : { delivery }) } }, [push]).watch;
    const path = run(down("severe"), reached());
    expect(path.level).toBe("notice");
    expect(path.reasons).toContainEqual(expect.objectContaining({ kind: "reach", reached: expect.arrayContaining(["domain:example.com"]) }));
    expect(run(down("severe"), reached(false)).level).toBe("digest");
  });

  it("matches a watched place through the kind place, and a watched subject through the kind of its system", () => {
    const base = run(incident(), watcher()).level;
    expect(base).not.toBe("digest");
    expect(run(incident(), watcher(undefined, { rules: [{ kinds: ["met"], through: ["topic", "entity"], max: "digest" }] })).level).toBe(base);
    expect(run(incident(), watcher(undefined, { rules: [{ kinds: ["met"], through: ["place"], max: "digest" }] })).level).toBe("digest");
    const subjects = [{ system: "domain", id: "example.com" }];
    const watched = run(outage, watcher(undefined, { subjects }));
    expect(watched.level).not.toBe("digest");
    expect(run(outage, watcher(undefined, { subjects, rules: [{ through: ["topic"], max: "digest" }] })).level).toBe(watched.level);
    expect(run(outage, watcher(undefined, { subjects, rules: [{ through: ["entity"], max: "digest" }] })).level).toBe("digest");
  });

  it("checks the kinds of the entries of a rule", () => {
    expect(personWatchSchema.safeParse(watcher(undefined, { rules: [{ through: ["topic"], max: "digest" }] })).success).toBe(true);
    expect(personWatchSchema.safeParse({ ...watcher(), rules: [{ through: ["street"], max: "digest" }] }).success).toBe(false);
  });
});
