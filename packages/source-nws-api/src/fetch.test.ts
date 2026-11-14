import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, WatchedPlace } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { CANARY_PATH, createNwsFetch, queriesOf } from "./fetch.ts";

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const BASE = "https://nws.test";

/** A place of the tests. The codes are public regions, not the places of an owner. */
const place = (id: string, codes: WatchedPlace["codes"]): WatchedPlace => ({ id: id as PlaceId, codes, bufferKm: 0 });
const TEXAS = place("a", [
  { system: "state", code: "TX" },
  { system: "ugc", code: "TXC311" },
]);
const ARIZONA = place("b", [{ system: "state", code: "az" }]);
const ZONE_ONLY = place("c", [{ system: "ugc", code: "WAC045" }]);
const NO_CODE = place("d", [{ system: "same", code: "053045" }]);

describe("queriesOf", () => {
  const paths = (places: WatchedPlace[]): string[] => queriesOf({ places }).map((query) => query.path);

  it("asks by state, in order and with no duplicate", () => {
    expect(paths([TEXAS, ARIZONA, TEXAS])).toEqual(["/alerts/active?area=AZ,TX", CANARY_PATH]);
  });

  it("asks by zone for a place with no state", () => {
    expect(paths([TEXAS, ZONE_ONLY])).toEqual(["/alerts/active?area=TX", "/alerts/active?zone=WAC045", CANARY_PATH]);
  });

  it("asks for the whole country for a place with no state and no zone", () => {
    expect(paths([TEXAS, NO_CODE])).toEqual(["/alerts/active", CANARY_PATH]);
  });

  it("asks only for the canary with no place", () => {
    expect(queriesOf({ places: [] })).toEqual([{ path: CANARY_PATH, main: false }]);
  });
});

