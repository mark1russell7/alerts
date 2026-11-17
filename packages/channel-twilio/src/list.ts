/**
 * The list of the outage call from the private configuration. The deploy of the Functions uploads the
 * list as a private asset. The bundles of the Functions do not import this module.
 */

import type { Duration, OutageConfig, Recipient } from "@mark1russell7/alerts";
import { canonicalHash } from "@mark1russell7/rigor-generators";
import { CHANNEL_ID } from "./descriptor.ts";
import { outageListProblems, outageSends, type OutageList, type OutageMonthCap, type OutageTexts } from "./outage.ts";

/** The default message of the outage call. It names no person and no place. */
export const OUTAGE_MESSAGE = "The alert system is down. The outside check gets no sign from it.";

/** The default text message after a chain with no confirmation. It names no person and no place, and it has one segment of GSM-7. */
export const OUTAGE_TEXT_MESSAGE = "The alert system is down. The outside check gets no sign from it. The outage calls to this phone got no confirmation.";

/** The default count of the times that an outage call says the message. */
export const OUTAGE_REPEATS = 3;

/** The default seconds that a phone rings before the outage call ends with no answer. */
export const OUTAGE_RING_SECONDS = 45;

/** The default time of the cap of the calls. */
export const OUTAGE_CAP_WINDOW: Duration = 60 * 60_000;

/** The count of the full outages in the time of the default cap. A down and up again of the instance is a new outage. */
export const OUTAGE_CAP_OUTAGES = 2;

/** The count of the characters of the hash in the version of a list. */
const VERSION_LENGTH = 16;

/** The options of the list. Each absent option takes its default. */
export interface OutageListOptions {
  readonly message?: string;
  readonly repeats?: number;
  readonly ringSeconds?: number;
  /** The most calls in the time `capWindow`. The default is the calls and the texts of `OUTAGE_CAP_OUTAGES` full outages. */
  readonly maxCalls?: number;
  readonly capWindow?: Duration;
  readonly voice?: string;
  readonly language?: string;
  readonly texts?: Partial<OutageTexts>;
  /** The text message after a chain with no confirmation, for example `OUTAGE_TEXT_MESSAGE`. Without it, the list has no text. */
  readonly textMessage?: string;
}

/** The list of the outage call, and the problems that stop its deploy. */
export interface OutageListResult {
  readonly list: OutageList;
  /** Each problem of the list. A problem names a person or a field, and no number. */
  readonly problems: readonly string[];
}

/**
 * This function gives the list of the outage call from the configuration and the recipients of `loadConfig`.
 *
 * - The number of each person is the address `to` of the person on the channel of the calls.
 * - The monthly cap `month` comes from the cap of the spend of Twilio. The list has no default for it.
 * - The version is the start of the content hash of the rest of the list. Thus a change of the list gives a new version.
 * - The problems are the problems of `outageListProblems`, and a person with no recipient.
 *
 * The list holds the phone numbers. Do not log it, and keep its version out of public text.
 */
export function outageListOf(outage: OutageConfig, recipients: readonly Recipient[], month: OutageMonthCap, options: OutageListOptions = {}): OutageListResult {
  const problems: string[] = [];
  const byPerson = new Map(recipients.map((recipient) => [recipient.watch.person, recipient] as const));
  const people = outage.people.map(({ person, chain }) => {
    const recipient = byPerson.get(person);
    if (recipient === undefined) problems.push(`The outage call names the person ${person}, and no recipient has that id.`);
    return { person, to: recipient?.addresses[CHANNEL_ID]?.["to"] ?? "", chain: { steps: [...chain.steps] } };
  });
  const perOutage = outageSends({ people, ...(options.textMessage === undefined ? {} : { textMessage: options.textMessage }) });
  const content = {
    message: options.message ?? OUTAGE_MESSAGE,
    people,
    repeats: options.repeats ?? OUTAGE_REPEATS,
    ringSeconds: options.ringSeconds ?? OUTAGE_RING_SECONDS,
    maxCalls: options.maxCalls ?? Math.max(1, OUTAGE_CAP_OUTAGES * perOutage),
    capWindow: options.capWindow ?? OUTAGE_CAP_WINDOW,
    month: { maxCalls: month.maxCalls, timeZone: month.timeZone },
    ...(options.textMessage === undefined ? {} : { textMessage: options.textMessage }),
    ...(options.voice === undefined ? {} : { voice: options.voice }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.texts === undefined ? {} : { texts: options.texts }),
  };
  const list: OutageList = { version: canonicalHash(content, { form: "json" }).slice(0, VERSION_LENGTH), ...content };
  problems.push(...outageListProblems(list));
  return { list, problems };
}
