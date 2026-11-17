import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { type AlertConfig, CONFIG_FORMAT, configHash, configuredExpectations, type ContactConfig, drillRules, expectationProblems, loadConfig, localPlaces, type PersonConfig, type PlaceConfig, placeLabels, type SecretLookup, sendCapUsd, sourcePlaces } from "./config.ts";
import type { ChannelDescriptor, ChannelId, EscalationPolicy, InterestEdge, InterestGraph, NodeKey, PersonId, PlaceId, Position, SourceId } from "./contracts.ts";
import { RANK_DELAY_LIMIT } from "./escalation.ts";
import { DRILL_SUBJECT } from "./system-reports.ts";
import type { Expectation } from "./lateness.ts";
import { rankDelaysSchema } from "./schemas.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const MINUTE = 60_000;
const pushover = "pushover" as ChannelId;
const sms = "sms" as ChannelId;
const nws = "nws-api" as SourceId;
const ipaws = "ipaws" as SourceId;

// Public places in Kansas, with made-up positions near them.
const home = "place-1" as PlaceId;
const work = "place-2" as PlaceId;
const HOME_AT: Position = [-97.3, 37.7];
const PLACES: readonly PlaceConfig[] = [
  { id: home, label: "Home", at: HOME_AT, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 5, sharePosition: [nws] },
  { id: work, label: "Work", at: [-95.7, 39.0], codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 2 },
];

const LIFE_SAFETY: EscalationPolicy = {
  level: "life-safety",
  steps: [
    { channel: pushover, at: 0 },
    { channel: sms, at: 5 * MINUTE },
  ],
  exhaustedAfter: 20 * MINUTE,
};
const URGENT: EscalationPolicy = { level: "urgent", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 10 * MINUTE };
// The failure of a drill goes at the level notice, on each channel other than the path of the drill.
const NOTICE: EscalationPolicy = { level: "notice", steps: [{ channel: sms, at: 0 }], exhaustedAfter: 10 * MINUTE };

function channel(id: ChannelId): ChannelDescriptor {
  return { id, title: id, dependsOn: [], uses: ["internet", "dns"], breaksThrough: true, repeats: false, ack: "none", maxTitle: 250, maxBody: 1024 };
}
const CHANNELS = [channel(pushover), channel(sms)];

const p1 = "person-1" as PersonId;
const p2 = "person-2" as PersonId;

function person(id: PersonId, places: readonly PlaceId[] = [home], fields: Partial<PersonConfig> = {}): PersonConfig {
  return { watch: { person: id, places, rules: [] }, ...fields };
}

function contacts(id: PersonId): ContactConfig[] {
  return [
    { person: id, channel: pushover, address: { user: { secret: "PUSHOVER_USER_KEY" } } },
    { person: id, channel: sms, address: { to: { secret: "SMS_NUMBER" } } },
  ];
}

function config(fields: Partial<AlertConfig> = {}): AlertConfig {
  return configOf(fields);
}

function configOf(fields: Partial<AlertConfig> = {}): AlertConfig {
  return { format: CONFIG_FORMAT, places: PLACES, people: [person(p1)], contacts: contacts(p1), policies: [LIFE_SAFETY, URGENT], ...fields };
}

// Fake values, so a test can look for them in each problem.
const SECRETS: Readonly<Record<string, string>> = { PUSHOVER_USER_KEY: "fake-user-value", SMS_NUMBER: "fake-number-value" };
const store: SecretLookup = (name) => SECRETS[name];

