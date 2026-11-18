import { readFileSync } from "node:fs";
import type { PlaceId, WatchedPlace } from "@mark1russell7/alerts";
import { parseCsv, stringifyCsv } from "@procedures/json/csv";
import { describe, expect, it } from "vitest";
import { CATALOG_COLUMNS, catalogFeeds, feedsFor, MAX_ORIGIN_LENGTH, originOf } from "./catalog.ts";
import { feedProblems } from "./feed.ts";

// Thirteen real rows of the catalog of 2026-11-17 (CC0 1.0), with the contact column empty.
const CATALOG = readFileSync(new URL("../fixtures/mobility-database-20261117.csv", import.meta.url), "utf8");
const TABLE: string[][] = parseCsv(CATALOG);
const HEADER = TABLE[0] ?? [];

/** This helper gives the catalog with the rows of `extra` after the rows of the fixture. A row is a map from column to value. */
function withRows(...extra: readonly Readonly<Record<string, string>>[]): string {
  const rows = extra.map((row) => HEADER.map((column) => row[column] ?? ""));
  return stringifyCsv([...TABLE, ...rows]);
}

/** This helper gives a good row of a feed of service alerts with the changes of `change`. */
function row(change: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    id: "mdb-9001",
    data_type: "gtfs_rt",
    entity_type: "sa",
    provider: "Example Transit",
    "urls.direct_download": "https://transit.example.test/alerts.pb",
    "urls.authentication_type": "0",
    "location.bounding_box.minimum_latitude": "10",
    "location.bounding_box.maximum_latitude": "11",
    "location.bounding_box.minimum_longitude": "20",
    "location.bounding_box.maximum_longitude": "21",
    status: "active",
    ...change,
  };
}

const place = (id: string, at: readonly [number, number], bufferKm = 0): WatchedPlace => ({ id: id as PlaceId, codes: [], at, bufferKm });

describe("catalogFeeds", () => {
  it("takes each open, active feed of service alerts with a box, and gives the reason for each other one", () => {
    const result = catalogFeeds(CATALOG);
    expect(result.problems).toEqual([]);
    expect(result.feeds.map((feed) => feed.id)).toEqual(["mdb-1967", "mdb-1799", "mdb-2380", "jbda-chitacity-chita-aiaibus-sa", "mdb-1841", "mdb-1423", "mdb-2344"]);
    expect(result.skipped).toEqual([
      { id: "tdg-8118", reason: 'the status is "deprecated"' },
      { id: "mdb-1367", reason: 'the feed needs a key (authentication type "1")' },
      { id: "mdb-1374", reason: 'the feed needs a key (authentication type "2")' },
      { id: "mdb-1565", reason: "the catalog gives no box" },
    ]);
    for (const feed of result.feeds) expect(feedProblems(feed)).toEqual([]);
  });

  it("gives the config of a feed from its row, with the box of the catalog and no country", () => {
    const ruter = catalogFeeds(CATALOG).feeds.find((feed) => feed.id === "mdb-1799");
    // The catalog gives the country CZ for this feed of Oslo. The config has no country.
    expect(ruter).toEqual({
      id: "mdb-1799",
      title: "Oslo region (Ruter)",
      url: "https://api.entur.io/realtime/v1/gtfs-rt/alerts?datasource=RUT",
      origin: "oslo-region-ruter",
      box: { west: 4.51278, south: 47.263266, east: 31.11253, north: 78.246751 },
      license: "https://data.norge.no/nlod/en/",
    });
  });

  it("does not read the contact column", () => {
    const text = withRows(row({ feed_contact_email: "someone@transit.example.test" }));
    const result = catalogFeeds(text);
    expect(result.feeds.map((feed) => feed.id)).toContain("mdb-9001");
    expect(JSON.stringify(result)).not.toContain("someone@");
  });

  it("skips the second row with the id or the URL of a taken feed, so no URL is read twice", () => {
    const result = catalogFeeds(withRows(row(), row({ "urls.direct_download": "https://transit.example.test/other.pb" }), row({ id: "mdb-9002" })));
    expect(result.feeds.filter((feed) => feed.id === "mdb-9001")).toHaveLength(1);
    expect(result.skipped.slice(-2)).toEqual([
      { id: "mdb-9001", reason: "the catalog lists the id again" },
      { id: "mdb-9002", reason: 'the feed has the URL of "mdb-9001"' },
    ]);
  });

  it("skips a moved feed and a feed with a bad box or URL, with no URL in the reason", () => {
    const result = catalogFeeds(
      withRows(
        row({ id: "mdb-9003", "redirect.id": "mdb-9004" }),
        row({ id: "mdb-9005", "location.bounding_box.minimum_longitude": "22" }),
        row({ id: "mdb-9006", "urls.direct_download": "https://user:secret@transit.example.test/x.pb" }),
        row({ id: "mdb-9007", status: "" }),
      ),
    );
    expect(result.skipped.slice(-4)).toEqual([
      { id: "mdb-9003", reason: 'the catalog moved the feed to "mdb-9004"' },
      { id: "mdb-9005", reason: "the box has no area, or it crosses the antimeridian" },
      { id: "mdb-9006", reason: "the URL is not an https or http URL with a host and no user, password or fragment" },
      { id: "mdb-9007", reason: "the status is empty" },
    ]);
    expect(JSON.stringify(result.skipped)).not.toContain("secret");
  });

  it("keeps a feed with a bad license URL, with no license in its config", () => {
    const feed = catalogFeeds(withRows(row({ "urls.license": "see the site" }))).feeds.find((each) => each.id === "mdb-9001");
    expect(feed).toBeDefined();
    expect(feed).not.toHaveProperty("license");
  });

  it("gives a problem and no feed for a text that is not CSV, a text with no rows, or a missing column", () => {
    expect(catalogFeeds('id,data_type\n"mdb-1,gtfs_rt').problems).toHaveLength(1);
    expect(catalogFeeds(HEADER.join(","))).toEqual({ feeds: [], skipped: [], problems: ["the catalog has no rows"] });
    const missing = catalogFeeds(stringifyCsv(TABLE.map((cells) => cells.filter((_, index) => HEADER[index] !== "status"))));
    expect(missing).toEqual({ feeds: [], skipped: [], problems: ['the catalog has no column "status"'] });
  });

  it("reads each column that it names from the header of the fixture", () => {
    for (const column of CATALOG_COLUMNS) expect(HEADER).toContain(column);
  });
});

