import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { checkCanary } from "./check.ts";
import { ACCEPT, createBomSwsFetch, errorsDetail, errorsOf, readAnswer, requestBody } from "./fetch.ts";
import { bomTime, mapObservation, METHODS, REGION, type Method } from "./map.ts";

// The answers of these tests are made from the schema of the API documentation. They hold no text of BoM.
const BASE = "https://sws.bom.test/api/v1";
const KEY = "test-key-0c4e9a";
const AT = bomTime("2026-11-17 20:10:00")!;

/** A place of the tests. The requests hold only the key, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "NO" }], at: [18.96, 69.65], bufferKm: 0 }] };

const ALERT = { start_time: "2026-11-17 19:45:00", valid_until: "2026-11-18 07:45:00", g_scale: 1, description: "minor" };
const K_INDEX = { index: 5, valid_time: "2026-11-17 18:00:00", analysis_time: "2026-11-17 19:59:33" };

const json = (body: unknown, status = 200): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** This function makes a fetch whose transport gives the reply of each method by the end of the URL. */
const fetchWith = (replies: Partial<Record<Method, Reply | Error>>) => {
  const sent: Exchange[] = [];
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    const method = exchange.url.slice(exchange.url.lastIndexOf("/") + 1) as Method;
    const reply = replies[method] ?? json({ data: [] });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  let time = AT;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createBomSwsFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", apiKey: KEY, baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch: () => fetch({ watch: WATCH }), sent };
};

const observationsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations : []);

describe("createBomSwsFetch", () => {
  it("sends a POST to each method with the key in its body, and gives one observation for each item", async () => {
    const { fetch, sent } = fetchWith({ [METHODS.alert]: json({ data: [ALERT] }), [METHODS.kIndex]: json({ data: [K_INDEX] }) });
    const outcome = await fetch();
    expect(sent.map((exchange) => [exchange.method, exchange.url])).toEqual([
      ["POST", `${BASE}/get-mag-alert`],
      ["POST", `${BASE}/get-mag-warning`],
      ["POST", `${BASE}/get-k-index`],
    ]);
    expect(sent.map((exchange) => JSON.parse(exchange.body ?? "null") as unknown)).toEqual([{ api_key: KEY }, { api_key: KEY }, { api_key: KEY, options: { location: REGION } }]);
    expect(sent[0]?.headers).toMatchObject({ accept: ACCEPT, "content-type": "application/json", "user-agent": "alerts-tests" });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    const observations = observationsOf(outcome);
    expect(observations.map((observation) => JSON.parse(observation.body) as unknown)).toEqual([
      { method: METHODS.alert, item: ALERT },
      { method: METHODS.kIndex, item: K_INDEX },
    ]);
    expect(observations.map((observation) => observation.transport.url)).toEqual([`${BASE}/get-mag-alert`, `${BASE}/get-k-index`]);
    for (const observation of observations) expect(JSON.stringify(observation)).not.toContain(KEY);
    expect(observations.flatMap((observation) => mapObservation(observation).reports)).toHaveLength(1);
    expect(checkCanary(observations).pass).toBe(true);
  });

  it("gives the failure auth for an error code of the key, and the message has no key", async () => {
    const refusal = json({ errors: [{ message: `Unsupported API key: ${KEY}`, code: 22 }] }, 403);
    const outcome = await fetchWith({ [METHODS.alert]: refusal }).fetch();
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "auth" } });
    expect(!outcome.ok && outcome.failure.message).toContain("22 Unsupported API key");
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    const other = await fetchWith({ [METHODS.warning]: json({ errors: [{ message: "Unsupported option value: location=x", code: 43 }] }, 400) }).fetch();
    expect(other).toMatchObject({ ok: false, failure: { kind: "refused", message: "400 Error: 43 Unsupported option value: location=x" } });
  });

  it("keeps the alerts and the warnings when the K index fails, and the canary fails", async () => {
    for (const kIndex of [json("", 503), new Error(`connection reset after ${KEY}`), json("{")]) {
      const outcome = await fetchWith({ [METHODS.alert]: json({ data: [ALERT] }), [METHODS.kIndex]: kIndex }).fetch();
      expect(outcome).toMatchObject({ ok: true, complete: true });
      expect(observationsOf(outcome)).toHaveLength(1);
      expect(checkCanary(observationsOf(outcome))).toEqual({ pass: false, reason: "the fetch has no K index of the Australian region" });
    }
  });

  it("fails for a failure or a cut body of the alert or of the warning", async () => {
    expect(await fetchWith({ [METHODS.alert]: json("", 500) }).fetch()).toMatchObject({ ok: false, failure: { kind: "server" } });
    const cut = await fetchWith({ [METHODS.warning]: json('{"data":[{"issue_time"') }).fetch();
    expect(cut).toEqual({ ok: false, failure: { kind: "network", message: `truncated or malformed body: ${BASE}/get-mag-warning` } });
    const lost = await fetchWith({ [METHODS.alert]: new Error(`socket closed, ${KEY}`) }).fetch();
    expect(lost).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(JSON.stringify(lost)).not.toContain(KEY);
  });

  it("gives complete false for an answer with no list data or with an item that is not valid", async () => {
    const changed = await fetchWith({ [METHODS.alert]: json({ alert: `none for ${KEY}` }) }).fetch();
    expect(changed).toMatchObject({ ok: true, complete: false });
    const [whole] = observationsOf(changed);
    expect(whole?.body).not.toContain(KEY);
    expect(mapObservation(whole!).problems.map((problem) => problem.fatal)).toEqual([true]);
    const invalid = await fetchWith({ [METHODS.alert]: json({ data: [{ ...ALERT, g_scale: 0 }] }) }).fetch();
    expect(invalid).toMatchObject({ ok: true, complete: false });
  });
});

