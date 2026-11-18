/**
 * The config of one status page: its base URL, its service, the kind of its reports and the facts of its source. The
 * register of this package names well-known pages. The config of an instance can name other pages.
 */

import { knownKind, type Duration, type SourceId } from "@mark1russell7/alerts";

/** The config of one status page. */
export interface StatusPage {
  /** The id of the source of the page, for example `statuspage-github`. */
  readonly id: SourceId;
  /** The plain name of the service, for example `GitHub`. */
  readonly title: string;
  /** The base URL of the page: `https:`, a host and no path, for example `https://www.githubstatus.com`. */
  readonly base: string;
  /** The company of the service: the origin of each report, for example `github`. */
  readonly origin: string;
  /** The main domain of the service, for example `github.com`. Each report names it as its subject. */
  readonly domain: string;
  /** The taxonomy code of each report of the page, for example `infra.saas.outage`. */
  readonly kind: string;
  /** The failure domains outside the cell, with their prefixes, for example `provider:atlassian-statuspage`. */
  readonly dependsOn: readonly string[];
  /** The time between two fetches. The default is `DEFAULT_INTERVAL`. */
  readonly interval?: Duration;
  /** The longest normal time of one fetch. The default is `DEFAULT_SLOW_AFTER`. */
  readonly slowAfter?: Duration;
}

/** The default time between two fetches of a page: two minutes. The pages of Statuspage keep an answer in a cache for 10 seconds. */
export const DEFAULT_INTERVAL: Duration = 120_000;

/** The default longest normal time of one fetch. The summary of a large page is 230 KB. */
export const DEFAULT_SLOW_AFTER: Duration = 15_000;

/** The system of the subjects of each report: a service, with its domain as its id. */
export const SERVICE_SYSTEM = "service";

/**
 * This function tells if a URL is a base URL of a page. A base URL has `https:` and a host. It has no user, port, path,
 * query or fragment.
 */
export function isPageBase(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.port === "" && parsed.origin === url;
}

/** This function tells if a text is a domain name in lower case, with two or more labels, for example `github.com`. */
export function isDomain(text: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text);
}

/** This function examines the config of a page. It gives one text for each problem, and an empty list for a good config. A text holds no URL. */
export function pageProblems(page: StatusPage): readonly string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(page.id)) problems.push("the id is not lower-case letters, digits and hyphens");
  if (page.title.trim() === "") problems.push("the title is empty");
  // A problem text holds no URL of the config: a URL can hold a password.
  if (!isPageBase(page.base)) problems.push("the base is not an https URL with only a host, for example https://status.example.com");
  if (page.origin.trim() === "") problems.push("the origin is empty");
  if (!isDomain(page.domain)) problems.push(`the domain ${JSON.stringify(page.domain)} is not a domain name in lower case`);
  if (!knownKind(page.kind)) problems.push(`the kind ${JSON.stringify(page.kind)} is not a code of the taxonomy`);
  if (page.dependsOn.length === 0) problems.push("the list of failure domains is empty");
  for (const domain of page.dependsOn) if (!/^[a-z]+:[a-z0-9.-]+$/.test(domain)) problems.push(`the failure domain ${JSON.stringify(domain)} is not a kind, a colon and an id`);
  for (const [name, value] of [
    ["interval", page.interval],
    ["slowAfter", page.slowAfter],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1000)) problems.push(`the ${name} is not an integer of 1000 or more milliseconds: ${String(value)}`);
  }
  return problems;
}
