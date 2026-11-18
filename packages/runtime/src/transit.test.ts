import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaceId, WatchedPlace } from "@mark1russell7/alerts";
import type { CatalogCopy, CatalogFetch, CatalogFetched, GtfsFeed } from "@mark1russell7/alerts-source-gtfs-alerts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CATALOG_REFRESH,
  CATALOG_RETRY,
  chooseFeeds,
  feedsKey,
  keepTransit,
  MAX_TRANSIT_FEEDS,
  openTransitCache,
  TRANSIT_FILE,
  TRANSIT_FORMAT,
  transitReport,
  transitText,
  type TransitCache,
  type TransitOutcome,
} from "./transit.ts";

// Thirteen real rows of the catalog of 2026-11-17 (CC0 1.0), with the contact column empty.
const CATALOG = readFileSync(new URL("../../source-gtfs-alerts/fixtures/mobility-database-20261117.csv", import.meta.url), "utf8");
const START = Date.parse("2026-11-18T04:00:00Z");

// Public places of the tests: the centers of Szczecin and of Canberra.
const SZCZECIN: WatchedPlace = { id: "a" as PlaceId, codes: [], at: [14.55, 53.43], bufferKm: 0 };
const CANBERRA: WatchedPlace = { id: "b" as PlaceId, codes: [], at: [149.14, -35.23], bufferKm: 0 };

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const tempFile = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "alerts-transit-"));
  folders.push(folder);
  return join(folder, TRANSIT_FILE);
};

describe("openTransitCache", () => {
  it("gives no copy and no problem for a missing file, and gives back each copy that it writes", () => {
    const path = tempFile();
    const problems: string[] = [];
    const cache = openTransitCache(path, (problem) => problems.push(problem));
    expect(cache.read()).toBeUndefined();
    const copy: CatalogCopy = { text: CATALOG, fetched: START, condition: { etag: '"c1"', digest: "a".repeat(64) } };
    cache.write(copy);
    expect(cache.read()).toEqual(copy);
    cache.write({ text: "id\n", fetched: START + 1 });
    expect(cache.read()).toEqual({ text: "id\n", fetched: START + 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ format: TRANSIT_FORMAT });
    expect(problems).toEqual([]);
  });

  it("gives no copy and one problem with no path for a file that is not JSON or not a copy", () => {
    const path = tempFile();
    const problems: string[] = [];
    const cache = openTransitCache(path, (problem) => problems.push(problem));
    writeFileSync(path, "{");
    expect(cache.read()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ format: "other/1", fetched: START, text: "" }));
    expect(cache.read()).toBeUndefined();
    expect(problems).toEqual([`the file ${TRANSIT_FILE} is not JSON`, `the file ${TRANSIT_FILE} is not a copy of the catalog`]);
    expect(problems.join(" ")).not.toContain(path);
  });
});

describe("chooseFeeds", () => {
  const copy: CatalogCopy = { text: CATALOG, fetched: START };

  it("gives the feeds whose box meets a place, in the order of their ids", () => {
    expect(chooseFeeds(copy, [SZCZECIN, CANBERRA]).feeds.map((feed) => feed.id)).toEqual(["mdb-1423", "mdb-1799", "mdb-1967"]);
    expect(chooseFeeds(copy, [SZCZECIN]).cut).toEqual([]);
  });

  it("keeps the smallest boxes at the limit, and gives the cut feeds", () => {
    // The box of Szczecin is local. The box of the Oslo feed holds most of northern Europe.
    const chosen = chooseFeeds(copy, [SZCZECIN], 1);
    expect(chosen.feeds.map((feed) => feed.id)).toEqual(["mdb-1967"]);
    expect(chosen.cut.map((feed) => feed.id)).toEqual(["mdb-1799"]);
    expect(transitText(chosen, true)).toBe(`The runtime reads 1 transit feeds near the places. 1 more feeds meet a place, but the limit is ${String(MAX_TRANSIT_FEEDS)}.`);
  });

  it("gives no feed with no copy, with no place, or with a copy that has a problem", () => {
    expect(chooseFeeds(undefined, [SZCZECIN])).toEqual({ feeds: [], cut: [], problems: [] });
    expect(chooseFeeds(copy, []).feeds).toEqual([]);
    const bad = chooseFeeds({ text: "id\n", fetched: START }, [SZCZECIN]);
    expect(bad.feeds).toEqual([]);
    expect(bad.problems).toEqual(["the catalog has no rows"]);
    expect(transitText(bad, true)).toBe("The copy of the transit catalog has problems, and the runtime reads no transit feed: the catalog has no rows.");
  });
});