describe("originOf", () => {
  it("gives lower-case Latin letters and digits with single hyphens, or the id for a name with no Latin letter", () => {
    expect(originOf("Réseau urbain Cap Cotentin", "mdb-1841")).toBe("reseau-urbain-cap-cotentin");
    expect(originOf("Oslo region (Ruter)", "mdb-1799")).toBe("oslo-region-ruter");
    expect(originOf("知多市", "jbda-x")).toBe("jbda-x");
    const long = originOf("A".repeat(MAX_ORIGIN_LENGTH - 1) + " B C", "x");
    expect(long.length).toBeLessThanOrEqual(MAX_ORIGIN_LENGTH);
    expect(long).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("feedsFor", () => {
  const { feeds } = catalogFeeds(CATALOG);

  it("gives the feeds whose box meets a place, at the buffer of the place or nearer", () => {
    // The box of the light rail of Canberra is small. A place 1.8 km east of the box meets it only with a buffer of 1.8 km or more.
    expect(feedsFor(feeds, [place("canberra", [149.14, -35.23])]).map((feed) => feed.id)).toEqual(["mdb-1423"]);
    const east = feeds.find((feed) => feed.id === "mdb-1423")!.box.east;
    const outside: readonly [number, number] = [east + 0.02, -35.23];
    expect(feedsFor(feeds, [place("near", outside, 0)])).toEqual([]);
    expect(feedsFor(feeds, [place("near", outside, 5)]).map((feed) => feed.id)).toEqual(["mdb-1423"]);
  });

  it("meets a feed with the wide box of a national static feed far from its network", () => {
    // The box of the Oslo feed is the box of the national static feed of Entur, from 47 to 78 degrees north. It holds Szczecin.
    expect(feedsFor(feeds, [place("szczecin", [14.55, 53.43])]).map((feed) => feed.id)).toEqual(["mdb-1967", "mdb-1799"]);
  });

  it("gives no feed for a place with no position, or for no place", () => {
    expect(feedsFor(feeds, [{ id: "p" as PlaceId, codes: [{ system: "iso3166", code: "PL" }], bufferKm: 10 }])).toEqual([]);
    expect(feedsFor(feeds, [])).toEqual([]);
  });
});
