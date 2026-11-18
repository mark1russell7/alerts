/**
 * The facts of the RSS feed of the AWS Health Dashboard. The dashboard gives this feed for subscriptions. The feed holds
 * each update of each event that has not ended, and an event that ends leaves the feed. The host has no `robots.txt`
 * file.
 */

import type { Duration, SourceId, SubjectSystem } from "@mark1russell7/alerts";

/** The id of the source. */
export const AWS_SOURCE = "aws-health" as SourceId;

/** The origin of each report: the provider. */
export const AWS_ORIGIN = "aws";

/** The base of the status host. */
export const AWS_BASE = "https://status.aws.amazon.com";

/** The path of the feed of all the services. */
export const FEED_PATH = "/rss/all.rss";

/** The kind of each report: a failure of a public cloud region or service. */
export const AWS_KIND = "infra.cloud.outage";

/** The failure domain of the feed. AWS hosts the feed, so a wide failure of the cloud can stop it. */
export const AWS_PROVIDER = "provider:aws";

/** The time between two fetches: the `ttl` of the feed, 5 minutes. A conditional GET of an unchanged feed gives a 304. */
export const AWS_INTERVAL: Duration = 300_000;

/** The longest normal time of one fetch. The feed had 56 kB on 2026-11-18. */
export const AWS_SLOW_AFTER: Duration = 15_000;

/** The domain of the service. The subject `domain:aws.amazon.com` goes to a person who names the service. */
export const AWS_DOMAIN = "aws.amazon.com";

/** The system of the subject of the service. */
export const DOMAIN_SYSTEM: SubjectSystem = "domain";

/** The system of the subject of the region of an event. Its id is the provider, a slash and the code of the region. */
export const REGION_SYSTEM: SubjectSystem = "provider-region";

/** The provider part of the id of each region. */
export const REGION_PROVIDER = "aws";

/**
 * The pattern of the `guid` of an item. The `guid` is the URL of the dashboard, `#`, the key of the service, `_` and
 * the time of the item in seconds. The key of the service ends with the code of the region, if the service has a region.
 */
export const GUID_PATTERN: RegExp = /#([^#\s]+)_([0-9]+)$/;

/** The pattern of the code of a region at the end of the key of a service: `me-central-1` or `us-gov-east-1`. */
export const REGION_PATTERN: RegExp = /-([a-z]{2}(?:-gov)?-[a-z]+-[0-9]+)$/;

/** This function gives the id of the subject of one region of AWS: `aws/` and the code of the region. */
export function regionId(region: string): string {
  return `${REGION_PROVIDER}/${region}`;
}

/** The service and the region of the key of a service. A global service, for example `cloudfront`, has no region. */
export interface ServiceKey {
  readonly service: string;
  readonly region?: string;
}

/** This function splits the key of a service into the service and the code of its region. */
export function serviceOf(key: string): ServiceKey {
  const match = REGION_PATTERN.exec(key);
  return match === null || match.index === 0 ? { service: key } : { service: key.slice(0, match.index), region: match[1]! };
}

/** The key of the service and the time in seconds of one item, from its `guid`. A `guid` of another form gives `undefined`. */
export function guidOf(guid: string | undefined): { readonly key: string; readonly seconds: number } | undefined {
  const match = guid === undefined ? null : GUID_PATTERN.exec(guid);
  return match === null ? undefined : { key: match[1]!, seconds: Number(match[2]) };
}
