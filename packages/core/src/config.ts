/**
 * This module holds the private configuration of the people and the places. It has the format of
 * the owner, and the load that checks it and makes the recipients. The repository holds no
 * configuration. The functions are pure, and the caller gives the secrets.
 */
import { localTime } from "@mark1russell7/algebra/clock";
import type { Address, ChannelDescriptor, ChannelId, EscalationPolicy, Instant, NodeKey, PersonId, PersonWatch, PlaceId, Position, RegionCode, SourceId, WatchedPlace } from "./contracts.ts";
import { recipientProblems, type Recipient } from "./delivery.ts";
import type { TryChain } from "./chain.ts";
import type { Expectation } from "./lateness.ts";
import type { LinkPolicy } from "./link.ts";
import type { WhyLabels } from "./why.ts";

/** The name of the format of a configuration. A change that breaks a configuration gets a new name. */
export const CONFIG_FORMAT = "alerts-config/1";

/** A reference to a secret: the name of a key in the secret store of the instance. */
export interface SecretRef {
  /** The name of the key, for example `PUSHOVER_USER_KEY`. */
  readonly secret: string;
}

/** A value of an address: the value itself, or a reference to a secret. */
export type AddressValue = string | SecretRef;

/** A place of the configuration. The label and the position stay on the machine of the instance. */
export interface PlaceConfig {
  readonly id: PlaceId;
  /** The name of the place for its people, for example `Home`. No source gets it. */
  readonly label: string;
  /** The position of the place. Only the sources of `sharePosition` get it. */
  readonly at?: Position;
  /** The codes of the regions that contain the place. The core matches an incident to a place by these codes. */
  readonly codes: readonly RegionCode[];
  /** The distance around the place that the system also watches. */
  readonly bufferKm: number;
  /** The sources that get the position of the place. When it is absent, no source gets it. */
  readonly sharePosition?: readonly SourceId[];
}

/** A person of the configuration. */
export interface PersonConfig {
  /** The places, the subjects, the rules and the quiet window of the person. */
  readonly watch: PersonWatch;
  /** The name of the person for the UI. */
  readonly label?: string;
  /** The escalation policies of the person. When it is absent, the policies of the configuration apply. */
  readonly policies?: readonly EscalationPolicy[];
}

/** The address of one person on one channel. */
export interface ContactConfig {
  readonly person: PersonId;
  readonly channel: ChannelId;
  /** The fields of the address that the channel reads, for example `user` for Pushover. */
  readonly address: Readonly<Record<string, AddressValue>>;
}

/**
 * The money rules of one paid provider account: the cap of the spend of its channels, and the floor of its balance.
 * The values are private. Only the configuration holds them.
 */
export interface SpendConfig {
  /** The provider, as an id in the `dependsOn` of its channels: for example `provider:twilio`. */
  readonly provider: string;
  /** The most that the channels of the account spend in one calendar month, in US dollars. */
  readonly monthlyUsd: number;
  /** The last part of the monthly cap that only `life-safety` messages use, in US dollars. The default is 0. */
  readonly reserveUsd?: number;
  /** Below this balance of the account, in the currency of the account, the system reports the line `low`. */
  readonly floor: number;
  /** The time zone of the start of the month, as an IANA name: for example `America/New_York`. */
  readonly timeZone: string;
}

/** One person of the outage call, with the chain of the tries of the person. */
export interface OutagePersonConfig {
  readonly person: PersonId;
  /** The channel of each try, in order. The address of a try is the contact of the person on its channel. */
  readonly chain: TryChain;
}

/**
 * The outage call: the calls to people when the outside check finds the instance down. The provider of
 * the calls makes them, so they work while the instance is down. A deploy copies the list to the provider.
 */
export interface OutageConfig {
  /** The people of the outage call, in the order of the first calls. */
  readonly people: readonly OutagePersonConfig[];
}

/** The private configuration of the people and the places. Each copy of the system loads the same configuration. */
export interface AlertConfig {
  readonly format: typeof CONFIG_FORMAT;
  readonly places: readonly PlaceConfig[];
  readonly people: readonly PersonConfig[];
  readonly contacts: readonly ContactConfig[];
  /** The escalation policies of each person with no policies of their own. */
  readonly policies: readonly EscalationPolicy[];
  /**
   * The contact of the operator of the instance: an `https` URL or a `mailto` URL. Each request to the
   * server of another party gives it in the User-Agent. Without it, the User-Agent has no contact.
   */
  readonly contact?: string;
  /** The settings of the expectations of the instance. Each entry names an expectation by its id. */
  readonly expectations?: readonly ExpectationConfig[];
  /** The money rules of each paid provider account. A provider with no entry has no cap and no watch of its balance. */
  readonly spend?: readonly SpendConfig[];
  /** The policy of the link rule of the merge. Without it, the instance uses `DEFAULT_LINK_POLICY`. */
  readonly link?: LinkPolicy;
  /** The outage call. Without it, an outage of the instance calls no person. */
  readonly outage?: OutageConfig;
}

