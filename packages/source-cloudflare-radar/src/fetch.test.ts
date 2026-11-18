import { readFileSync } from "node:fs";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { ANOMALIES_SOURCE, OUTAGES_SOURCE, PAGE_LIMIT, RADAR_BASE } from "./feed.ts";
import { createRadarFetch, errorsDetail, isLive, readRecords, type RadarList } from "./fetch.ts";

/** The real answers and the pages of chosen real records (`fixtures/README.md`). */
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const OUTAGES = fixture("outages-20261118.json");
const ANOMALIES = fixture("anomalies-20261118.json");
const CHOSEN_OUTAGES = fixture("outages-chosen-20261118.json");

/** The time of the real answers. */
const NOW = Date.parse("2026-11-18T14:54:06Z");
const clock = { now: () => NOW, sleep: async () => {} };

/** A token for the tests. It is not a token of Cloudflare. */
const TOKEN = "test-token-0123456789abcdefghij";

type Reply = { status: number; headers?: Record<string, string>; body?: string };

const JSON_HEADERS = { "content-type": "application/json;charset=UTF-8", "last-modified": "Wed, 18 Nov 2026 14:47:06 GMT" };

/** This function makes a fetch of a list whose transport gives the replies in order, and records the URL and the headers of each request. */
function fetchWith(list: RadarList, replies: Reply[]) {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const fetch = createRadarFetch({
    list,
    pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
    transport: async (request) => {
      sent.push({ url: request.url, headers: { ...request.headers } });
      const reply = replies.shift()!;
      return { status: reply.status, statusText: "", headers: reply.headers ?? {}, body: reply.body ?? "" };
    },
    userAgent: "alerts-tests",
    token: TOKEN,
    minIntervalMs: 0,
  });
  return { fetch: () => fetch({ watch: { places: [] } }), sent };
}

describe("isLive", () => {
  it("keeps a record with no end, an end after the time, or an end that is not a time", () => {
    expect(isLive({ endDate: null }, NOW)).toBe(true);
    expect(isLive({}, NOW)).toBe(true);
    expect(isLive({ endDate: "2026-11-18T15:00:00Z" }, NOW)).toBe(true);
    expect(isLive({ endDate: "soon" }, NOW)).toBe(true);
    expect(isLive({ endDate: "2026-11-18T14:00:00Z" }, NOW)).toBe(false);
  });
});

describe("readRecords", () => {
  it("gives the one live outage of the real answer, with its JSON text and no change", () => {
    const read = readRecords("outages", OUTAGES, NOW)!;
    expect(read.complete).toBe(true);
    expect(read.bodies).toHaveLength(1);
    expect(JSON.parse(read.bodies[0]!)).toEqual(JSON.parse(OUTAGES).result.annotations[0]);
  });

  it("gives the one live anomaly of the real answer", () => {
    const read = readRecords("anomalies", ANOMALIES, NOW)!;
    expect(read).toMatchObject({ complete: true });
    expect(read.bodies.map((body) => (JSON.parse(body) as { uuid: string }).uuid)).toEqual(["c595977b-aa94-4659-bb59-45d1884015f0"]);
  });

  it("gives no body for the records that ended, and the body of each record that ends after the time", () => {
    expect(readRecords("outages", CHOSEN_OUTAGES, NOW)).toEqual({ bodies: [], complete: true });
    expect(readRecords("outages", CHOSEN_OUTAGES, Date.parse("2026-11-05T00:00:00Z"))!.bodies.map((body) => (JSON.parse(body) as { id: string }).id)).toEqual(["1747"]);
  });

  it("gives one body for two records with one id, and its own body with complete false for a record with no id", () => {
    const page = JSON.parse(ANOMALIES) as { result: { trafficAnomalies: unknown[] } };
    const record = page.result.trafficAnomalies[0];
    const twice = JSON.stringify({ ...page, result: { trafficAnomalies: [record, record] } });
    expect(readRecords("anomalies", twice, NOW)!.bodies).toHaveLength(1);
    const loose = readRecords("anomalies", JSON.stringify({ ...page, result: { trafficAnomalies: [record, { type: "AS" }] } }), NOW)!;
    expect(loose).toMatchObject({ complete: false });
    expect(loose.bodies).toHaveLength(2);
  });

  it("gives complete false for a full page: the list can have more records", () => {
    const records = Array.from({ length: PAGE_LIMIT }, (_, index) => ({ uuid: `u${index}`, endDate: null }));
    expect(readRecords("anomalies", JSON.stringify({ success: true, errors: [], result: { trafficAnomalies: records } }), NOW)).toMatchObject({ complete: false });
  });

  it("gives undefined for an answer that is not a list of the API", () => {
    expect(readRecords("outages", "{", NOW)).toBeUndefined();
    expect(readRecords("outages", ANOMALIES, NOW)).toBeUndefined();
    expect(readRecords("outages", JSON.stringify({ success: false, errors: [], result: { annotations: [] } }), NOW)).toBeUndefined();
  });
});

