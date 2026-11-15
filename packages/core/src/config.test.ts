import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { CONFIG_FORMAT, loadConfig, localPlaces, sourcePlaces, type AlertConfig, type ContactConfig, type PersonConfig, type PlaceConfig, type SecretLookup } from "./config.ts";
import type { ChannelDescriptor, ChannelId, EscalationPolicy, PersonId, PlaceId, Position, SourceId } from "./contracts.ts";

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

function channel(id: ChannelId): ChannelDescriptor {
  return { id, title: id, dependsOn: [], uses: ["internet"], breaksThrough: true, repeats: false, ack: "none", maxTitle: 250, maxBody: 1024 };
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

  it("reads an id or a field such as constructor as a plain key", () => {
    const odd = "constructor" as ChannelId;
    const loaded = loadConfig(config({ contacts: [...contacts(p1), { person: p1, channel: odd, address: { ["__proto__"]: "x", constructor: "y" } }] }), CHANNELS, store);
    expect(loaded.problems).toEqual([]);
    const addresses = loaded.recipients[0]!.addresses;
    expect(Object.keys(addresses)).toEqual(["pushover", "sms", "constructor"]);
    expect(Object.keys(addresses["constructor"]!)).toEqual(["__proto__", "constructor"]);
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