/** The settings of one expectation of the instance, for example the WEA check of a copy source. */
export interface ExpectationConfig {
  /** The id of the expectation. */
  readonly id: string;
  /** The start of a new record of the checks of the expectation. The value goes into `Expectation.since`. */
  readonly since: Instant;
}

/**
 * This function gives the expectations with the settings of the configuration. The `since` of each
 * entry goes into the expectation with its id. An expectation with no entry stays the same.
 */
export function configuredExpectations(expectations: readonly Expectation[], settings: readonly ExpectationConfig[] = []): Expectation[] {
  const byId = new Map(settings.map((entry) => [entry.id, entry]));
  return expectations.map((expectation) => {
    const entry = byId.get(expectation.id);
    return entry === undefined ? expectation : { ...expectation, since: entry.since };
  });
}

/**
 * This function checks the settings of expectations against the expectations of an instance. It finds
 * an entry with an unknown id, and a `since` after the time `at`. A `since` in the future stops the
 * record until that time, so the source cannot be late.
 */
export function expectationProblems(settings: readonly ExpectationConfig[] | undefined, expectations: readonly Expectation[], at: Instant): string[] {
  const known = new Set(expectations.map((expectation) => expectation.id));
  return (settings ?? []).flatMap((entry) => [
    ...(known.has(entry.id) ? [] : [`The configuration sets the expectation ${entry.id}, and the instance has no such expectation.`]),
    ...(entry.since > at ? [`The since of the expectation ${entry.id} is in the future. The check of the source then has no record until that time.`] : []),
  ]);
}

/** The secret store of the instance. It gives the value of a key, or `undefined` when it has no such key. */
export type SecretLookup = (name: string) => string | undefined;

/** The result of a load. */
export interface LoadedConfig {
  /** The recipient of each person, in the order of the configuration. */
  readonly recipients: readonly Recipient[];
  /**
   * The problems of the configuration. Each problem names ids, fields and the names of secrets, but
   * no value of a secret, no label and no position. The runtime does not start with a problem.
   */
  readonly problems: readonly string[];
}

/**
 * This function checks a configuration and makes the recipient of each person. It finds:
 *
 * - two places or two people with one id, and a place with no region code
 * - a place of a person or of a rule that the configuration or the person does not have
 * - a contact of an unknown person, two contacts of a person on one channel, and a secret that the store does not have
 * - two settings of one expectation
 * - two spend entries of one provider, and a provider that no channel depends on
 * - a reserve of a spend entry that is not below its cap, and a time zone that is not an IANA name
 * - an unknown person of the outage call, a person two times, a chain with no step, and a step on a channel with no contact of the person
 * - each problem of `recipientProblems` for each person.
 */
