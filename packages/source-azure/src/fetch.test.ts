import { readFileSync } from "node:fs";
import { readFeed, type FeedEntry } from "@mark1russell7/alerts-format-cap";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createAzureFetch, incidentBodies } from "./fetch.ts";
import { mapObservation } from "./map.ts";

/** The real feeds (`fixtures/README.md`). */
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const STORAGE = fixture("feed-20241227T041223Z.xml");
const EMPTY = fixture("feed-20241220T213324Z.xml");
const entriesOf = (xml: string): readonly FeedEntry[] => {
  const read = readFeed(xml);
  return read.ok ? read.entries : [];
};

const clock = { now: () => Date.parse("2024-12-27T04:12:23Z"), sleep: async () => {} };

type Reply = { status: number; headers?: Record<string, string>; body?: string };

/** This function makes a fetch whose transport gives the replies in order, and records the URL and the headers of each request. */
function fetchWith(replies: Reply[]) {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const fetch = createAzureFetch({
    pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
    transport: async (request) => {
      sent.push({ url: request.url, headers: { ...request.headers } });
      const reply = replies.shift()!;
      return { status: reply.status, statusText: "", headers: reply.headers ?? {}, body: reply.body ?? "" };
    },
    userAgent: "alerts-tests",
    minIntervalMs: 0,
  });
  return { fetch: () => fetch({ watch: { places: [] } }), sent };
}

const XML = { "content-type": "text/xml; charset=utf-8" };

describe("incidentBodies", () => {
  it("gives one body for the item of the real feed, with its key, its time, its categories and its text", () => {
    const incidents = incidentBodies(entriesOf(STORAGE));
    expect(incidents.complete).toBe(true);
    expect(incidents.bodies).toHaveLength(1);
    const body = JSON.parse(incidents.bodies[0]!) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["key", "title", "link", "published", "categories", "description"]);
    expect(body).toMatchObject({
      key: "active-storage-latency-timeouts-or-http-500-errors-in-south-central-us",
      title: "Active - Storage latency, timeouts, or HTTP 500 errors in South Central US",
      link: "https://status.azure.com/en-us/status/",
      published: "Thu, 26 Dec 2024 18:44:00 Z",
      categories: ["App Service", "Application Gateway", "Azure Cosmos DB", "Azure Sentinel", "Log Analytics", "Storage Accounts", "Virtual Machines", "South Central US", "Public Non-Regional"],
    });
    expect(body["description"]).toMatch(/^<p><strong>Impact Statement:<\/strong>/);
  });

  it("gives one body for two equal guids, and an item with no guid its own body with complete false", () => {
    const entries = entriesOf(STORAGE);
    expect(incidentBodies([...entries, ...entries]).bodies).toEqual(incidentBodies(entries).bodies);
    const loose = incidentBodies([...entries, { title: "No guid" }]);
    expect(loose.complete).toBe(false);
    expect(loose.bodies.at(-1)).toBe(JSON.stringify({ title: "No guid" }));
    expect(mapObservation({ id: "o" as never, source: "azure-status" as never, fetched: 0, contentType: "application/json", body: loose.bodies.at(-1)!, transport: { latency: 0 } }).problems).toEqual([
      { path: "", message: "the observation is not one incident of Azure Status: the format changed", fatal: true },
    ]);
  });

  it("gives no body and complete true for the feed with no incident", () => {
    expect(incidentBodies(entriesOf(EMPTY))).toEqual({ bodies: [], complete: true });
  });
});

describe("createAzureFetch", () => {
  it("sends one GET of the feed with the User-Agent, and gives one observation for each incident with no time of the data", async () => {
    const { fetch, sent } = fetchWith([{ status: 200, headers: XML, body: STORAGE }]);
    const outcome = await fetch();
    expect(sent.map((request) => request.url)).toEqual(["https://rssfeed.azure.status.microsoft/en-us/status/feed/"]);
    expect(sent[0]!.headers).toMatchObject({ "user-agent": "alerts-tests" });
    expect(sent[0]!.headers["if-none-match"]).toBeUndefined();
    expect(outcome).toMatchObject({ ok: true, complete: true });
    if (!outcome.ok) return;
    expect(outcome.asOf).toBeUndefined();
    expect(outcome.observations).toHaveLength(1);
    expect(outcome.observations[0]).toMatchObject({ source: "azure-status", contentType: "application/json", fetched: clock.now(), transport: { url: "https://rssfeed.azure.status.microsoft/en-us/status/feed/", status: 200 } });
    expect(outcome.observations[0]!.body).toBe(incidentBodies(entriesOf(STORAGE)).bodies[0]);
  });

  it("gives the same observation ids for the same feed, and no observation for the feed with no incident", async () => {
    const { fetch } = fetchWith([
      { status: 200, headers: XML, body: STORAGE },
      { status: 200, headers: XML, body: STORAGE },
      { status: 200, headers: XML, body: EMPTY },
    ]);
    const ids = async () => {
      const outcome = await fetch();
      return outcome.ok ? outcome.observations.map((observation) => observation.id) : ["failed"];
    };
    const first = await ids();
    expect(await ids()).toEqual(first);
    expect(await ids()).toEqual([]);
  });

  it("gives a network failure for a cut body and a server failure for a body that is not the feed", async () => {
    const { fetch } = fetchWith([
      { status: 200, headers: XML, body: STORAGE.slice(0, 900) },
      { status: 200, headers: XML, body: "<html><body>Error</body></html>" },
      { status: 503, headers: XML, body: "" },
    ]);
    expect(await fetch()).toMatchObject({ ok: false, failure: { kind: "network", message: "truncated or malformed body: https://rssfeed.azure.status.microsoft/en-us/status/feed/" } });
    expect(await fetch()).toMatchObject({ ok: false, failure: { kind: "server" } });
    expect(await fetch()).toMatchObject({ ok: false });
  });
});
