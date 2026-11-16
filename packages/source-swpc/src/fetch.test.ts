import { readFileSync } from "node:fs";
import { observationId, type FetchOutcome, type PlaceId, type Watch } from "@mark1russell7/alerts";
import fc from "fast-check";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createSwpcFetch, entryBody, isSwpcEntry, readAnswer } from "./fetch.ts";
import { mapObservation, SOURCE_ID } from "./map.ts";

/** The real bytes of the list of 16 November 2026 (`fixtures/README.md`). */
const LIST = readFileSync(new URL("../fixtures/alerts-20261116T1553Z.json", import.meta.url), "utf8");
const ENTRIES = JSON.parse(LIST) as Record<string, unknown>[];

/** A place of the tests. The list is a fixed URL, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "NO" }], at: [18.96, 69.65], bufferKm: 0 }] };

const BASE = "https://swpc.test";
const URL_OF_LIST = `${BASE}/products/alerts.json`;
const START = Date.parse("2026-11-16T15:53:30Z");
const ETAG = '"aa59-66066c55cdc1e"';
const LAST_MODIFIED = "Mon, 16 Nov 2026 15:52:54 GMT";

const json = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { "content-type": "application/json", ...headers },
  body,
});
/** The answer 200 of the site, with the validators of the real answer. */
const FULL = json(LIST, 200, { etag: ETAG, "last-modified": LAST_MODIFIED });
/** The answer 304 of a conditional GET: no body. */
const NOT_MODIFIED: Reply = { status: 304, statusText: "Not Modified", headers: { etag: ETAG }, body: "" };

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
  let time = START;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createSwpcFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent };
};
const failureOf = (outcome: FetchOutcome): unknown => (outcome.ok ? undefined : outcome.failure);
const observationsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations : []);
const conditionsOf = (sent: readonly Exchange[]): unknown[] => sent.map((exchange) => [exchange.headers["if-none-match"], exchange.headers["if-modified-since"]]);

describe("createSwpcFetch", () => {
  it("asks for the list with no place in the request, and gives one observation for each entry, in the order of the list", async () => {
    const { fetch, sent } = fetchWith([FULL]);
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([URL_OF_LIST]);
    expect(sent[0]?.headers).toMatchObject({ "user-agent": "alerts-tests", accept: "application/json" });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(outcome.ok && outcome.cursor).toBeUndefined();
    const observations = observationsOf(outcome);
    expect(observations).toHaveLength(ENTRIES.length);
    expect(observations.map((observation) => observation.body)).toEqual(ENTRIES.map(entryBody));
    expect(observations[0]).toMatchObject({
      id: observationId({ source: SOURCE_ID, contentType: "application/json", url: URL_OF_LIST, body: entryBody(ENTRIES[0]) }),
      source: SOURCE_ID,
      fetched: START,
      contentType: "application/json",
      transport: { url: URL_OF_LIST, status: 200 },
    });
    expect(observations.every((observation) => mapObservation(observation).problems.length === 0)).toBe(true);
  });

  it("sends the validators of the last full answer, and gives no observation for a 304", async () => {
    const next = json(JSON.stringify(ENTRIES.slice(1)), 200, { etag: '"v2"' });
    const { fetch, sent } = fetchWith([FULL, NOT_MODIFIED, next]);
    await fetch({ watch: WATCH });
    const same = await fetch({ watch: WATCH });
    const changed = await fetch({ watch: WATCH });
    expect(conditionsOf(sent)).toEqual([
      [undefined, undefined],
      [ETAG, LAST_MODIFIED],
      [ETAG, LAST_MODIFIED],
    ]);
    // The source is a stream: a 304 tells that the list did not change, so it gives no observation.
    expect(same).toEqual({ ok: true, observations: [], complete: true });
    expect(observationsOf(changed)).toHaveLength(ENTRIES.length - 1);
  });

  it("fails a 304 with no earlier full answer, and then sends no condition", async () => {
    const { fetch, sent } = fetchWith([NOT_MODIFIED, FULL]);
    expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `a 304 answer with no earlier full answer: ${URL_OF_LIST}` });
    expect(observationsOf(await fetch({ watch: WATCH }))).toHaveLength(ENTRIES.length);
    expect(conditionsOf(sent)).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });

  it("fails for each cut of the body, and sends no condition after it", async () => {
    const end = LIST.trimEnd().length;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: end - 1 }), async (length) => {
        const { fetch, sent } = fetchWith([json(LIST.slice(0, length), 200, { etag: ETAG }), FULL]);
        expect(failureOf(await fetch({ watch: WATCH }))).toEqual({ kind: "network", message: `truncated or malformed body: ${URL_OF_LIST}` });
        await fetch({ watch: WATCH });
        expect(conditionsOf(sent)).toEqual([
          [undefined, undefined],
          [undefined, undefined],
        ]);
      }),
      { numRuns: 60 },
    );
  });

  it("fails for an answer that is not 2xx", async () => {
    const { fetch } = fetchWith([json("", 503)]);
    expect((await fetch({ watch: WATCH })).ok).toBe(false);
  });

  it("gives a JSON body that is not a list as one observation that is not complete, and the map tells of the change", async () => {
    const body = JSON.stringify({ error: "moved" });
    const { fetch } = fetchWith([json(body)]);
    const outcome = await fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: false });
    const [observation, ...others] = observationsOf(outcome);
    expect(others).toEqual([]);
    expect(observation?.body).toBe(body);
    expect(mapObservation(observation!).problems.map((problem) => problem.fatal)).toEqual([true]);
  });
});