describe("errorsDetail", () => {
  it("gives each error of an answer with its code", () => {
    expect(errorsDetail('{"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[],"result":null}')).toBe("10000 Authentication error");
    expect(errorsDetail("<html>")).toBeUndefined();
  });
});

describe("createRadarFetch", () => {
  it("asks for the outages of the last day with the token in the header authorization only, and gives the live outage", async () => {
    const { fetch, sent } = fetchWith("outages", [{ status: 200, headers: JSON_HEADERS, body: OUTAGES }]);
    const outcome = await fetch();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${RADAR_BASE}/annotations/outages?dateRange=1d&limit=100&format=json`);
    expect(sent[0]!.url).not.toContain(TOKEN);
    expect(sent[0]!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, accept: "application/json", "user-agent": "alerts-tests" });
    if (!outcome.ok) throw new Error("the fetch failed");
    expect(outcome.complete).toBe(true);
    expect(outcome.asOf).toBe(Date.parse("2026-11-18T14:47:06Z"));
    expect(outcome.observations.map((observation) => [observation.source, observation.contentType])).toEqual([[OUTAGES_SOURCE, "application/json"]]);
  });

  it("asks for the anomalies of the last day", async () => {
    const { fetch, sent } = fetchWith("anomalies", [{ status: 200, headers: JSON_HEADERS, body: ANOMALIES }]);
    const outcome = await fetch();
    expect(sent[0]!.url).toBe(`${RADAR_BASE}/traffic_anomalies?dateRange=1d&limit=100&format=json`);
    expect(outcome.ok && outcome.observations.map((observation) => observation.source)).toEqual([ANOMALIES_SOURCE]);
  });

  it("gives the failure auth for an unknown token (401) and for no token (400 with the code 9106), with no token in the message", async () => {
    const unknown = await fetchWith("outages", [{ status: 401, body: `{"success":false,"errors":[{"code":10000,"message":"Authentication error ${TOKEN}"}],"messages":[],"result":null}` }]).fetch();
    expect(unknown).toMatchObject({ ok: false, failure: { kind: "auth" } });
    expect(JSON.stringify(unknown)).not.toContain(TOKEN);
    const none = await fetchWith("outages", [{ status: 400, body: '{"success":false,"errors":[{"code":9106,"message":"Missing X-Auth-Key, X-Auth-Email or Authorization headers"}],"messages":[],"result":null}' }]).fetch();
    expect(none).toMatchObject({ ok: false, failure: { kind: "auth" } });
  });

  it("gives the failure refused for a 400 that does not tell of the token, and rate-limited for a 429", async () => {
    expect(await fetchWith("outages", [{ status: 400, body: '{"success":false,"errors":[{"code":1,"message":"Bad option"}]}' }]).fetch()).toMatchObject({ ok: false, failure: { kind: "refused" } });
    expect(await fetchWith("outages", [{ status: 429, headers: { "retry-after": "60" } }]).fetch()).toMatchObject({ ok: false, failure: { kind: "rate-limited" } });
  });

  it("gives the failure network for a cut answer, and server for an answer of a different form", async () => {
    expect(await fetchWith("outages", [{ status: 200, headers: JSON_HEADERS, body: OUTAGES.slice(0, 500) }]).fetch()).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(await fetchWith("outages", [{ status: 200, headers: JSON_HEADERS, body: ANOMALIES }]).fetch()).toMatchObject({ ok: false, failure: { kind: "server" } });
  });

  it("gives no time of the data for a list that is not complete", async () => {
    const page = JSON.parse(ANOMALIES) as { result: { trafficAnomalies: unknown[] } };
    const body = JSON.stringify({ ...page, result: { trafficAnomalies: [...page.result.trafficAnomalies, { type: "AS" }] } });
    const outcome = await fetchWith("anomalies", [{ status: 200, headers: JSON_HEADERS, body }]).fetch();
    expect(outcome).toMatchObject({ ok: true, complete: false });
    expect(outcome.ok && outcome.asOf).toBeUndefined();
  });
});