describe("transitReport and transitText", () => {
  it("tells a failure, a failed write and a new text, and nothing for a kept text", () => {
    expect(transitReport({ ok: false, error: new Error("HTTP 503"), step: "fetch" })).toBe("The read of the transit catalog failed. The runtime tries again after 60 minutes: HTTP 503");
    expect(transitReport({ ok: false, error: new Error("the disk is full"), step: "write" })).toBe("The copy of the transit catalog was not written: the disk is full");
    expect(transitReport({ ok: true, changed: true, feeds: 3, cut: 0 })).toBe("The transit catalog has a new text. It gives 3 feeds near the places.");
    expect(transitReport({ ok: true, changed: true, feeds: 40, cut: 2 })).toBe("The transit catalog has a new text. It gives 40 feeds near the places, and 2 more past the limit.");
    expect(transitReport({ ok: true, changed: false, feeds: 3, cut: 0 })).toBeUndefined();
  });

  it("tells the start with no copy", () => {
    expect(transitText({ feeds: [], cut: [], problems: [] }, false)).toBe("The private folder has no copy of the transit catalog. The runtime reads the catalog after its first pass.");
  });
});

describe("feedsKey", () => {
  const [one, two] = chooseFeeds({ text: CATALOG, fetched: START }, [SZCZECIN]).feeds as [GtfsFeed, GtfsFeed];

  it("does not change with the order, and changes with a URL or a box", () => {
    expect(feedsKey([one, two])).toBe(feedsKey([two, one]));
    expect(feedsKey([one, { ...two, url: "https://transit.example.test/other.pb" }])).not.toBe(feedsKey([one, two]));
    expect(feedsKey([one, { ...two, box: { ...two.box, north: 70 } }])).not.toBe(feedsKey([one, two]));
    expect(feedsKey([])).toBe("[]");
  });
});

/** This helper gives a keeper with a fetch that gives the results in turn, a cache in memory and a clock of the test. */
function keeperWith(results: readonly (CatalogFetched | Error)[], options: { copy?: CatalogCopy; opened?: string; places?: readonly WatchedPlace[]; failWrite?: boolean } = {}) {
  let time = START;
  const asked: (CatalogCopy | undefined)[] = [];
  const written: CatalogCopy[] = [];
  const outcomes: TransitOutcome[] = [];
  let told = 0;
  let index = 0;
  const fetch: CatalogFetch = async (last) => {
    asked.push(last);
    const result = results[Math.min(index++, results.length - 1)];
    if (result === undefined) throw new Error("no result");
    if (result instanceof Error) throw result;
    return result;
  };
  const cache: TransitCache = {
    read: () => written.at(-1),
    write: (copy) => {
      if (options.failWrite === true) throw new Error("the disk is full");
      written.push(copy);
    },
  };
  const keeper = keepTransit({
    cache,
    copy: options.copy,
    fetch,
    now: () => time,
    places: options.places ?? [SZCZECIN],
    opened: options.opened ?? "[]",
    onFeeds: () => void told++,
    onTransit: (outcome) => outcomes.push(outcome),
  });
  return { keeper, asked, written, outcomes, told: () => told, advance: (ms: number) => void (time += ms) };
}

