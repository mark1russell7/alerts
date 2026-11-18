import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { CATALOG_PATH, createKevFetch, entryBody, KEV_TIMEOUT_MS, listedAt, readCatalog } from "./fetch.ts";
import { HEAD_FIELDS } from "./map.ts";

/** The real catalog, with 10 of its entries (`fixtures/README.md`). */
const FIXTURE = readFileSync(new URL("../fixtures/kev-20261117.json", import.meta.url), "utf8");
const CATALOG = JSON.parse(FIXTURE) as { vulnerabilities: Record<string, unknown>[] } & Record<string, unknown>;
const FETCHED = Date.parse("2026-11-18T04:02:53Z");
const RELEASED = Date.parse("2026-11-17T17:53:15.5664Z");
const DAY = 86_400_000;

/** A place of the tests. The request holds no place, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "NO" }], at: [18.96, 69.65], bufferKm: 0 }] };

const BASE = "https://kev.cisa.test";
const ETAG = '"kev-1"';
const json = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json", ...headers }, body });
const NOT_MODIFIED: Reply = { status: 304, statusText: "Not Modified", headers: { etag: ETAG }, body: "" };

/** This function makes a fetch at the time `start`, whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly Reply[], start = FETCHED) => {
  const sent: Exchange[] = [];
  let index = 0;
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply === undefined) throw new Error("no reply");
    return reply;
  };
  let time = start;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createKevFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent, move: (ms: number) => void (time += ms) };
};
const observationsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations : []);
const cvesOf = (outcome: FetchOutcome) =>
  observationsOf(outcome)
    .map((observation) => (JSON.parse(observation.body) as Record<string, unknown>)["cveID"])
    .filter((cve) => cve !== undefined);
const failureOf = (outcome: FetchOutcome) => (outcome.ok ? undefined : outcome.failure);

const LIVE = ["CVE-2026-115731", "CVE-2026-124194", "CVE-2026-111793", "CVE-2026-20320", "CVE-2026-125350", "CVE-2026-19868", "CVE-2024-27834"];

describe("readCatalog", () => {
  it("lists the head and each entry whose due date has not ended, with the release time of the catalog", () => {
    const catalog = readCatalog(FIXTURE, FETCHED)!;
    expect(catalog.complete).toBe(true);
    expect(catalog.asOf).toBe(RELEASED);
    expect(JSON.parse(catalog.head)).toEqual(Object.fromEntries(HEAD_FIELDS.map((field) => [field, CATALOG[field]])));
    expect(catalog.listed.map(({ body }) => JSON.parse(body).cveID)).toEqual(LIVE);
    expect(catalog.listed.every(({ until }) => until !== undefined && until > FETCHED)).toBe(true);
  });

  it("keeps the fields of each entry in one order, so a new field of the catalog keeps the body", () => {
    const first = CATALOG.vulnerabilities[0]!;
    const reordered = Object.fromEntries(Object.entries(first).reverse());
    expect(entryBody({ ...reordered, newField: "x" })).toBe(entryBody(first));
  });

  it("is not complete when the count differs from the entries, or an entry is not valid", () => {
    expect(readCatalog(JSON.stringify({ ...CATALOG, count: 11 }), FETCHED)?.complete).toBe(false);
    const bad = { ...CATALOG, vulnerabilities: [...CATALOG.vulnerabilities, { cveID: "CVE-26-1", dueDate: "2020-01-01" }], count: 11 };
    const catalog = readCatalog(JSON.stringify(bad), FETCHED)!;
    expect(catalog.complete).toBe(false);
    // An entry that is not valid stays in the list, so the map tells of it.
    expect(catalog.listed.map(({ body }) => JSON.parse(body).cveID)).toEqual([...LIVE, "CVE-26-1"]);
  });

  it("gives the whole body as the head of an answer that is not the catalog, and undefined for a body that does not parse", () => {
    const moved = JSON.stringify({ title: "x", vulnerabilities: [] });
    expect(readCatalog(moved, FETCHED)).toEqual({ head: moved, listed: [], complete: false });
    expect(readCatalog(FIXTURE.slice(0, 500), FETCHED)).toBeUndefined();
  });
});

describe("listedAt", () => {
  it("removes each entry at the end of its due date", () => {
    const catalog = readCatalog(FIXTURE, FETCHED)!;
    const cves = (now: number) => listedAt(catalog, now).map((body) => JSON.parse(body).cveID as unknown);
    expect(cves(FETCHED)).toEqual([undefined, ...LIVE]);
    // CVE-2024-27834 is due on 2026-11-18. Its end is 00:00 UTC on 2026-11-19.
    expect(cves(Date.parse("2026-11-19T00:00:00Z"))).toEqual([undefined, ...LIVE.slice(0, 6)]);
    expect(cves(Date.parse("2026-12-02T00:00:00Z"))).toEqual([undefined]);
  });
});

describe("createKevFetch", () => {
  it("asks for the file of the catalog with a timeout of 30 seconds by default", () => {
    expect(KEV_TIMEOUT_MS).toBe(30_000);
  });

  it("gives one observation for the head and one for each live entry, with the release as the time of the data", async () => {
    const { fetch, sent } = fetchWith([json(FIXTURE, 200, { etag: ETAG })]);
    const outcome = await fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: true, asOf: RELEASED });
    expect(cvesOf(outcome)).toEqual(LIVE);
    expect(observationsOf(outcome)).toHaveLength(8);
    expect(sent.map((exchange) => exchange.url)).toEqual([`${BASE}${CATALOG_PATH}`]);
    expect(sent[0]?.headers["user-agent"]).toBe("alerts-tests");
  });

  it("sends the ETag of the last full answer, and gives the same observations for a 304, less the entries that ended", async () => {
    const { fetch, sent, move } = fetchWith([json(FIXTURE, 200, { etag: ETAG }), NOT_MODIFIED]);
    const first = await fetch({ watch: WATCH });
    const second = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, ETAG]);
    expect(observationsOf(second).map((observation) => observation.id)).toEqual(observationsOf(first).map((observation) => observation.id));
    expect(second).toMatchObject({ ok: true, complete: true, asOf: RELEASED });
    move(DAY);
    expect(cvesOf(await fetch({ watch: WATCH }))).toEqual(LIVE.slice(0, 6));
  });

  it("fails a 304 with no earlier full answer, and then sends no condition", async () => {
    const { fetch, sent } = fetchWith([NOT_MODIFIED, json(FIXTURE, 200, { etag: ETAG })]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `a 304 answer with no earlier full answer: ${BASE}${CATALOG_PATH}` });
    expect((await fetch({ watch: WATCH })).ok).toBe(true);
    expect(sent.map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, undefined]);
  });

  it("fails a cut body, and then sends no condition", async () => {
    const { fetch, sent } = fetchWith([json(FIXTURE.slice(0, 500), 200, { etag: ETAG }), json(FIXTURE, 200, { etag: ETAG })]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `truncated or malformed body: ${BASE}${CATALOG_PATH}` });
    expect((await fetch({ watch: WATCH })).ok).toBe(true);
    expect(sent.map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, undefined]);
  });

  it("gives the failure of an answer that is not a success", async () => {
    const { fetch } = fetchWith([json("busy", 503)]);
    expect(failureOf(await fetch({ watch: WATCH }))?.kind).toBeTypeOf("string");
  });
});
