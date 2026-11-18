import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { GCP_BASE, INCIDENTS_PATH } from "./feed.ts";
import { createGcpFetch, incidentBody, INCIDENTS_TIMEOUT_MS, isLive, readIncidents } from "./fetch.ts";

type Incident = Record<string, unknown> & { updates: Record<string, unknown>[] };

/** The real answer, with 2 of its 8 incidents (`fixtures/README.md`). Both incidents have ended. */
const TEXT = readFileSync(new URL("../fixtures/incidents-20261118.json", import.meta.url), "utf8");
const [FIRST, OTHER] = JSON.parse(TEXT) as [Incident, Incident];
const FETCHED = Date.parse("2026-11-18T05:24:17Z");
const MODIFIED = "Wed, 18 Nov 2026 05:24:17 GMT";

/** The answer with the first incident live: that incident has no end. */
const { end: _end, ...LIVE_FIRST } = FIRST;
const LIVE = JSON.stringify([LIVE_FIRST, OTHER]);

/** A place of the tests. The request holds no place, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "NO" }], at: [18.96, 69.65], bufferKm: 0 }] };

const json = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json", "last-modified": MODIFIED, ...headers }, body });
const NOT_MODIFIED: Reply = { status: 304, statusText: "Not Modified", headers: { "last-modified": MODIFIED }, body: "" };

/** This function makes a fetch whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly Reply[]) => {
  const sent: Exchange[] = [];
  let index = 0;
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply === undefined) throw new Error("no reply");
    return reply;
  };
  const clock = { time: FETCHED, now: () => clock.time, sleep: async (ms: number) => void (clock.time += ms) };
  const fetch = createGcpFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent, clock };
};
const observationsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations : []);
const idsOf = (outcome: FetchOutcome) => observationsOf(outcome).map((observation) => (JSON.parse(observation.body) as Record<string, unknown>)["id"]);
const failureOf = (outcome: FetchOutcome) => (outcome.ok ? undefined : outcome.failure);

describe("readIncidents", () => {
  it("gives no incident when each incident has ended, and a complete list", () => {
    expect(readIncidents(TEXT, FETCHED)).toEqual({ bodies: [], complete: true });
  });

  it("gives the body of each incident with no end, with only the fields that the map reads", () => {
    const incidents = readIncidents(LIVE, FETCHED)!;
    expect(incidents.complete).toBe(true);
    expect(incidents.bodies).toHaveLength(1);
    const body = JSON.parse(incidents.bodies[0]!) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["id", "begin", "created", "modified", "external_desc", "status_impact", "severity", "affected_products", "currently_affected_locations", "previously_affected_locations", "most_recent_update", "updates", "uri"]);
    expect((body["affected_products"] as unknown[])[0]).toEqual({ id: "5x6CGnZvSHQZ26KtxpK1", title: "Hybrid Connectivity" });
    expect((body["updates"] as unknown[])[0]).toEqual({ when: "2026-06-29T23:06:10+00:00", status: "AVAILABLE" });
    expect(Object.keys(body["most_recent_update"] as object)).toEqual(["created", "modified", "when", "text", "status", "affected_locations"]);
    expect(incidents.bodies[0]!.length).toBeLessThan(JSON.stringify(LIVE_FIRST).length / 2);
  });

  it("keeps the fields of each incident in one order, with no field that the map does not read", () => {
    const reordered = Object.fromEntries(Object.entries(LIVE_FIRST).reverse());
    expect(incidentBody({ ...reordered, number: "7", service_key: "x", newField: 1 })).toBe(incidentBody(LIVE_FIRST));
  });

  it("is not complete when a live incident is not valid, and keeps that incident in the list", () => {
    const incidents = readIncidents(JSON.stringify([{ id: "x1" }, OTHER]), FETCHED)!;
    expect(incidents).toEqual({ bodies: [JSON.stringify({ id: "x1" })], complete: false });
  });

  it("gives the whole body of an answer that is not a list, and undefined for a body that does not parse", () => {
    expect(readIncidents('{"incidents":[]}', FETCHED)).toEqual({ bodies: ['{"incidents":[]}'], complete: false });
    expect(readIncidents(TEXT.slice(0, 500), FETCHED)).toBeUndefined();
  });
});

describe("isLive", () => {
  it("reads an incident with no end, or with an end after the time, as live", () => {
    expect(isLive(LIVE_FIRST, FETCHED)).toBe(true);
    expect(isLive({ ...FIRST, end: null }, FETCHED)).toBe(true);
    expect(isLive({ ...FIRST, end: "" }, FETCHED)).toBe(true);
    expect(isLive({ ...FIRST, end: "2026-11-18T06:00:00+00:00" }, FETCHED)).toBe(true);
    expect(isLive(FIRST, FETCHED)).toBe(false);
    expect(isLive({ ...FIRST, end: "soon" }, FETCHED)).toBe(false);
    expect(isLive(7, FETCHED)).toBe(true);
  });
});

describe("createGcpFetch", () => {
  it("asks for the history of the incidents with a timeout of 30 seconds by default", () => {
    expect(INCIDENTS_TIMEOUT_MS).toBe(30_000);
    expect(INCIDENTS_PATH).toBe("/incidents.json");
  });

  it("gives one observation for each live incident, with the Last-Modified date as the time of the data", async () => {
    const { fetch, sent } = fetchWith([json(LIVE)]);
    const outcome = await fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: true, asOf: Date.parse(MODIFIED) });
    expect(idsOf(outcome)).toEqual(["5fGQt4VbkDnr3Yp8PXPr"]);
    expect(observationsOf(outcome)[0]).toMatchObject({ source: "gcp-status", contentType: "application/json", fetched: FETCHED, transport: { status: 200 } });
    expect(sent.map((exchange) => exchange.url)).toEqual([`${GCP_BASE}${INCIDENTS_PATH}`]);
    expect(sent[0]?.headers).toMatchObject({ "user-agent": "alerts-tests", accept: "application/json" });
  });

  it("gives an empty complete list when no incident is live", async () => {
    const { fetch } = fetchWith([json(TEXT)]);
    expect(await fetch({ watch: WATCH })).toEqual({ ok: true, observations: [], complete: true, asOf: Date.parse(MODIFIED) });
  });

  it("sends the Last-Modified date of the last full answer, and gives the same observations for a 304", async () => {
    const { fetch, sent } = fetchWith([json(LIVE), NOT_MODIFIED]);
    const first = await fetch({ watch: WATCH });
    const second = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.headers["if-modified-since"])).toEqual([undefined, MODIFIED]);
    expect(observationsOf(second).map((observation) => observation.id)).toEqual(observationsOf(first).map((observation) => observation.id));
    expect(second).toMatchObject({ ok: true, complete: true, asOf: Date.parse(MODIFIED) });
    expect(observationsOf(second)[0]?.transport.status).toBe(304);
  });

  it("reads the last full answer again at the time of a 304: an incident whose end passes leaves the list", async () => {
    const ending = JSON.stringify([{ ...FIRST, end: new Date(FETCHED + 60_000).toISOString() }]);
    const { fetch, clock } = fetchWith([json(ending), NOT_MODIFIED]);
    expect(idsOf(await fetch({ watch: WATCH }))).toEqual(["5fGQt4VbkDnr3Yp8PXPr"]);
    clock.time += 120_000;
    expect(await fetch({ watch: WATCH })).toMatchObject({ ok: true, observations: [], complete: true });
  });

  it("fails a 304 with no earlier full answer, and then sends no condition", async () => {
    const { fetch, sent } = fetchWith([NOT_MODIFIED, json(LIVE)]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `a 304 answer with no earlier full answer: ${GCP_BASE}${INCIDENTS_PATH}` });
    expect((await fetch({ watch: WATCH })).ok).toBe(true);
    expect(sent.map((exchange) => exchange.headers["if-modified-since"])).toEqual([undefined, undefined]);
  });

  it("fails a cut body, and then sends no condition", async () => {
    const { fetch, sent } = fetchWith([json(LIVE.slice(0, 500)), json(LIVE)]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `truncated or malformed body: ${GCP_BASE}${INCIDENTS_PATH}` });
    expect((await fetch({ watch: WATCH })).ok).toBe(true);
    expect(sent.map((exchange) => exchange.headers["if-modified-since"])).toEqual([undefined, undefined]);
  });

  it("gives no time of the data for an answer with no Last-Modified date", async () => {
    const { fetch } = fetchWith([{ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: LIVE }]);
    const outcome = await fetch({ watch: WATCH });
    expect(outcome.ok && outcome.asOf).toBe(undefined);
  });

  it("gives the failure of an answer that is not a success", async () => {
    const { fetch } = fetchWith([json("busy", 503)]);
    expect(failureOf(await fetch({ watch: WATCH }))?.kind).toBeTypeOf("string");
  });
});
