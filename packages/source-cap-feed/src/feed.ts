/**
 * The config of one CAP feed: the URL of its index, the authority of its messages, and the facts of the source. The
 * private config of an instance names each feed. The WMO Register of Alerting Authorities gives the feeds of the world.
 */

import type { Duration, SourceId } from "@mark1russell7/alerts";

/** The config of one CAP feed. */
export interface CapFeed {
  /** The id of the source of the feed, for example `cap-feed-nu`. */
  readonly id: SourceId;
  /** The plain name of the feed, for example `Niue Meteorological Service`. */
  readonly title: string;
  /** The URL of the index of the feed, an RSS 2.0 or Atom 1.0 document. It starts with `https:`. */
  readonly url: string;
  /** The authority of the messages: the origin of each report, for example `nu-met`. */
  readonly origin: string;
  /** The ISO 3166 codes of the countries and the parts of countries that the feed covers, for example `NU`. */
  readonly coverage: readonly string[];
  /** The prefixes of the taxonomy codes that the feed covers, for example `met`. */
  readonly kinds: readonly string[];
  /** The failure domains outside the cell, with their prefixes, for example `provider:dwd` and `cdn:akamai`. */
  readonly dependsOn: readonly string[];
  /** The languages in the order of choice. The default is `DEFAULT_LANGUAGES` of format-cap. */
  readonly languages?: readonly string[];
  /** True: the shapes of an area element decide for it, with the path of the element as its key. The default is false. */
  readonly keyed?: boolean;
  /** `snapshot`: the index lists only the messages in effect. Absent: a stream. A message stays until its cancel or its end. */
  readonly listing?: "snapshot";
  /** The time between two fetches. The default is `DEFAULT_INTERVAL`. */
  readonly interval?: Duration;
  /** The longest normal time of one fetch. The default is `DEFAULT_SLOW_AFTER`. */
  readonly slowAfter?: Duration;
  /**
   * The other bases of the links to messages, for example `https://alerts.example.org`. A link to a message is on the
   * base of the index or on one of these bases. The fetch does not follow a link to another base.
   */
  readonly messageBases?: readonly string[];
  /** The most messages that one fetch asks for. The default is `DEFAULT_PER_FETCH`. */
  readonly perFetch?: number;
}

/** The default time between two fetches of a feed: one minute. */
export const DEFAULT_INTERVAL: Duration = 60_000;

/** The default longest normal time of one fetch: the index and ten messages, one second apart, with a margin. */
export const DEFAULT_SLOW_AFTER: Duration = 30_000;

/** The default count of messages that one fetch asks for. The other new messages wait for the next fetch. */
export const DEFAULT_PER_FETCH = 10;

/** This function gives the base of a URL (its scheme, host and port), or `undefined` for a URL that is not `https:`. */
export function httpsBase(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" ? parsed.origin : undefined;
}

/** This function examines the config of a feed. It gives one text for each problem, and an empty list for a good config. A text holds no URL. */
export function feedProblems(feed: CapFeed): readonly string[] {
  const problems: string[] = [];
  if (feed.id.trim() === "") problems.push("the id is empty");
  if (feed.title.trim() === "") problems.push("the title is empty");
  if (httpsBase(feed.url) === undefined) problems.push("the URL of the index is not an https URL with no user");
  if (feed.origin.trim() === "") problems.push("the origin is empty");
  if (feed.coverage.length === 0) problems.push("the coverage is empty");
  for (const code of feed.coverage) if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(code)) problems.push(`the coverage code ${code} is not an ISO 3166 code`);
  if (feed.kinds.length === 0) problems.push("the list of kinds is empty");
  // A problem text holds no URL of the config: a URL can hold a password.
  (feed.messageBases ?? []).forEach((base, index) => {
    if (httpsBase(base) !== base) problems.push(`the message base ${String(index)} is not the base of an https URL with no user, for example https://alerts.example.org`);
  });
  const perFetch = feed.perFetch ?? DEFAULT_PER_FETCH;
  if (!Number.isInteger(perFetch) || perFetch < 1) problems.push(`the count of messages for each fetch is not an integer of 1 or more: ${String(perFetch)}`);
  return problems;
}
