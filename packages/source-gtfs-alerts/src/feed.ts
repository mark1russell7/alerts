/**
 * The config of one GTFS Realtime feed of service alerts: its URL, its agency, its country and the box of its network.
 * The catalog of the Mobility Database lists the public feeds. The config of an instance names the feeds that it reads.
 */

import type { Area, Duration, SourceId } from "@mark1russell7/alerts";

/** The box of the network of an agency, in degrees: the lowest and the highest longitude and latitude of its stops. */
export interface Box {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/** The config of one feed of service alerts. */
export interface GtfsFeed {
  /** The id of the feed in the catalog of the Mobility Database, for example `mdb-1967`. */
  readonly id: string;
  /** The plain name of the agency, for example `ZDiTM Szczecin`. Each headline starts with it. */
  readonly title: string;
  /** The URL of the feed: `https:` or `http:`, with no user, password or fragment. */
  readonly url: string;
  /** The agency: the origin of each report, in lower case with hyphens, for example `zditm-szczecin`. */
  readonly origin: string;
  /** The country of the agency: a code of ISO 3166-1 alpha-2 in upper case, for example `PL`. It is the area of each reading. */
  readonly country: string;
  /**
   * The box of the network, from the static GTFS feed of the agency or from the catalog. It is the area of each report. A
   * report needs an area, and the country is too wide for one network, so the box is necessary.
   */
  readonly box: Box;
  /** The URL of the license of the feed, as the catalog gives it. */
  readonly license?: string;
  /** The time between two fetches. The default is `DEFAULT_INTERVAL`. */
  readonly interval?: Duration;
}

/**
 * The default time between two fetches of a feed: 5 minutes. A feed of service alerts changes slowly. The feeds of the
 * agencies refresh each 30 seconds or more.
 */
export const DEFAULT_INTERVAL: Duration = 5 * 60_000;

/** The start of the id of the source of each feed. */
export const SOURCE_PREFIX = "gtfs-";

/** The form of the id of a feed: lower-case letters and digits, with single hyphens between them. */
export const FEED_ID_PATTERN: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** This function gives the id of the source of a feed, for example `gtfs-mdb-1967`. */
export function sourceIdOf(feed: Pick<GtfsFeed, "id">): SourceId {
  return `${SOURCE_PREFIX}${feed.id}` as SourceId;
}

/** This function gives the time between two fetches of a feed. */
export function intervalOf(feed: Pick<GtfsFeed, "interval">): Duration {
  return feed.interval ?? DEFAULT_INTERVAL;
}

/** This function gives the polygon of a box: one ring from the south-west corner, counterclockwise, that closes on its first position. */
export function boxArea(box: Box): Area {
  const { west, south, east, north } = box;
  return {
    type: "polygon",
    rings: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

/** This function tells if a text is the URL of a feed: `https:` or `http:`, a host, and no user, password or fragment. */
export function isFeedUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname !== "" && parsed.username === "" && parsed.password === "" && parsed.hash === "";
}

/** This function gives the problem of a box, or `undefined` for a good box. A box across the antimeridian is a problem. */
function boxProblem(box: Box): string | undefined {
  const values = [box.west, box.south, box.east, box.north];
  if (!values.every(Number.isFinite)) return "the box has a value that is not a finite number";
  if (box.west < -180 || box.east > 180 || box.south < -90 || box.north > 90) return "the box is not in the range of longitudes and latitudes";
  if (box.west >= box.east || box.south >= box.north) return "the box has no area, or it crosses the antimeridian";
  return undefined;
}

/** This function examines the config of a feed. It gives one text for each problem, and an empty list for a good config. A text holds no URL. */
export function feedProblems(feed: GtfsFeed): readonly string[] {
  const problems: string[] = [];
  if (!FEED_ID_PATTERN.test(feed.id)) problems.push("the id is not lower-case letters and digits with single hyphens");
  if (feed.title.trim() === "") problems.push("the title is empty");
  // A problem text holds no URL of the config: a URL can hold a key.
  if (!isFeedUrl(feed.url)) problems.push("the URL is not an https or http URL with a host and no user, password or fragment");
  if (!FEED_ID_PATTERN.test(feed.origin)) problems.push("the origin is not lower-case letters and digits with single hyphens");
  if (!/^[A-Z]{2}$/.test(feed.country)) problems.push(`the country ${JSON.stringify(feed.country)} is not a code of two upper-case letters`);
  const problem = boxProblem(feed.box);
  if (problem !== undefined) problems.push(problem);
  if (feed.license !== undefined && !isFeedUrl(feed.license)) problems.push("the license is not an https or http URL");
  if (feed.interval !== undefined && (!Number.isInteger(feed.interval) || feed.interval < 60_000)) problems.push(`the interval is not an integer of 60000 or more milliseconds: ${String(feed.interval)}`);
  return problems;
}
