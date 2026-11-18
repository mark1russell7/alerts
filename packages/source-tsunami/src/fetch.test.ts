import { readFileSync } from "node:fs";
import { observationId, type FetchOutcome, type PlaceId, type Watch } from "@mark1russell7/alerts";
import fc from "fast-check";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { TSUNAMI_CENTERS, type TsunamiCenter } from "./centers.ts";
import { createTsunamiFetch } from "./fetch.ts";
import { mapObservation } from "./map.ts";

/** The real latest message of NTWC and a real bulletin of an earlier event (`fixtures/README.md`). */
const LATEST = readFileSync(new URL("../fixtures/PAAQCAP-20261116T1134Z.xml", import.meta.url), "utf8");
const BULLETIN = readFileSync(new URL("../fixtures/t06p1k-1.xml", import.meta.url), "utf8");

/** A place of the tests. The file of a center is a fixed URL, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "US" }], bufferKm: 0 }] };

const NTWC = TSUNAMI_CENTERS.ntwc;
const BASE = "https://tsunami.test";
const URL_OF_NTWC = `${BASE}/events/xml/PAAQCAP.xml`;
const START = Date.parse("2026-11-16T11:34:11Z");
const LAST_MODIFIED = "Fri, 13 Nov 2026 23:30:40 GMT";

const xml = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { "content-type": "text/xml", ...headers },
  body,
});
/** The answer 200 of the site, with the `Last-Modified` time of the file and no ETag. */
const FULL = xml(LATEST, 200, { "last-modified": LAST_MODIFIED });
/** The answer 304 of a conditional GET: no body. */
const NOT_MODIFIED: Reply = { status: 304, statusText: "Not Modified", headers: { "last-modified": LAST_MODIFIED }, body: "" };

/** This function makes a fetch whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly Reply[], center: TsunamiCenter = NTWC) => {
  const sent: Exchange[] = [];
  let index = 0;
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply === undefined) throw new Error("no reply");
    return reply;
  };
  let time = START;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createTsunamiFetch({ center, pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent };
};
const failureOf = (outcome: FetchOutcome): unknown => (outcome.ok ? undefined : outcome.failure);
const observationsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations : []);
const conditionsOf = (sent: readonly Exchange[]): unknown[] => sent.map((exchange) => exchange.headers["if-modified-since"]);

describe("createTsunamiFetch", () => {
  it("asks for the file of the center with no place in the request, and gives one observation of the whole body", async () => {
    const { fetch, sent } = fetchWith([FULL]);
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([URL_OF_NTWC]);
    expect(sent[0]?.headers).toMatchObject({ "user-agent": "alerts-tests" });
    expect(sent[0]?.headers["accept"]).toContain("application/cap+xml");
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(outcome.ok && outcome.cursor).toBeUndefined();
    const [observation, ...others] = observationsOf(outcome);
    expect(others).toEqual([]);
    expect(observation).toMatchObject({
      id: observationId({ source: NTWC.id, contentType: "text/xml", url: URL_OF_NTWC, body: LATEST }),
      source: NTWC.id,
      fetched: START,
      contentType: "text/xml",
      body: LATEST,
      transport: { url: URL_OF_NTWC, status: 200, lastModified: LAST_MODIFIED },
    });
  });

  it("sends the Last-Modified time of the last full answer, gives no observation for a 304, and gives a new message", async () => {
    const next = xml(BULLETIN, 200, { "last-modified": "Sat, 14 Nov 2026 02:00:00 GMT" });
    const { fetch, sent } = fetchWith([FULL, NOT_MODIFIED, next]);
    await fetch({ watch: WATCH });
    const same = await fetch({ watch: WATCH });
    const changed = await fetch({ watch: WATCH });
    expect(conditionsOf(sent)).toEqual([undefined, LAST_MODIFIED, LAST_MODIFIED]);
    // The source is a stream: a 304 tells that the message did not change, so it gives no observation.
    expect(same).toEqual({ ok: true, observations: [], complete: true });
    expect(observationsOf(changed).map((observation) => observation.body)).toEqual([BULLETIN]);
  });

  it("fails a 304 with no earlier full answer, and then sends no condition", async () => {
    const { fetch, sent } = fetchWith([NOT_MODIFIED, FULL]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `a 304 answer with no earlier full answer: ${URL_OF_NTWC}` });
    expect(observationsOf(await fetch({ watch: WATCH }))).toHaveLength(1);
    expect(conditionsOf(sent)).toEqual([undefined, undefined]);
  });

  it("fails for each cut of the body, and sends no condition after it", async () => {
    const end = LATEST.trimEnd().length;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: end - 1 }), async (length) => {
        const { fetch, sent } = fetchWith([xml(LATEST.slice(0, length), 200, { "last-modified": LAST_MODIFIED }), FULL]);
        expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `truncated or malformed body: ${URL_OF_NTWC}` });
        await fetch({ watch: WATCH });
        expect(conditionsOf(sent)).toEqual([undefined, undefined]);
      }),
    );
  });

  it("fails for an answer that is not 2xx", async () => {
    const { fetch } = fetchWith([xml("", 503)]);
    expect((await fetch({ watch: WATCH })).ok).toBe(false);
  });

  it("gives a whole document that is not CAP as one observation, and the map tells of the change", async () => {
    const page = "<!DOCTYPE html><html><body><p>moved</p></body></html>";
    const { fetch } = fetchWith([xml(page, 200, { "content-type": "text/html" })]);
    const outcome = await fetch({ watch: WATCH });
    const [observation] = observationsOf(outcome);
    expect(observation?.body).toBe(page);
    expect(mapObservation(observation!, NTWC).problems.map((problem) => problem.fatal)).toEqual([true]);
  });

  it("asks for the file of PTWC for the source of PTWC", async () => {
    const { fetch, sent } = fetchWith([xml(LATEST)], TSUNAMI_CENTERS.ptwc);
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([`${BASE}/events/xml/PHEBCAP.xml`]);
    expect(observationsOf(outcome).map((observation) => observation.source)).toEqual([TSUNAMI_CENTERS.ptwc.id]);
  });
});