export function loadConfig(config: AlertConfig, channels: readonly ChannelDescriptor[], secret: SecretLookup): LoadedConfig {
  const problems: string[] = [];
  const places = new Set<string>();
  for (const place of config.places) {
    if (places.has(place.id)) problems.push(`Two places have the id ${place.id}.`);
    places.add(place.id);
    // The core matches by the region codes only, until the home of geography has the tests of shapes.
    if (place.codes.length === 0) problems.push(`The place ${place.id} has no region code, so no incident matches it.`);
  }

  const people = new Set<string>();
  for (const { watch } of config.people) {
    const person = watch.person;
    if (people.has(person)) problems.push(`Two people have the id ${person}.`);
    people.add(person);
    const own = new Set<string>(watch.places);
    for (const place of watch.places) if (!places.has(place)) problems.push(`The person ${person} watches the place ${place}, and the configuration has no such place.`);
    watch.rules.forEach((rule, index) => {
      for (const place of rule.places ?? []) {
        if (!own.has(place)) problems.push(`Rule ${index} of the person ${person} names the place ${place}, and the person does not watch it. The rule matches no incident there.`);
      }
    });
  }

  const expectations = new Set<string>();
  for (const { id } of config.expectations ?? []) {
    if (expectations.has(id)) problems.push(`Two settings of expectations have the id ${id}.`);
    expectations.add(id);
  }

  // Maps, not objects: an id or a field such as `constructor` is then a plain key.
  const addresses = new Map<string, Map<string, Address>>();
  for (const contact of config.contacts) {
    const { person, channel } = contact;
    if (!people.has(person)) {
      problems.push(`A contact on the channel ${channel} is for the person ${person}, and the configuration has no such person.`);
      continue;
    }
    const ofPerson = addresses.get(person) ?? new Map<string, Address>();
    addresses.set(person, ofPerson);
    if (ofPerson.has(channel)) {
      problems.push(`The person ${person} has two contacts on the channel ${channel}.`);
      continue;
    }
    const fields: [string, string][] = [];
    for (const [field, value] of Object.entries(contact.address)) {
      if (typeof value === "string") {
        fields.push([field, value]);
        continue;
      }
      const found = secret(value.secret);
      if (found === undefined || found === "") problems.push(`The field ${field} of the contact of ${person} on ${channel} names the secret ${value.secret}, and the secret store has no value for it.`);
      else fields.push([field, found]);
    }
    ofPerson.set(channel, Object.fromEntries(fields));
  }

  const providers = new Set<string>();
  for (const spend of config.spend ?? []) {
    const { provider } = spend;
    if (providers.has(provider)) problems.push(`Two spend entries are for the provider ${provider}.`);
    providers.add(provider);
    // A typo of a provider gives a cap that no send takes from.
    if (!channels.some((channel) => channel.dependsOn.includes(provider))) problems.push(`The spend entry of ${provider} names a provider that no channel depends on.`);
    if (!((spend.reserveUsd ?? 0) < spend.monthlyUsd)) problems.push(`The reserve of the spend of ${provider} is not below its monthly cap.`);
    if (localTime(0, spend.timeZone) === undefined) problems.push(`The time zone of the spend of ${provider} is not an IANA name.`);
  }

  const called = new Set<string>();
  for (const { person, chain } of config.outage?.people ?? []) {
    if (called.has(person)) problems.push(`The outage call has the person ${person} two times.`);
    called.add(person);
    if (!people.has(person)) {
      problems.push(`The outage call names the person ${person}, and the configuration has no such person.`);
      continue;
    }
    if (chain.steps.length === 0) problems.push(`The outage chain of the person ${person} has no step, so no outage call reaches the person.`);
    for (const channel of new Set(chain.steps)) {
      if (!channels.some((known) => known.id === channel)) problems.push(`The outage chain of the person ${person} uses the channel ${channel}, and the instance has no such channel.`);
      else if (addresses.get(person)?.has(channel) !== true) problems.push(`The outage chain of the person ${person} uses the channel ${channel}, and the person has no contact on it.`);
    }
  }

  const recipients = config.people.map((entry): Recipient => {
    const recipient: Recipient = {
      watch: entry.watch,
      policies: entry.policies ?? config.policies,
      addresses: Object.fromEntries(addresses.get(entry.watch.person) ?? []),
    };
    for (const problem of recipientProblems(recipient, channels)) problems.push(`The person ${entry.watch.person}: ${problem}`);
    return recipient;
  });
  return { recipients, problems };
}

/**
 * This function gives the places of the configuration for the matching on the machine of the
 * instance, with each position. Do not give these places to a source: use `sourcePlaces`.
 */
export function localPlaces(config: AlertConfig): WatchedPlace[] {
  return config.places.map((place) => watchedPlace(place, true));
}

/** This function gives the places of the configuration for one source. A place has a position only when it shares it with that source. */
export function sourcePlaces(config: AlertConfig, source: SourceId): WatchedPlace[] {
  return config.places.map((place) => watchedPlace(place, place.sharePosition?.includes(source) === true));
}

/**
 * This function gives the labels of the places of the configuration, by their node keys `place:<id>`. The labels
 * stay on the machine of the instance: the runtime puts them only in the why line of a message.
 */
export function placeLabels(config: AlertConfig): WhyLabels {
  const labels = new Map<NodeKey, string>(config.places.map((place) => [`place:${place.id}`, place.label]));
  return (node) => labels.get(node);
}

// A watched place has no label. It has the position only when `withPosition` is true.
function watchedPlace(place: PlaceConfig, withPosition: boolean): WatchedPlace {
  return { id: place.id, codes: place.codes, bufferKm: place.bufferKm, ...(withPosition && place.at !== undefined ? { at: place.at } : {}) };
}