describe("readAnswer", () => {
  it("gives one observation for one body twice, and tells that an entry with a different structure is not complete", () => {
    const first = ENTRIES[0]!;
    const changed = { product_id: "EF3A", issued: "2026-11-16 06:28:16.430", message: "x" };
    const read = readAnswer(json(JSON.stringify([first, first, changed])), URL_OF_LIST, START, 1);
    expect(read?.observations.map((observation) => observation.body)).toEqual([entryBody(first), entryBody(changed)]);
    expect(read?.complete).toBe(false);
    expect(readAnswer(json(JSON.stringify([first])), URL_OF_LIST, START, 1)?.complete).toBe(true);
    expect(readAnswer(json("[1"), URL_OF_LIST, START, 1)).toBeUndefined();
  });

  it("uses the content type of the answer, and application/json when the answer has none", () => {
    const reply: Reply = { status: 200, statusText: "OK", headers: {}, body: "[]" };
    expect(readAnswer(reply, URL_OF_LIST, START, 1)).toEqual({ observations: [], complete: true });
    const one = readAnswer({ ...reply, body: JSON.stringify([ENTRIES[0]]) }, URL_OF_LIST, START, 1);
    expect(one?.observations[0]?.contentType).toBe("application/json");
  });
});

describe("entryBody and isSwpcEntry", () => {
  it("keeps the three fields of the list in their order, and no other field", () => {
    expect(entryBody({ message: "m", extra: 1, issue_datetime: "2026-11-16 06:28:16.430", product_id: "p" })).toBe('{"product_id":"p","issue_datetime":"2026-11-16 06:28:16.430","message":"m"}');
    expect(entryBody({ message: "m" })).toBe('{"message":"m"}');
    expect(entryBody([1])).toBe("[1]");
    expect(entryBody(null)).toBe("null");
  });

  it("gives the same body for each order of the fields of an entry", () => {
    const entry = ENTRIES[0]!;
    fc.assert(
      fc.property(fc.shuffledSubarray(Object.keys(entry), { minLength: 3, maxLength: 3 }), (keys) => {
        expect(entryBody(Object.fromEntries(keys.map((key) => [key, entry[key]])))).toBe(entryBody(entry));
      }),
    );
  });

  it("tells if an entry has the structure of the list", () => {
    expect(ENTRIES.every(isSwpcEntry)).toBe(true);
    const entry = ENTRIES[0]!;
    for (const changed of [{ ...entry, product_id: 1 }, { ...entry, issue_datetime: "2026-11-16T06:28:16Z" }, { ...entry, message: "" }, { product_id: "p" }, [], null, "x"]) {
      expect(isSwpcEntry(changed)).toBe(false);
    }
  });
});
