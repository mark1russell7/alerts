import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { checkCanary } from "./check.ts";
import type { GtfsFeed } from "./feed.ts";
import { BODY_TYPE, createGtfsFetch } from "./fetch.ts";

/** The real bytes of a feed (`fixtures/README.md`), and the time of their fetch. */
const LIVE = new Uint8Array(readFileSync(new URL("../fixtures/zditm-szczecin-20261118T0358Z.pb", import.meta.url)));
const LIVE_AT = Date.parse("2026-11-18T03:58:19Z");

/** A place of the tests. The request holds no place, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "PL" }], at: [14.55, 53.43], bufferKm: 0 }] };

const FEED: GtfsFeed = { id: "mdb-1967", title: "ZDiTM Szczecin", url: "https://transit.example.test/storage/gtfs/alerts.pb?key=k1", origin: "zditm-szczecin", box: { west: 14.4, south: 53.3, east: 14.8, north: 53.6 } };

const protobuf = (bytes: Uint8Array, status = 200, headers: Record<string, string> = { etag: '"v1"' }): Reply => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { "content-type": "application/octet-stream", ...headers },
  body: "",
  bytes,
});
const notModified: Reply = { status: 304, statusText: "Not Modified", headers: {}, body: "" };

/** This function makes a fetch at the time `start`, whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly Reply[], start = LIVE_AT) => {
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
  const fetch = createGtfsFetch({ feed: FEED, pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent };
};
const bodiesOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations.map((observation) => JSON.parse(observation.body) as { type: string }) : []);

describe("createGtfsFetch", () => {
  it("asks for the bytes of the feed URL with no place, and gives the census and each alert of a real feed", async () => {
    const { fetch, sent } = fetchWith([protobuf(LIVE)]);
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => [exchange.method, exchange.url, exchange.read])).toEqual([["GET", FEED.url, "bytes"]]);
    expect(sent[0]?.headers["user-agent"]).toBe("alerts-tests");
    expect(outcome).toMatchObject({ ok: true, complete: true, asOf: Date.parse("2026-11-18T03:58:03Z") });
    expect(bodiesOf(outcome).map((body) => body.type)).toEqual(["census", "alert", "alert"]);
    if (outcome.ok) for (const observation of outcome.observations) expect(observation).toMatchObject({ source: "gtfs-mdb-1967", contentType: BODY_TYPE, fetched: LIVE_AT });
    expect(checkCanary(outcome.ok ? outcome.observations : []).pass).toBe(true);
  });

  it("sends the condition of the last full answer, and decodes its bytes again for a 304", async () => {
    const { fetch, sent } = fetchWith([protobuf(LIVE), notModified]);
    const first = await fetch({ watch: WATCH });
    const second = await fetch({ watch: WATCH });
    expect(sent[1]?.headers["if-none-match"]).toBe('"v1"');
    expect(second.ok && second.observations.map((observation) => observation.id)).toEqual(first.ok && first.observations.map((observation) => observation.id));
  });

  it("gives a failure for a 304 with no earlier full answer, and for bytes that are not a feed, with no query in the text", async () => {
    const lone = await fetchWith([notModified]).fetch({ watch: WATCH });
    expect(lone).toMatchObject({ ok: false, failure: { kind: "network" } });
    const garbage = await fetchWith([protobuf(new Uint8Array([0xff, 0xff, 0xff]))]).fetch({ watch: WATCH });
    expect(garbage).toMatchObject({ ok: false, failure: { kind: "network" } });
    for (const outcome of [lone, garbage]) {
      const message = outcome.ok ? "" : outcome.failure.message;
      expect(message).toContain("https://transit.example.test/storage/gtfs/alerts.pb");
      expect(message).not.toContain("k1");
    }
  });

  it("sends no condition after bytes that are not a feed", async () => {
    const { fetch, sent } = fetchWith([protobuf(new Uint8Array([0xff, 0xff, 0xff])), protobuf(LIVE)]);
    await fetch({ watch: WATCH });
    const outcome = await fetch({ watch: WATCH });
    expect(sent[1]?.headers["if-none-match"]).toBeUndefined();
    expect(outcome.ok).toBe(true);
  });

  it("gives the failure of the requester for a server error", async () => {
    const outcome = await fetchWith([{ status: 503, statusText: "Unavailable", headers: {}, body: "" }]).fetch({ watch: WATCH });
    expect(outcome.ok).toBe(false);
  });
});
