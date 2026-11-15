/**
 * This module holds the private configuration of the people and the places. It has the format of
 * the owner, and the load that checks it and makes the recipients. The repository holds no
 * configuration. The functions are pure, and the caller gives the secrets.
 */
import type { Address, ChannelDescriptor, ChannelId, EscalationPolicy, NodeKey, PersonId, PersonWatch, PlaceId, Position, RegionCode, SourceId, WatchedPlace } from "./contracts.ts";
import { recipientProblems, type Recipient } from "./delivery.ts";
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
