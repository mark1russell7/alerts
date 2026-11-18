import { readFileSync } from "node:fs";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { CATALOG_URL } from "./catalog.ts";
import { createCatalogFetch, type CatalogCopy } from "./catalog-fetch.ts";

// Thirteen real rows of the catalog of 2026-11-17 (CC0 1.0), with the contact column empty.
const CATALOG = readFileSync(new URL("../fixtures/mobility-database-20261117.csv", import.meta.url), "utf8");
const START = Date.parse("2026-11-18T04:00:00Z");

const csv = (body: string, headers: Record<string, string> = { etag: '"c1"', "last-modified": "Tue, 17 Nov 2026 04:02:41 GMT" }): Reply => ({
  status: 200,
  statusText: "OK",
  headers: { "content-type": "text/csv", ...headers },
  body,
});
const notModified: Reply = { status: 304, statusText: "Not Modified", headers: {}, body: "" };

/** This function makes a fetch of the catalog whose transport gives the replies in turn, and then the last reply again. */
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
  const fetch = createCatalogFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", timeoutMs: 1000 });
  return { fetch, sent, advance: (ms: number) => void (time += ms) };
};

describe("createCatalogFetch", () => {
  it("gives a copy with the text and the validators, and sends the validators of the copy in the next GET", async () => {
    const { fetch, sent, advance } = fetchWith([csv(CATALOG), notModified]);
    const first = await fetch(undefined);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.changed).toBe(true);
    expect(first.copy.text).toBe(CATALOG);
    expect(first.copy.condition).toMatchObject({ etag: '"c1"', lastModified: "Tue, 17 Nov 2026 04:02:41 GMT" });
    expect(sent[0]?.url).toBe(CATALOG_URL);
    expect(sent[0]?.headers).toMatchObject({ accept: "text/csv, text/plain;q=0.9", "user-agent": "alerts-tests" });

    advance(86_400_000);
    const second = await fetch(first.copy);
    expect(sent[1]?.headers).toMatchObject({ "if-none-match": '"c1"', "if-modified-since": "Tue, 17 Nov 2026 04:02:41 GMT" });
    expect(second.ok && second.changed).toBe(false);
    if (!second.ok) return;
    expect(second.copy.text).toBe(CATALOG);
    expect(second.copy.condition).toEqual(first.copy.condition);
    expect(second.copy.fetched).toBeGreaterThanOrEqual(first.copy.fetched + 86_400_000);
  });

  it("sends the validators of a copy from a file, with no fetch before it", async () => {
    const copy: CatalogCopy = { text: CATALOG, fetched: START - 86_400_000, condition: { etag: '"c0"', digest: "0".repeat(64) } };
    const { fetch, sent } = fetchWith([notModified]);
    const result = await fetch(copy);
    expect(sent[0]?.headers).toMatchObject({ "if-none-match": '"c0"' });
    expect(result.ok && result.changed).toBe(false);
    expect(result.ok && result.copy.text).toBe(CATALOG);
  });

  it("tells a change of the text", async () => {
    const lines = CATALOG.trimEnd().split("\n");
    const shorter = `${lines.slice(0, -1).join("\n")}\n`;
    const { fetch } = fetchWith([csv(CATALOG), csv(shorter, { etag: '"c2"' })]);
    const first = await fetch(undefined);
    if (!first.ok) throw new Error("the first fetch failed");
    const second = await fetch(first.copy);
    expect(second.ok && second.changed).toBe(true);
    expect(second.ok && second.copy.condition?.etag).toBe('"c2"');
  });

  it("fails for a 304 answer with no copy, for a text that is not the catalog, and for an answer that is not a success", async () => {
    expect(await fetchWith([notModified]).fetch(undefined)).toEqual({ ok: false, failure: { kind: "server", message: `a 304 answer with no earlier copy: ${CATALOG_URL}` } });
    const page = await fetchWith([csv("<html>maintenance</html>")]).fetch(undefined);
    expect(page.ok).toBe(false);
    expect(!page.ok && page.failure.message).toMatch(/^the answer is not the catalog \(the catalog has no rows\)/);
    const gone = await fetchWith([{ status: 503, statusText: "Service Unavailable", headers: {}, body: "" }]).fetch(undefined);
    expect(gone.ok).toBe(false);
  });
});
