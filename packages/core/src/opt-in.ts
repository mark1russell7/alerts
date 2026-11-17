/**
 * The opt-in list of the alert texts (AL-56). A channel of texts sends only to a number with a record of the list. A STOP
 * reply removes the number, and a START reply puts it back.
 *
 * - The list holds phone numbers. Thus it is in the private configuration, and not in the repository.
 * - The number of a record is a phone number or the name of a secret, as the address of a contact.
 * - The opt-in page of the site gives the consent words of each version, and the form of a record.
 * - A problem of the list names the index of a record, and no number.
 */

import type { AddressValue, SecretLookup } from "./config.ts";
import type { AddressField, ChannelDescriptor, Instant } from "./contracts.ts";

/** The versions of the consent words. The opt-in page of the site gives the words of each version. */
export const OPT_IN_WORDS: readonly string[] = ["texts-consent/1"];

/** The ways of a yes: in writing, or in speech. */
export const OPT_IN_WAYS = ["written", "spoken"] as const;

/** The way of a yes. */
export type OptInWay = (typeof OPT_IN_WAYS)[number];

/** One yes of a person to the alert texts at one phone number: one record of the private opt-in list. */
export interface OptInRecord {
  /** The mobile phone number, in E.164 form. */
  readonly number: string;
  /** The date and the time of the yes in UTC, as an ISO 8601 text with seconds: for example `2026-11-17T21:30:00Z`. */
  readonly at: string;
  /** `written` for a yes in writing, or `spoken` for a yes in speech. */
  readonly way: OptInWay;
  /** The version of the consent words that the person agreed to: one of `OPT_IN_WORDS`. */
  readonly words: string;
}

/** One record of the opt-in list in the configuration. The number is a phone number, or the name of a secret that holds it. */
export interface OptInConfig {
  /** The mobile phone number in E.164 form, or a reference to the secret that holds it. */
  readonly number: AddressValue;
  /** The date and the time of the yes in UTC, as an ISO 8601 text with seconds: for example `2026-11-17T21:30:00Z`. */
  readonly at: string;
  /** `written` for a yes in writing, or `spoken` for a yes in speech. */
  readonly way: OptInWay;
  /** The version of the consent words that the person agreed to: one of `OPT_IN_WORDS`. */
  readonly words: string;
}

/** The opt-in list with the value of each secret, and the problems of the list. */
export interface ResolvedOptIn {
  /** The records with a value for each number, in the order of the list. A record whose secret has no value is not in it. */
  readonly records: readonly OptInRecord[];
  /** The problems of the list. Each problem names the index of a record and the names of secrets, and no number. */
  readonly problems: readonly string[];
}

/**
 * This function gives the value of the number of each record of the opt-in list, from the secret store. Then it
 * checks the list with `optInProblems`.
 */
export function resolveOptIn(list: readonly OptInConfig[], secret: SecretLookup): ResolvedOptIn {
  const problems: string[] = [];
  const resolved = list.map((entry, index): OptInRecord | undefined => {
    if (typeof entry.number === "string") return { ...entry, number: entry.number };
    const found = secret(entry.number.secret);
    if (found !== undefined && found !== "") return { ...entry, number: found };
    problems.push(`Record ${String(index + 1)} of the opt-in list names the secret ${entry.number.secret}, and the secret store has no value for it.`);
    return undefined;
  });
  problems.push(...optInProblems(resolved));
  return { records: resolved.filter((record) => record !== undefined), problems };
}

/** One reply that changes the opt-in of a number. `stop` removes the number, and `start` puts it back. */
export interface OptInChange {
  readonly number: string;
  readonly kind: "stop" | "start";
  readonly at: Instant;
}

/** The E.164 form of a phone number: a plus sign and 8 to 15 digits. The first digit is not 0. */
const E164 = /^\+[1-9]\d{7,14}$/u;

/** The form of a time of a record: a date, a time with seconds, and `Z`. */
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

/**
 * This function gives the time of a record in milliseconds since the epoch. It gives `undefined` when the text is not a
 * UTC time with seconds, or when it names a day that does not exist, as `2026-02-30`.
 */
export function optInTime(record: Pick<OptInRecord, "at">): Instant | undefined {
  if (!UTC_TIME.test(record.at)) return undefined;
  const time = Date.parse(record.at);
  if (!Number.isFinite(time)) return undefined;
  // `Date.parse` moves a day that does not exist to the next month. The text of the time then differs.
  return new Date(time).toISOString() === record.at.replace("Z", ".000Z") ? time : undefined;
}

/**
 * This function gives the problems of an opt-in list. A problem is a number that is not in E.164 form, or a time that
 * is not in UTC. It is also consent words of an unknown version, or two records of one number. A problem names the index
 * of a record, and no number.
 * The function does not examine an `undefined` entry: the record of a secret with no value.
 */
export function optInProblems(records: readonly (OptInRecord | undefined)[]): string[] {
  const problems: string[] = [];
  const first = new Map<string, number>();
  records.forEach((record, index) => {
    if (record === undefined) return;
    const position = index + 1;
    if (!E164.test(record.number)) problems.push(`Record ${position} of the opt-in list has no phone number in E.164 form.`);
    if (optInTime(record) === undefined) problems.push(`Record ${position} of the opt-in list has no time in UTC with seconds, as 2026-11-17T21:30:00Z.`);
    if (!OPT_IN_WORDS.includes(record.words)) problems.push(`Record ${position} of the opt-in list names consent words of an unknown version.`);
    const before = first.get(record.number);
    if (before === undefined) first.set(record.number, position);
    else problems.push(`Records ${before} and ${position} of the opt-in list have the same number.`);
  });
  return problems;
}

/**
 * This function tells if a number has the opt-in at the time `at`. It is a fold of the record of the number and the changes.
 *
 * - A number with no record, or with a record after `at`, has no opt-in. A START reply does not add a number.
 * - Each change of the number from the time of its record to `at` counts. The last change decides.
 * - A STOP and a START at the same time give STOP. The order of the changes in the list does not matter.
 * - A new yes after a STOP is a record with a later time. Then the STOP before it does not count.
 */
export function optedIn(records: readonly OptInRecord[], changes: readonly OptInChange[], number: string, at: Instant): boolean {
  const record = records.find((entry) => entry.number === number);
  const since = record === undefined ? undefined : optInTime(record);
  if (since === undefined || since > at) return false;
  let last: OptInChange | undefined;
  for (const change of changes) {
    if (change.number !== number || change.at < since || change.at > at) continue;
    if (last === undefined || change.at > last.at || (change.at === last.at && change.kind === "stop")) last = change;
  }
  return last?.kind !== "stop";
}

/** This function gives the fields of the address of a channel whose values need a record of the opt-in list. */
export function optInFields(channel: Pick<ChannelDescriptor, "address">): readonly AddressField[] {
  return (channel.address ?? []).filter((field) => field.optIn === true);
}
