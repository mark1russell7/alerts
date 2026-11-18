/**
 * The reader of the feed catalog of the Mobility Database: the public file `feeds_v2.csv`. The metadata of the catalog is
 * under CC0 1.0. Each feed keeps the terms of its agency.
 *
 * The reader takes each GTFS Realtime feed of service alerts that is active, needs no key and has a box. It does not read
 * the contact column of the catalog. The country of the catalog is wrong for some feeds, so the reader does not use it.
 */

import { areaMeetsPlace, type WatchedPlace } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { parseCsv, type CsvRecord } from "@procedures/json/csv";
import { boxArea, feedProblems, isFeedUrl, type Box, type GtfsFeed } from "./feed.ts";

/** The URL of the catalog. */
export const CATALOG_URL = "https://files.mobilitydatabase.org/feeds_v2.csv";

/** The longest origin: an origin comes from the name of the provider, and a long name gives a long id. */
export const MAX_ORIGIN_LENGTH = 48;

/** The columns that the reader reads. A catalog with no such column gives a problem and no feed. */
export const CATALOG_COLUMNS: readonly string[] = [
  "id",
  "data_type",
  "entity_type",
  "provider",
  "name",
  "urls.direct_download",
  "urls.authentication_type",
  "urls.license",
  "location.bounding_box.minimum_latitude",
  "location.bounding_box.maximum_latitude",
  "location.bounding_box.minimum_longitude",
  "location.bounding_box.maximum_longitude",
  "status",
  "redirect.id",
];

/** One feed of service alerts of the catalog that the reader did not take, with the reason. */
export interface CatalogSkip {
  /** The id of the feed in the catalog. */
  readonly id: string;
  /** The reason, with no URL. */
  readonly reason: string;
}

/** The result of the reader. */
export interface CatalogFeeds {
  /** The config of each feed that the reader took, in the order of the catalog. */
  readonly feeds: readonly GtfsFeed[];
  /** Each feed of service alerts that the reader did not take. */
  readonly skipped: readonly CatalogSkip[];
  /** The problems of the whole catalog: a text that is not CSV, or a missing column. */
  readonly problems: readonly string[];
}

/**
 * This function gives the origin of a feed from the name of its provider: lower-case letters and digits with single
 * hyphens. A name with no Latin letter or digit gives the id of the feed.
 */
export function originOf(provider: string, id: string): string {
  const slug = provider
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_ORIGIN_LENGTH)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? id : slug;
}

/** This function tells if a row of the catalog is a GTFS Realtime feed with service alerts. */
function isAlertFeed(row: CsvRecord): boolean {
  return row["data_type"] === "gtfs_rt" && (row["entity_type"] ?? "").split("|").includes("sa");
}

/** This function gives the box of a row, or `undefined` when the row has no box. */
function boxOf(row: CsvRecord): Box | undefined {
  const values = ["minimum_longitude", "minimum_latitude", "maximum_longitude", "maximum_latitude"].map((key) => (row[`location.bounding_box.${key}`] ?? "").trim());
  if (values.some((value) => value === "")) return undefined;
  const [west, south, east, north] = values.map(Number) as [number, number, number, number];
  return { west, south, east, north };
}

/** This function gives the config of a row, or the reason that the reader does not take the row. */
function feedOf(row: CsvRecord, id: string): GtfsFeed | string {
  const status = (row["status"] ?? "").trim();
  if (status !== "active") return `the status is ${status === "" ? "empty" : JSON.stringify(status)}`;
  const auth = (row["urls.authentication_type"] ?? "").trim();
  if (auth !== "" && auth !== "0") return `the feed needs a key (authentication type ${JSON.stringify(auth)})`;
  const redirect = (row["redirect.id"] ?? "").trim();
  if (redirect !== "") return `the catalog moved the feed to ${JSON.stringify(redirect)}`;
  const box = boxOf(row);
  if (box === undefined) return "the catalog gives no box";
  const provider = (row["provider"] ?? "").replace(/\s+/g, " ").trim();
  const name = (row["name"] ?? "").replace(/\s+/g, " ").trim();
  const title = provider === "" ? (name === "" ? id : name) : provider;
  const license = (row["urls.license"] ?? "").trim();
  const feed: GtfsFeed = {
    id,
    title,
    url: (row["urls.direct_download"] ?? "").trim(),
    origin: originOf(provider === "" ? name : provider, id),
    box,
    // A bad license URL does not stop the feed. The config has no license then.
    ...(license !== "" && isFeedUrl(license) ? { license } : {}),
  };
  const problems = feedProblems(feed);
  return problems.length === 0 ? feed : problems.join(", ");
}

/**
 * This function reads the catalog. It gives the config of each feed that it takes, and the reason for each feed of
 * service alerts that it does not take. It does not throw.
 *
 * - A feed is taken when it is active, needs no key, has no redirect, has a box and passes `feedProblems`.
 * - The second row with the id or the URL of an earlier taken feed is skipped. Thus no URL is read twice.
 * - A text that is not CSV, a text with no rows, or a header with a missing column gives a problem and no feed.
 */
export function catalogFeeds(text: string): CatalogFeeds {
  let rows: CsvRecord[];
  try {
    rows = parseCsv(text, { header: true });
  } catch (error) {
    return { feeds: [], skipped: [], problems: [`the catalog is not CSV: ${errorMessage(error)}`] };
  }
  if (rows.length === 0) return { feeds: [], skipped: [], problems: ["the catalog has no rows"] };
  const header = new Set(Object.keys(rows[0] ?? {}));
  const missing = CATALOG_COLUMNS.filter((column) => !header.has(column));
  if (missing.length > 0) return { feeds: [], skipped: [], problems: [`the catalog has no column ${missing.map((column) => JSON.stringify(column)).join(", ")}`] };
  const feeds: GtfsFeed[] = [];
  const skipped: CatalogSkip[] = [];
  const ids = new Set<string>();
  const urls = new Map<string, string>();
  for (const row of rows) {
    if (!isAlertFeed(row)) continue;
    const id = (row["id"] ?? "").trim();
    const result = feedOf(row, id);
    if (typeof result === "string") {
      skipped.push({ id, reason: result });
      continue;
    }
    const first = urls.get(result.url);
    if (ids.has(id)) skipped.push({ id, reason: "the catalog lists the id again" });
    else if (first !== undefined) skipped.push({ id, reason: `the feed has the URL of ${JSON.stringify(first)}` });
    else {
      ids.add(id);
      urls.set(result.url, id);
      feeds.push(result);
    }
  }
  return { feeds, skipped, problems: [] };
}

/**
 * This function gives the feeds that meet one or more of the places, by the rule of `areaMeetsPlace` of the core. The box
 * of a feed meets a place with a position in the box, or at the buffer of the place or nearer. A place with no position
 * meets no feed.
 */
export function feedsFor(feeds: readonly GtfsFeed[], places: readonly WatchedPlace[]): readonly GtfsFeed[] {
  return feeds.filter((feed) => {
    const area = boxArea(feed.box);
    return places.some((place) => areaMeetsPlace(area, place) === true);
  });
}
