/**
 * The facts of the RSS feed of Azure Status. The status page of Azure links this feed. The page tells only of widespread
 * incidents. The feed holds one item for each incident that has not ended, and an incident that ends leaves the feed.
 * The feed host has no `robots.txt` file.
 */

import type { Duration, SourceId, SubjectSystem } from "@mark1russell7/alerts";

/** The id of the source. */
export const AZURE_SOURCE = "azure-status" as SourceId;

/** The origin of each report: the issuer, Microsoft. */
export const AZURE_ORIGIN = "microsoft";

/** The base of the feed host, as the status page links it. */
export const AZURE_BASE = "https://rssfeed.azure.status.microsoft";

/** The path of the feed in English. */
export const FEED_PATH = "/en-us/status/feed/";

/** The status page of Azure for a person. */
export const AZURE_PAGE = "https://azure.status.microsoft/en-us/status";

/** The kind of each report: a failure of a public cloud region or service. */
export const AZURE_KIND = "infra.cloud.outage";

/** The failure domain of the feed. Microsoft hosts the feed, so a wide failure of the cloud can stop it. */
export const AZURE_PROVIDER = "provider:azure";

/** The content network in front of the feed host. A DNS lookup on 2026-11-18 gave canonical names of Akamai. */
export const AZURE_CDN = "cdn:akamai";

/** The time between two fetches: 5 minutes. The feed host sends no `ETag`, so each fetch gets the whole feed. */
export const AZURE_INTERVAL: Duration = 300_000;

/** The longest normal time of one fetch. The feed with no incident had 577 bytes on 2026-11-18. */
export const AZURE_SLOW_AFTER: Duration = 15_000;

/** The domain of the service. The subject `domain:azure.microsoft.com` goes to a person who names the service. */
export const AZURE_DOMAIN = "azure.microsoft.com";

/** The system of the subject of the service. */
export const DOMAIN_SYSTEM: SubjectSystem = "domain";

/** The system of the subject of a region of an incident. Its id is the provider, a slash and the name of the region. */
export const REGION_SYSTEM: SubjectSystem = "provider-region";

/** The provider part of the id of each region. */
export const REGION_PROVIDER = "azure";

/**
 * The regions of Azure for each geography, as the names of the status page on 2026-11-18. The categories of an item mix
 * these names with the names of services. A region that is not in this list reads as a service.
 */
export const AZURE_REGIONS: Readonly<Record<string, readonly string[]>> = {
  Americas: ["East US", "East US 2", "East US 3", "Central US", "North Central US", "South Central US", "West Central US", "West US", "West US 2", "West US 3", "Canada East", "Canada Central", "Brazil South", "Brazil Southeast", "Mexico Central", "Chile Central"],
  Europe: [
    "North Europe",
    "West Europe",
    "France Central",
    "France South",
    "UK West",
    "UK South",
    "Switzerland North",
    "Switzerland West",
    "Norway East",
    "Norway West",
    "Germany North",
    "Germany West Central",
    "Sweden Central",
    "Sweden South",
    "Poland Central",
    "Italy North",
    "Spain Central",
    "Austria East",
    "Belgium Central",
    "Denmark East",
  ],
  "Asia Pacific": [
    "Southeast Asia",
    "Southeast Asia 3",
    "East Asia",
    "Australia East",
    "Australia Southeast",
    "Australia Central",
    "Australia Central 2",
    "Central India",
    "West India",
    "South India",
    "Japan East",
    "Japan West",
    "Korea Central",
    "Korea South",
    "New Zealand North",
    "Indonesia Central",
    "Malaysia West",
    "Taiwan North",
    "India South Central",
  ],
  "Middle East and Africa": ["South Africa West", "South Africa North", "UAE Central", "UAE North", "Qatar Central", "Israel Central", "Saudi Arabia East"],
  "Azure Government": ["US Gov Virginia", "US Gov Arizona", "US Gov Texas", "US DoD East", "US DoD Central"],
  "Azure China": ["China East", "China East 2", "China North", "China North 2", "China North 3"],
  Jio: ["Jio India West", "Jio India Central"],
};

/** The names of all the regions of `AZURE_REGIONS`. */
const REGION_NAMES: ReadonlySet<string> = new Set(Object.values(AZURE_REGIONS).flat());

/**
 * This function gives the id of the subject of one region of Azure. The id is `azure/` and the name of the region in
 * lower case with no spaces. This is the rule of the programmatic names of Azure, for example `azure/westeurope`.
 */
export function regionId(name: string): string {
  return `${REGION_PROVIDER}/${name.toLowerCase().replace(/\s+/g, "")}`;
}

/** This function tells if a category names a region of `AZURE_REGIONS`. */
export function isRegion(category: string): boolean {
  return REGION_NAMES.has(category);
}

/**
 * This function tells if a category tells of the services with no region, for example `Public Non-Regional` or
 * `US Gov Non-Regional`. Such a category gives no region and no service.
 */
export function isNonRegional(category: string): boolean {
  return /(^|\s)Non-Regional$/.test(category);
}

/** The regions and the services of the categories of an item, each in the order of the item. */
export interface Categories {
  readonly regions: readonly string[];
  readonly services: readonly string[];
}

/** This function splits the categories of an item into the names of its regions and the names of its services. */
export function categoriesOf(categories: readonly string[]): Categories {
  const named = [...new Set(categories)].filter((category) => !isNonRegional(category));
  return { regions: named.filter(isRegion), services: named.filter((category) => !isRegion(category)) };
}