describe("readAnswer", () => {
  it("gives one observation for each distinct item, with an id that does not change with the time of the fetch", () => {
    const reply = json({ data: [ALERT, ALERT] });
    const first = readAnswer(METHODS.alert, reply, `${BASE}/get-mag-alert`, AT, 1)!;
    const later = readAnswer(METHODS.alert, reply, `${BASE}/get-mag-alert`, AT + 600_000, 2)!;
    expect(first.observations).toHaveLength(1);
    expect(later.observations[0]?.id).toBe(first.observations[0]?.id);
    expect(readAnswer(METHODS.alert, json({ data: [] }), `${BASE}/get-mag-alert`, AT, 1)).toEqual({ observations: [], complete: true });
    expect(readAnswer(METHODS.alert, json("not json"), `${BASE}/get-mag-alert`, AT, 1)).toBeUndefined();
  });
});

describe("errorsOf and errorsDetail", () => {
  it("read the code and the message of each error, and give no text for a body with no list errors", () => {
    const body = JSON.stringify({ errors: [{ message: "Missing API key", code: 21 }, { message: "Missing field: api_key", code: "31" }, { message: "no code" }, "odd"] });
    expect(errorsOf(body)).toEqual([{ code: 21, message: "Missing API key" }, { code: 31, message: "Missing field: api_key" }, { message: "no code" }]);
    expect(errorsDetail(body)).toBe("21 Missing API key; 31 Missing field: api_key; no code");
    for (const other of ["", "{", JSON.stringify({ data: [] })]) expect(errorsDetail(other), other).toBeUndefined();
  });
});

describe("requestBody", () => {
  it("gives the key, and the region for the K index", () => {
    expect(JSON.parse(requestBody(METHODS.alert, "k"))).toEqual({ api_key: "k" });
    expect(JSON.parse(requestBody(METHODS.kIndex, "k"))).toEqual({ api_key: "k", options: { location: "Australian region" } });
  });
});