describe("loadConfig", () => {
  it("makes the recipient of each person, with the values of the secrets in the addresses", () => {
    const loaded = loadConfig(config(), CHANNELS, store);
    expect(loaded.problems).toEqual([]);
    expect(loaded.recipients).toEqual([
      {
        watch: { person: p1, places: [home], rules: [] },
        policies: [LIFE_SAFETY, URGENT],
        addresses: { pushover: { user: "fake-user-value" }, sms: { to: "fake-number-value" } },
      },
    ]);
  });

  it("keeps a plain value of an address as it is", () => {
    const loaded = loadConfig(config({ contacts: [{ person: p1, channel: pushover, address: { user: "plain", device: "phone" } }, contacts(p1)[1]!] }), CHANNELS, store);
    expect(loaded.problems).toEqual([]);
    expect(loaded.recipients[0]?.addresses["pushover"]).toEqual({ user: "plain", device: "phone" });
  });

  it("gives the policies of the configuration to a person with none, and the own policies to a person with some", () => {
    const own: EscalationPolicy[] = [{ ...LIFE_SAFETY, exhaustedAfter: 30 * MINUTE }];
    const loaded = loadConfig(config({ people: [person(p1), person(p2, [work], { label: "Second", policies: own })], contacts: [...contacts(p1), ...contacts(p2)] }), CHANNELS, store);
    expect(loaded.problems).toEqual([]);
    expect(loaded.recipients.map((r) => [r.watch.person, r.policies])).toEqual([
      [p1, [LIFE_SAFETY, URGENT]],
      [p2, own],
    ]);
  });

  it("names a missing or an empty secret, and no problem holds the value of a secret", () => {
    const partial: SecretLookup = (name) => (name === "SMS_NUMBER" ? "" : undefined);
    const loaded = loadConfig(config(), CHANNELS, partial);
    expect(loaded.problems).toContain("The field user of the contact of person-1 on pushover names the secret PUSHOVER_USER_KEY, and the secret store has no value for it.");
    expect(loaded.problems).toContain("The field to of the contact of person-1 on sms names the secret SMS_NUMBER, and the secret store has no value for it.");
    const all = loadConfig(config({ places: [{ ...PLACES[0]!, codes: [] }] }), [], store).problems.join("\n");
    for (const value of Object.values(SECRETS)) expect(all).not.toContain(value);
  });

  it("finds two places or two people with one id, and a place with no region code", () => {
    const loaded = loadConfig(
      config({ places: [...PLACES, { ...PLACES[1]!, codes: [] }], people: [person(p1), person(p1)], contacts: contacts(p1) }),
      CHANNELS,
      store,
    );
    expect(loaded.problems).toEqual(["Two places have the id place-2.", "The place place-2 has no region code, so no incident matches it.", "Two people have the id person-1."]);
  });

  it("finds a place that the configuration does not have, and a rule at a place that the person does not watch", () => {
    const other = "place-9" as PlaceId;
    const watched = person(p1, [home, other]);
    const ruled: PersonConfig = { watch: { ...watched.watch, rules: [{ places: [work], max: "notice" }] } };
    const loaded = loadConfig(config({ people: [ruled] }), CHANNELS, store);
    expect(loaded.problems).toEqual([
      "The person person-1 watches the place place-9, and the configuration has no such place.",
      "Rule 0 of the person person-1 names the place place-2, and the person does not watch it. The rule matches no incident there.",
    ]);
  });

  it("finds an interest graph of another person, and a place of the graph or of a mandatory rule that the person does not watch", () => {
    const edge = (id: string, from: NodeKey): InterestEdge => ({ id, from, to: "person", kind: "geographic", weight: { value: 1, low: 1, high: 1 }, origin: "places", on: true });
    const interests: InterestGraph = {
      format: "alerts-interest/1",
      person: p2,
      edges: [edge("e1", `place:${home}`), edge("e2", `place:${work}`)],
      mutes: [{ id: "m1", subjects: [`place:${work}`, "topic:met.tornado"], date: "2026-11-16" }],
    };
    const watched = person(p1, [home]);
    const graphed: PersonConfig = { watch: { ...watched.watch, interests, mandatory: [{ place: home, on: true, rangeKm: 5 }, { place: work, on: true, rangeKm: 5 }] } };
    expect(loadConfig(config({ people: [graphed] }), CHANNELS, store).problems).toEqual([
      "The interest graph of the person person-1 is of the person person-2. The relevance fails, and the places decide.",
      "The interest graph of the person person-1 names the place place-2, and the person does not watch it.",
      "The rule of the life-safety warnings of the person person-1 names the place place-2, and the person does not watch it.",
    ]);
  });

  it("finds a mandatory rule with no interest graph, and takes a graph of the person at its own places", () => {
    const watched = person(p1, [home]);
    const ruled: PersonConfig = { watch: { ...watched.watch, mandatory: [{ place: home, on: false, rangeKm: 5 }] } };
    expect(loadConfig(config({ people: [ruled] }), CHANNELS, store).problems).toEqual([
      "The person person-1 has rules of the life-safety warnings and no interest graph. The rules have no effect without a graph.",
    ]);
    const interests: InterestGraph = { format: "alerts-interest/1", person: p1, edges: [], mutes: [{ id: "m1", subjects: [`place:${home}`], date: "2026-11-16" }] };
    expect(loadConfig(config({ people: [{ watch: { ...ruled.watch, interests } }] }), CHANNELS, store).problems).toEqual([]);
  });

  it("finds a contact of an unknown person and two contacts of a person on one channel", () => {
    const loaded = loadConfig(config({ contacts: [...contacts(p1), contacts(p1)[0]!, ...contacts(p2)] }), CHANNELS, store);
    expect(loaded.problems).toEqual([
      "The person person-1 has two contacts on the channel pushover.",
      "A contact on the channel pushover is for the person person-2, and the configuration has no such person.",
      "A contact on the channel sms is for the person person-2, and the configuration has no such person.",
    ]);
  });

  it("gives each problem of recipientProblems with the id of the person", () => {
    const loaded = loadConfig(config({ contacts: [contacts(p1)[0]!] }), [channel(pushover)], store);
    expect(loaded.problems).toEqual([
      "The person person-1: Step 1 of life-safety uses the channel sms, and the system has no such channel.",
      "The person person-1: Step 1 of life-safety uses the channel sms, and the person has no address on it.",
    ]);
  });

  it("takes the fixed costs off the cap first: the reserve is a part of the rest, and the rest is above 0", () => {
    const paid = [{ ...channel(pushover), dependsOn: ["provider:pushover"] }, channel(sms)];
    const fixed = [
      { what: "toll-free number", usd: 2.15 },
      { what: "local number", usd: 1.15 },
    ];
    const spend = { provider: "provider:pushover", monthlyUsd: 15, fixed, reserveUsd: 3, floor: 5, timeZone: "America/Chicago" };
    expect(sendCapUsd(spend)).toBeCloseTo(11.7, 9);
    expect(sendCapUsd({ monthlyUsd: 15 })).toBe(15);
    expect(loadConfig(config({ spend: [spend] }), paid, store).problems).toEqual([]);
    expect(loadConfig(config({ spend: [{ ...spend, reserveUsd: 12 }] }), paid, store).problems).toEqual([
      "The reserve of the spend of provider:pushover is not below its monthly cap less its fixed costs.",
    ]);
    expect(loadConfig(config({ spend: [{ ...spend, monthlyUsd: 3.3, reserveUsd: 0 }] }), paid, store).problems).toEqual([
      "The fixed costs of the spend of provider:pushover use all of its monthly cap. No send can go.",
    ]);
  });

  it("checks each spend entry: one for each provider, a provider of a channel, a reserve below the cap, and an IANA time zone", () => {
    const paid = [{ ...channel(pushover), dependsOn: ["provider:pushover"] }, channel(sms)];
    const spend = { provider: "provider:pushover", monthlyUsd: 10, reserveUsd: 3, floor: 5, timeZone: "America/Chicago" };
    expect(loadConfig(config({ spend: [spend] }), paid, store).problems).toEqual([]);
    const { reserveUsd: _reserve, ...noReserve } = spend;
    expect(loadConfig(config({ spend: [{ ...noReserve, monthlyUsd: 0.01 }] }), paid, store).problems).toEqual([]);
    const problems = loadConfig(
      config({ spend: [spend, { ...spend, reserveUsd: 10 }, { ...spend, provider: "provider:pushoverr", timeZone: "Mars/Olympus" }] }),
      paid,
      store,
    ).problems;
    expect(problems).toEqual([
      "Two spend entries are for the provider provider:pushover.",
      "The reserve of the spend of provider:pushover is not below its monthly cap less its fixed costs.",
      "The spend entry of provider:pushoverr names a provider that no channel depends on.",
      "The time zone of the spend of provider:pushoverr is not an IANA name.",
    ]);
  });

  it("checks the table of rank delays: the schema refuses an unknown level, and the load refuses a value out of its bounds", () => {
    expect(loadConfig(config({ rankDelay: { "life-safety": 0, urgent: 30_000 } }), CHANNELS, store).problems).toEqual([]);
    expect(loadConfig(config({ rankDelay: { notice: 2.5 } }), CHANNELS, store).problems).toEqual([
      `The rank delay of the level notice is not a whole number of milliseconds from 0 to ${RANK_DELAY_LIMIT}.`,
    ]);
    expect(rankDelaysSchema.safeParse({ "life-safety": 0 }).success).toBe(true);
    expect(rankDelaysSchema.safeParse({ lifesafety: 0 }).success).toBe(false);
    expect(rankDelaysSchema.safeParse({ urgent: -1 }).success).toBe(false);
  });

  it("checks the drills: one id each, a known person who watches the drill, a step and a contact on the channel", () => {
    const polled = [{ ...channel(pushover), ack: "poll" as const }, channel(sms)];
    const window = { zone: "America/Chicago", start: "11:00", end: "17:00", days: [6] };
    const drill = { id: "push-weekly", person: p1, path: { kind: "channel" as const, channel: pushover }, every: 6 * 24 * 60 * MINUTE, window, ackWithin: 30 * MINUTE };
    const subjects = [
      { system: DRILL_SUBJECT, id: "push-weekly" },
      { system: DRILL_SUBJECT, id: "text" },
    ];
    const watcher = person(p1, [home], { watch: { person: p1, places: [home], rules: [], subjects } });
    // The people of a drill have a policy of the level notice for the failure of the drill.
    const config = (fields: Partial<AlertConfig>): AlertConfig => configOf({ policies: [LIFE_SAFETY, URGENT, NOTICE], ...fields });
    expect(loadConfig(config({ people: [watcher], drills: [drill] }), polled, store).problems).toEqual([]);
    // A watch with no id matches each drill.
    const all = person(p1, [home], { watch: { person: p1, places: [home], rules: [], subjects: [{ system: DRILL_SUBJECT }] } });
    expect(loadConfig(config({ people: [all], drills: [{ ...drill, id: "any" }] }), polled, store).problems).toEqual([]);
    // The quiet window of the person covers the window of the drill: the drill has no start. The flip is a good drill.
    const sleeper = (start: string, end: string) => person(p1, [home], { watch: { person: p1, places: [home], rules: [], subjects, quiet: { zone: "America/Chicago", start, end } } });
    expect(loadConfig(config({ people: [sleeper("10:00", "18:00")], drills: [drill] }), polled, store).problems).toEqual([
      "The drill push-weekly has no start in the weeks from 2026-01-05 and 2026-07-06: each time of its window is in the quiet window of the person, or too near to it.",
    ]);
    expect(loadConfig(config({ people: [sleeper("18:00", "10:00")], drills: [drill] }), polled, store).problems).toEqual([]);
    const problems = loadConfig(
      config({
        people: [watcher, person(p2, [work], { policies: [URGENT] })],
        contacts: [contacts(p1)[1]!, ...contacts(p2)],
        drills: [
          drill,
          { ...drill, person: "person-9" as PersonId },
          { ...drill, id: "text", path: { kind: "channel", channel: sms } },
          { ...drill, id: "second", person: p2 },
          { ...drill, id: "third", path: { kind: "channel", channel: sms } },
        ],
      }),
      polled,
      store,
    ).problems;
    // The person person-1 also has no contact on the channel of a step. Only the problems of the drills count here.
    expect(problems.filter((problem) => /^(The drill|Two drills|The run of|The failure of)/.test(problem))).toEqual([
      "The drill push-weekly uses the channel pushover, and the person person-1 has no contact on it.",
      "Two drills have the id push-weekly.",
      "The drill push-weekly is for the person person-9, and the configuration has no such person.",
      // The failure of the drill text goes on each channel other than sms, and the notice policy has only sms.
      "The failure of the drill text reaches the person person-1 at the level notice, and its policy has no step on a channel other than sms. It sends nothing.",
      "The drill text uses the channel sms, and the channel does not tell of an acknowledgment. The drill cannot pass.",
      "The drill second is for the person person-2, and the person does not watch the subject alerts.drill. The drill does not reach the person.",
      "The drill third is for the person person-1, and the person does not watch the subject alerts.drill. The drill does not reach the person.",
      "The drill third uses the channel sms, and the channel does not tell of an acknowledgment. The drill cannot pass.",
    ]);
  });

  it("refuses a drill whose run or failure sends nothing, and gives the rules of the drill to its people", () => {
    const polled = [{ ...channel(pushover), ack: "poll" as const }, channel(sms)];
    const window = { zone: "America/Chicago", start: "11:00", end: "17:00", days: [6] };
    const drill = { id: "push-weekly", person: p1, path: { kind: "channel" as const, channel: pushover }, every: 6 * 24 * 60 * MINUTE, window, ackWithin: 30 * MINUTE };
    const watch = (id: PersonId) => ({ person: id, places: [home], rules: [], subjects: [{ system: DRILL_SUBJECT }] });
    const load = (policies: readonly EscalationPolicy[]) => loadConfig(config({ people: [person(p1, [home], { watch: watch(p1), policies })], drills: [drill] }), polled, store).problems;
    const onPush: EscalationPolicy = { ...NOTICE, steps: [{ channel: pushover, at: 0 }] };
    const textOnly: EscalationPolicy = { ...LIFE_SAFETY, steps: [{ channel: sms, at: 0 }] };
    const run = "The run of the drill push-weekly reaches the person person-1 at the level life-safety";
    const failure = "The failure of the drill push-weekly reaches the person person-1 at the level notice";
    // Each refusal has its flip: the same configuration with the missing step or policy.
    expect(load([LIFE_SAFETY, URGENT])).toEqual([`${failure}, and the person has no policy of it. It sends nothing.`]);
    expect(load([LIFE_SAFETY, URGENT, onPush])).toEqual([`${failure}, and its policy has no step on a channel other than pushover. It sends nothing.`]);
    expect(load([textOnly, URGENT, NOTICE])).toEqual([`${run}, and its policy has no step on the channel pushover. It sends nothing.`]);
    expect(load([LIFE_SAFETY, URGENT, NOTICE])).toEqual([]);

    // The person of the drill gets its two rules. Another person who watches the drill gets a rule that blocks its run.
    const loaded = loadConfig(
      config({ people: [person(p1, [home], { watch: watch(p1), policies: [LIFE_SAFETY, URGENT, NOTICE] }), person(p2, [home], { watch: watch(p2), policies: [LIFE_SAFETY, URGENT, NOTICE] })], contacts: [...contacts(p1), ...contacts(p2)], drills: [drill] }),
      polled,
      store,
    );
    expect(loaded.problems).toEqual([]);
    const rules = new Map(loaded.recipients.map((recipient) => [recipient.watch.person, recipient.channelRules]));
    const about = { system: DRILL_SUBJECT, id: "push-weekly" };
    expect(rules.get(p1)).toEqual(drillRules(drill));
    expect(rules.get(p2)).toEqual([{ kinds: ["system.drill.run"], about, keep: "only", channels: [] }]);
    // A person who does not watch the drill gets no rule.
    const apart = loadConfig(config({ people: [person(p1, [home], { watch: watch(p1) }), person(p2)], contacts: [...contacts(p1), ...contacts(p2)], drills: [drill] }), polled, store);
    expect(apart.recipients.find((recipient) => recipient.watch.person === p2)?.channelRules).toBeUndefined();
  });

  it("checks the outage call: a known person, one time each, a chain with steps, and a contact on each channel of a step", () => {
    const people = [person(p1), person(p2, [work])];
    const both = [...contacts(p1), ...contacts(p2)];
    const good: AlertConfig["outage"] = { people: [{ person: p1, chain: { steps: [sms, sms, pushover] } }] };
    expect(loadConfig(config({ people, contacts: both, outage: good }), CHANNELS, store).problems).toEqual([]);
    expect(loadConfig(config({ people, contacts: both, outage: { people: [] } }), CHANNELS, store).problems).toEqual([]);
    const fax = "fax" as ChannelId;
    const problems = loadConfig(
      config({
        people,
        contacts: [...contacts(p1), contacts(p2)[0]!],
        outage: {
          people: [
            { person: p1, chain: { steps: [sms, fax, fax] } },
            { person: p1, chain: { steps: [] } },
            { person: p2, chain: { steps: [pushover, sms] } },
            { person: "person-9" as PersonId, chain: { steps: [sms] } },
          ],
        },
      }),
      CHANNELS,
      store,
    ).problems;
    expect(problems).toEqual([
      "The outage chain of the person person-1 uses the channel fax, and the instance has no such channel.",
      "The outage call has the person person-1 two times.",
      "The outage chain of the person person-1 has no step, so no outage call reaches the person.",
      "The outage chain of the person person-2 uses the channel sms, and the person has no contact on it.",
      "The outage call names the person person-9, and the configuration has no such person.",
      "The person person-2: Step 1 of life-safety uses the channel sms, and the person has no address on it.",
    ]);
  });

  it("reads an id or a field such as constructor as a plain key", () => {
    const odd = "constructor" as ChannelId;
    const loaded = loadConfig(config({ contacts: [...contacts(p1), { person: p1, channel: odd, address: { ["__proto__"]: "x", constructor: "y" } }] }), CHANNELS, store);
    expect(loaded.problems).toEqual([]);
    const addresses = loaded.recipients[0]!.addresses;
    expect(Object.keys(addresses)).toEqual(["pushover", "sms", "constructor"]);
    expect(Object.keys(addresses["constructor"]!)).toEqual(["__proto__", "constructor"]);
  });
});