const fetched = (fetchedAt: number, changed = true, text = CATALOG): CatalogFetched => ({ ok: true, copy: { text, fetched: fetchedAt }, changed });

describe("keepTransit", () => {
  it("reads the catalog with no copy, writes the copy, and starts onFeeds one time when the feeds change", async () => {
    const { keeper, asked, written, outcomes, told, advance } = keeperWith([fetched(START), fetched(START + CATALOG_REFRESH)]);
    keeper.afterPass();
    keeper.afterPass();
    await keeper.idle();
    expect(asked).toEqual([undefined]);
    expect(written).toHaveLength(1);
    expect(outcomes).toEqual([{ ok: true, changed: true, feeds: 2, cut: 0 }]);
    expect(told()).toBe(1);

    // A fresh copy is not due. After one day, the keeper reads the catalog again with the copy, and it does not start onFeeds again.
    keeper.afterPass();
    await keeper.idle();
    expect(asked).toHaveLength(1);
    advance(CATALOG_REFRESH);
    keeper.afterPass();
    await keeper.idle();
    expect(asked).toEqual([undefined, written[0]]);
    expect(told()).toBe(1);
  });

  it("does not start onFeeds when the feeds of the new copy are the feeds of the open", async () => {
    const opened = feedsKey(chooseFeeds({ text: CATALOG, fetched: START }, [SZCZECIN]).feeds);
    const { keeper, told, outcomes } = keeperWith([fetched(START)], { opened });
    keeper.afterPass();
    await keeper.idle();
    expect(outcomes).toEqual([{ ok: true, changed: true, feeds: 2, cut: 0 }]);
    expect(told()).toBe(0);
  });

  it("waits CATALOG_RETRY after a failure or a throw, and keeps the last copy", async () => {
    const copy: CatalogCopy = { text: CATALOG, fetched: START - CATALOG_REFRESH };
    const failure: CatalogFetched = { ok: false, failure: { kind: "server", message: "HTTP 503" } };
    const { keeper, asked, outcomes, advance } = keeperWith([failure, new Error("a socket closed"), fetched(START)], { copy });
    keeper.afterPass();
    await keeper.idle();
    expect(outcomes).toMatchObject([{ ok: false, step: "fetch", error: new Error("HTTP 503") }]);
    advance(CATALOG_RETRY - 1);
    keeper.afterPass();
    await keeper.idle();
    expect(asked).toHaveLength(1);
    advance(1);
    keeper.afterPass();
    await keeper.idle();
    expect(outcomes.at(-1)).toMatchObject({ ok: false, step: "fetch", error: new Error("a socket closed") });
    expect(asked).toEqual([copy, copy]);
    advance(CATALOG_RETRY);
    keeper.afterPass();
    await keeper.idle();
    expect(outcomes.at(-1)).toMatchObject({ ok: true });
  });

  it("keeps the new copy in memory when the write fails", async () => {
    const { keeper, asked, outcomes, told, advance } = keeperWith([fetched(START)], { failWrite: true });
    keeper.afterPass();
    await keeper.idle();
    expect(outcomes).toMatchObject([{ ok: false, step: "write" }, { ok: true, feeds: 2 }]);
    expect(told()).toBe(1);
    advance(CATALOG_REFRESH - 1);
    keeper.afterPass();
    await keeper.idle();
    expect(asked).toHaveLength(1);
  });

  it("stops the read at the close, with no outcome, and starts no read after it", async () => {
    let aborted = false;
    const outcomes: TransitOutcome[] = [];
    const keeper = keepTransit({
      cache: { read: () => undefined, write: () => undefined },
      copy: undefined,
      fetch: (_last, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
      now: () => START,
      places: [SZCZECIN],
      opened: "[]",
      onTransit: (outcome) => outcomes.push(outcome),
    });
    keeper.afterPass();
    await keeper.close();
    expect(aborted).toBe(true);
    keeper.afterPass();
    await keeper.idle();
    expect(outcomes).toEqual([]);
  });
});