/** A clock of the tests: each wait moves the time at once. */
const testClock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let time = Date.parse("2026-11-15T00:00:00Z");
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Reply => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { "content-type": "application/geo+json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const collection = (...names: string[]): unknown => ({ type: "FeatureCollection", features: names.map(read) });

/** This function makes a fetch whose transport gives one reply for each path. */
const fetchWith = (replies: Record<string, Reply | ((exchange: Exchange, signal: AbortSignal | undefined) => Promise<Reply>)>, timeoutMs = 1000) => {
  const sent: Exchange[] = [];
  const transport: Transport = async (exchange, signal) => {
    sent.push(exchange);
    const path = exchange.url.slice(BASE.length);
    const reply = replies[path];
    if (reply === undefined) throw new Error(`no reply for ${path}`);
    return typeof reply === "function" ? reply(exchange, signal) : reply;
  };
  const clock = testClock();
  const fetch = createNwsFetch({
    pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
    transport,
    userAgent: "alerts-tests",
    baseUrl: BASE,
    minIntervalMs: 0,
    timeoutMs,
  });
  return { fetch, sent };
};

const watch = { places: [TEXAS] };
const MAIN = "/alerts/active?area=TX";
const canary = json(collection("nws-keepalive.json"));
const failureOf = (outcome: FetchOutcome): unknown => (outcome.ok ? undefined : outcome.failure);

describe("createNwsFetch", () => {
  it("gives one observation for each alert, and the keepalive", async () => {
    const { fetch, sent } = fetchWith({ [MAIN]: json(collection("nws-flw.json", "nws-faw.json"), 200, { etag: '"abc"' }), [CANARY_PATH]: canary });
    const outcome = await fetch({ watch });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.complete).toBe(true);
    expect(outcome.observations).toHaveLength(3);
    expect(new Set(outcome.observations.map((observation) => observation.id)).size).toBe(3);
    expect(outcome.observations[0]?.body).toBe(JSON.stringify(read("nws-flw.json")));
    expect(outcome.observations[0]?.transport).toMatchObject({ url: `${BASE}${MAIN}`, status: 200, etag: '"abc"' });
    expect(sent[0]?.headers).toEqual({ accept: "application/geo+json", "user-agent": "alerts-tests" });
  });

  it("gives the same observation ids for the same answer", async () => {
    const replies = { [MAIN]: json(collection("nws-flw.json")), [CANARY_PATH]: canary };
    const ids = async (): Promise<string[]> => {
      const outcome = await fetchWith(replies).fetch({ watch });
      return outcome.ok ? outcome.observations.map((observation) => observation.id) : [];
    };
    expect(await ids()).toEqual(await ids());
  });

  it("gives an empty, complete answer when no alert is active", async () => {
    const outcome = await fetchWith({ [MAIN]: json(collection()), [CANARY_PATH]: canary }).fetch({ watch });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(outcome.ok && outcome.observations).toHaveLength(1);
  });

  it("marks an answer that is not a feature collection as not complete", async () => {
    const outcome = await fetchWith({ [MAIN]: json("<html>maintenance</html>"), [CANARY_PATH]: canary }).fetch({ watch });
    expect(outcome).toMatchObject({ ok: true, complete: false });
    expect(outcome.ok && outcome.observations[0]?.body).toBe("<html>maintenance</html>");
  });

  it("does not fail when only the canary query fails", async () => {
    const outcome = await fetchWith({ [MAIN]: json(collection("nws-flw.json")), [CANARY_PATH]: json("", 500) }).fetch({ watch });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(outcome.ok && outcome.observations).toHaveLength(1);
  });

  it.each([
    [429, { "retry-after": "120" }, { kind: "rate-limited", retryAfter: 120_000 }],
    [503, { "retry-after": "60" }, { kind: "server", retryAfter: 60_000 }],
    [500, {}, { kind: "server" }],
    [401, {}, { kind: "auth" }],
    [403, {}, { kind: "refused" }],
    [404, {}, { kind: "refused" }],
    [400, {}, { kind: "refused" }],
    [301, { location: "https://elsewhere.test/" }, { kind: "refused" }],
  ])("maps the status %i to a failure", async (status, headers, failure) => {
    const outcome = await fetchWith({ [MAIN]: json("", status, headers), [CANARY_PATH]: canary }).fetch({ watch });
    expect(outcome.ok).toBe(false);
    expect(failureOf(outcome)).toMatchObject(failure);
  });

  it("tells the problem text of the NWS in the failure", async () => {
    const problem = { title: "Bad Request", detail: "Parameter \"area\" is invalid" };
    const outcome = await fetchWith({ [MAIN]: json(problem, 400), [CANARY_PATH]: canary }).fetch({ watch });
    expect(failureOf(outcome)).toEqual({ kind: "refused", message: '400 Error: Parameter "area" is invalid' });
  });

  it("gives a network failure when the transport fails", async () => {
    const outcome = await fetchWith({
      [MAIN]: async () => {
        throw new Error("ECONNRESET");
      },
      [CANARY_PATH]: canary,
    }).fetch({ watch });
    expect(failureOf(outcome)).toMatchObject({ kind: "network" });
    expect((failureOf(outcome) as { message: string }).message).toContain("ECONNRESET");
  });

  it("gives a timeout failure when the answer is too slow", async () => {
    const hang = (_exchange: Exchange, signal: AbortSignal | undefined): Promise<Reply> =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const outcome = await fetchWith({ [MAIN]: hang, [CANARY_PATH]: canary }, 20).fetch({ watch });
    expect(failureOf(outcome)).toMatchObject({ kind: "timeout" });
  });

  it("throws when the caller stops the fetch", async () => {
    const stop = new AbortController();
    const hang = (_exchange: Exchange, signal: AbortSignal | undefined): Promise<Reply> =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        stop.abort(new Error("shutdown"));
      });
    await expect(fetchWith({ [MAIN]: hang, [CANARY_PATH]: canary }).fetch({ watch }, stop.signal)).rejects.toThrow("shutdown");
  });
});