describe("the hash of a configuration", () => {
  it("does not change with the order of the keys, and changes with each value", () => {
    const first = config();
    const reordered = Object.fromEntries(Object.entries(first).reverse()) as unknown as AlertConfig;
    expect(configHash(reordered)).toBe(configHash(first));
    expect(configHash(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(configHash(config({ places: [...PLACES].reverse() }))).not.toBe(configHash(first));
  });

  it("does not change with the order of the keys of a nested object", () => {
    const places = PLACES.map((place) => Object.fromEntries(Object.entries(place).reverse()) as unknown as PlaceConfig);
    expect(configHash(config({ places }))).toBe(configHash(config()));
  });
});

describe("the places of a configuration", () => {
  it("give no label to a source, and a position only to a source of sharePosition", () => {
    expect(sourcePlaces(config(), nws)).toEqual([
      { id: home, codes: PLACES[0]!.codes, bufferKm: 5, at: HOME_AT },
      { id: work, codes: PLACES[1]!.codes, bufferKm: 2 },
    ]);
    expect(sourcePlaces(config(), ipaws)).toEqual([
      { id: home, codes: PLACES[0]!.codes, bufferKm: 5 },
      { id: work, codes: PLACES[1]!.codes, bufferKm: 2 },
    ]);
  });

  it("give each position for the matching on the machine of the instance", () => {
    expect(localPlaces(config()).map((place) => place.at)).toEqual([HOME_AT, PLACES[1]!.at]);
    expect(localPlaces(config()).some((place) => "label" in place || "sharePosition" in place)).toBe(false);
  });

  it("give each label by the node key of its place, for the why line on the machine of the instance", () => {
    const labels = placeLabels(config());
    expect(labels(`place:${home}`)).toBe("Home");
    expect(labels(`place:${work}`)).toBe("Work");
    expect(labels(home)).toBeUndefined();
    expect(labels("ugc:KSC173")).toBeUndefined();
  });

  it("give a position to a source only when the place shares it with that source, over seeded configurations", () => {
    const sources = [nws, ipaws, "news" as SourceId];
    for (const seed of SEEDS) {
      const r = random(`config-places:${seed}`);
      const places: PlaceConfig[] = Array.from({ length: r.int(1, 6) }, (_, index) => ({
        id: `place-${index}` as PlaceId,
        label: `Label ${index}`,
        ...(r.chance(0.8) ? { at: [r.range(-101, -94), r.range(37, 40)] as Position } : {}),
        codes: [{ system: "ugc", code: "KSC173" }],
        bufferKm: r.below(10),
        ...(r.chance(0.6) ? { sharePosition: sources.filter(() => r.chance(0.5)) } : {}),
      }));
      for (const source of sources) {
        sourcePlaces(config({ places }), source).forEach((watched, index) => {
          const place = places[index]!;
          const shared = place.sharePosition?.includes(source) === true && place.at !== undefined;
          expect([watched.id, "at" in watched, "label" in watched], `seed ${seed}, ${source}`).toEqual([place.id, shared, false]);
        });
      }
    }
  });
});

describe("the settings of the expectations", () => {
  const wea: Expectation = { id: "api-to-wea", from: "api" as SourceId, to: "wea" as SourceId, when: { statuses: ["actual"] } };
  const other: Expectation = { ...wea, id: "other" };

  it("puts the since of each entry into the expectation with its id", () => {
    expect(configuredExpectations([wea, other], [{ id: "api-to-wea", since: 5_000 }])).toEqual([{ ...wea, since: 5_000 }, other]);
    expect(configuredExpectations([wea])).toEqual([wea]);
  });

  it("finds an unknown expectation and a since in the future", () => {
    expect(expectationProblems([{ id: "api-to-wea", since: 5_000 }], [wea], 5_000)).toEqual([]);
    expect(expectationProblems([{ id: "x", since: 1 }, { id: "api-to-wea", since: 5_001 }], [wea], 5_000)).toEqual([
      "The configuration sets the expectation x, and the instance has no such expectation.",
      "The since of the expectation api-to-wea is in the future. The check of the source then has no record until that time.",
    ]);
    expect(expectationProblems(undefined, [wea], 0)).toEqual([]);
  });

  it("finds two settings of one expectation at the load", () => {
    const loaded = loadConfig(config({ expectations: [{ id: "api-to-wea", since: 1 }, { id: "api-to-wea", since: 2 }] }), CHANNELS, store);
    expect(loaded.problems).toEqual(["Two settings of expectations have the id api-to-wea."]);
  });
});
