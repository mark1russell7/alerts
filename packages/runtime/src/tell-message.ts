/**
 * This module makes one message from the operator of the system to the people who operate it, on Pushover (AL-92).
 * The command `tell.ts` sends it. The message goes outside the pipeline of events.
 *
 * This path is a stopgap. It has no throttle, no daily cap and no check for a repeated message. Thus it sends to one person only. Its end is
 * the intake of events in the running runtime (AL-92, the second step). Then each message is an event of a named
 * class, and the policies of the person route it.
 *
 * - The people who operate the system watch each source: their subjects have the watch `{ system: "alerts.source" }`.
 * - In the quiet window of the person, the message goes in the silent mode of the channel, as the escalation does it.
 */
import { CHANNEL_ID } from "@mark1russell7/alerts-channel-pushover";
import {
  inQuietWindow,
  matchSubjects,
  messageKey,
  reportId,
  type Address,
  type Instant,
  type Message,
  type PersonId,
  type Recipient,
  type SourceId,
  type Subject,
} from "@mark1russell7/alerts";

/** The source of each message of the operator, in the id of its report. */
export const TELL_SOURCE = "tell" as SourceId;

/** The subject of a message of the operator. A watch of each source matches it, and a watch of one other source does not. */
export const TELL_SUBJECT: Subject = { system: "alerts.source", id: "tell" };

/** The text of one message of the operator. */
export interface TellInput {
  readonly title: string;
  readonly body: string;
  readonly url?: string | undefined;
}

/** One person who gets the message: the person, the address on Pushover and the silent mode at the time of the send. */
export interface TellTarget {
  readonly person: PersonId;
  readonly address: Address;
  readonly quiet: boolean;
}

/** This function gives each person who operates the system and has a contact on Pushover, in the order of the configuration. */
export function tellTargets(recipients: readonly Recipient[], at: Instant): readonly TellTarget[] {
  return recipients.flatMap((recipient): TellTarget[] => {
    const address = recipient.addresses[CHANNEL_ID];
    if (address === undefined || matchSubjects({ about: [TELL_SUBJECT] }, recipient.watch.subjects ?? []).length === 0) return [];
    return [{ person: recipient.watch.person, address, quiet: inQuietWindow(recipient.watch.quiet, at) }];
  });
}

/**
 * This function gives the message to one person at the level `notice`. Each send time gives a new report id, thus a
 * new key. The message expires after one day.
 */
export function tellMessage(input: TellInput, target: TellTarget, at: Instant): Message {
  const incident = reportId({ source: TELL_SOURCE, key: input.title, sent: at });
  return {
    key: messageKey({ incident, level: "notice", person: target.person, step: 0 }),
    person: target.person,
    level: "notice",
    title: input.title,
    body: input.body,
    ...(input.url === undefined ? {} : { url: input.url }),
    incident,
    expires: at + DAY_MS,
    quiet: target.quiet,
  };
}

const DAY_MS = 24 * 60 * 60_000;

/** This function gives the problem of a link, or undefined. A link is an absolute URL with the scheme `https` or `http`. */
export function linkProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The link is not an absolute URL.";
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? undefined : "The link does not start with https: or http:.";
}
