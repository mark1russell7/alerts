import { readFileSync } from "node:fs";
import { observationId, type FetchOutcome, type PlaceId, type SourceId, type Watch } from "@mark1russell7/alerts";
import fc from "fast-check";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import type { CapFeed } from "./feed.ts";
import { createCapFeedFetch, SET_ASIDE_AFTER } from "./fetch.ts";

const fixture = (name: string): string => readFileSync(new URL(`../../format-cap/fixtures/${name}`, import.meta.url), "utf8");

/** The real index of the Niue feed on the hub of the WMO, and its five real messages (`format-cap/fixtures/index/README.md`). */
const INDEX = fixture("index/nu-gov-en.rss.xml");
const HUB = "https://cap-sources.s3.amazonaws.com/nu-gov-en";
const INDEX_URL = `${HUB}/rss.xml`;
const NAMES = ["2026-10-23-00-31-33", "2026-10-16-01-37-10", "2026-10-15-23-02-27", "2026-10-09-02-38-33", "2026-10-08-23-18-03"] as const;
const MESSAGES: ReadonlyMap<string, string> = new Map(
  NAMES.map((name, at) => [`${HUB}/${name}.xml`, at === 0 ? fixture("hub/oet-wind.xml") : fixture(`hub/nu-gov-en/${name}.xml`)]),
);
const URLS = [...MESSAGES.keys()];

const FEED: CapFeed = {
  id: "cap-feed-nu" as SourceId,
  title: "Niue Meteorological Service",
  url: INDEX_URL,
  origin: "nu-met",
  coverage: ["NU"],
  kinds: ["met"],
  dependsOn: ["provider:wmo-cap-hub"],
};

/** A place of the tests. The index is a fixed URL, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "NU" }], bufferKm: 0 }] };
const START = Date.parse("2026-11-16T18:00:00Z");
const LAST_MODIFIED = "Fri, 23 Oct 2026 00:32:00 GMT";

const xml = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/xml", ...headers }, body });
const NOT_MODIFIED: Reply = { status: 304, statusText: "Not Modified", headers: { "last-modified": LAST_MODIFIED }, body: "" };
const MISSING = xml("<Error><Code>NoSuchKey</Code></Error>", 404);
const DOWN = xml("", 503);

/** A rule of the fake hub: the reply to one exchange, or `undefined` for the normal reply. */
type Rule = (exchange: Exchange) => Reply | undefined;

/**
 * This function makes a fetch on a fake hub. The hub answers a conditional GET of the index with a 304. It answers the
 * URL of each message with the message. A rule changes a reply.
 */
const hub = (feed: CapFeed = FEED, index: () => string = () => INDEX) => {
  const sent: Exchange[] = [];
  const rules: Rule[] = [];
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    for (const rule of rules) {
      const reply = rule(exchange);
      if (reply !== undefined) return reply;
    }
    if (exchange.url === feed.url) return exchange.headers["if-modified-since"] === LAST_MODIFIED ? NOT_MODIFIED : xml(index(), 200, { "last-modified": LAST_MODIFIED });
    const message = MESSAGES.get(exchange.url);
    return message === undefined ? MISSING : xml(message, 200, { "content-type": "application/cap+xml" });
  };
  let time = START;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createCapFeedFetch({ feed, pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", minIntervalMs: 0, timeoutMs: 1000 });
  /** This function clears the list of sent exchanges, and gives the URLs that the fetch asked for. */
  const run = async (): Promise<{ outcome: FetchOutcome; asked: string[] }> => {
    sent.length = 0;
    const outcome = await fetch({ watch: WATCH });
    return { outcome, asked: sent.map((exchange) => exchange.url) };
  };
  /** This function moves the clock, as the wait of the runtime between two fetches. */
  const advance = (ms: number): void => void (time += ms);
  return { run, rules, sent, advance };
};

const urlsOf = (outcome: FetchOutcome): (string | undefined)[] => (outcome.ok ? outcome.observations.map((observation) => observation.transport.url) : []);
const failureOf = (outcome: FetchOutcome): unknown => (outcome.ok ? undefined : outcome.failure);
const completeOf = (outcome: FetchOutcome): boolean | undefined => (outcome.ok ? outcome.complete : undefined);

/** This rule gives a reply to one URL. */
const at = (url: string, reply: Reply): Rule => (exchange) => (exchange.url === url ? reply : undefined);

describe("createCapFeedFetch", () => {
  it("asks for the index and then for each message, and gives one observation of each whole message in the order of the index", async () => {
    const { run, sent } = hub();
    const { outcome, asked } = await run();
    expect(asked).toEqual([INDEX_URL, ...URLS]);
    expect(sent[0]?.headers).toMatchObject({ "user-agent": "alerts-tests" });
    expect(sent[0]?.headers["accept"]).toContain("application/rss+xml");
    expect(sent[1]?.headers["accept"]).toContain("application/cap+xml");
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(outcome.ok && outcome.cursor).toBeUndefined();
    expect(urlsOf(outcome)).toEqual(URLS);
    const first = outcome.ok ? outcome.observations[0] : undefined;
    const body = MESSAGES.get(URLS[0] as string) as string;
    expect(first).toEqual({
      id: observationId({ source: FEED.id, contentType: "application/cap+xml", url: URLS[0] as string, body }),
      source: FEED.id,
      fetched: START,
      contentType: "application/cap+xml",
      body,
      transport: { url: URLS[0], status: 200, latency: 0 },
    });
  });

  it("sends the Last-Modified time of the last full index, and asks for no message after a 304 of the index", async () => {
    const { run, sent } = hub();
    await run();
    expect(await run()).toEqual({ outcome: { ok: true, observations: [], complete: true }, asked: [INDEX_URL] });
    expect(sent[0]?.headers["if-modified-since"]).toBe(LAST_MODIFIED);
  });

  it("gives each new message once: a changed index gives only its new entries", async () => {
    let index = INDEX;
    const fake = hub(FEED, () => index);
    fake.rules.push(at(`${URLS[1]}?v=2`, xml(MESSAGES.get(URLS[1] as string) as string)));
    await fake.run();
    index = INDEX.replace("<item>", () => `<item><guid>urn:test:new</guid><link>${URLS[1] as string}?v=2</link></item><item>`);
    // The index changed, so its conditional GET gets a full answer.
    fake.rules.push((exchange) => (exchange.url === INDEX_URL ? xml(index, 200, { "last-modified": "Sat, 24 Oct 2026 00:00:00 GMT" }) : undefined));
    const { outcome, asked } = await fake.run();
    expect(asked).toEqual([INDEX_URL, `${URLS[1] as string}?v=2`]);
    expect(urlsOf(outcome)).toEqual([`${URLS[1] as string}?v=2`]);
    expect(completeOf(outcome)).toBe(true);
  });

  it("asks for at most perFetch messages in one fetch, and asks for the others in the next fetches", async () => {
    const { run } = hub({ ...FEED, perFetch: 2 });
    const first = await run();
    expect(first.asked).toEqual([INDEX_URL, URLS[0], URLS[1]]);
    expect(completeOf(first.outcome)).toBe(false);
    const second = await run();
    expect(second.asked).toEqual([INDEX_URL, URLS[2], URLS[3]]);
    expect(urlsOf(second.outcome)).toEqual([URLS[2], URLS[3]]);
    expect(completeOf(second.outcome)).toBe(false);
    const third = await run();
    expect(third.asked).toEqual([INDEX_URL, URLS[4]]);
    expect(urlsOf(third.outcome)).toEqual([URLS[4]]);
    expect(completeOf(third.outcome)).toBe(true);
  });

  it("goes on after a refused message, fails a fetch with only failures, and sets the message aside after its last try", async () => {
    const { run, rules } = hub();
    rules.push(at(URLS[1] as string, MISSING));
    const first = await run();
    expect(first.asked).toEqual([INDEX_URL, ...URLS]);
    expect(urlsOf(first.outcome)).toEqual([URLS[0], URLS[2], URLS[3], URLS[4]]);
    expect(completeOf(first.outcome)).toBe(false);
    for (let tries = 2; tries <= SET_ASIDE_AFTER; tries += 1) {
      const next = await run();
      expect(next.asked).toEqual([INDEX_URL, URLS[1]]);
      expect(failureOf(next.outcome)).toMatchObject({ kind: "refused" });
    }
    // The message is aside: the fetch does not ask for it, and the list is not complete.
    expect(await run()).toEqual({ outcome: { ok: true, observations: [], complete: false }, asked: [INDEX_URL] });
  });

  it("asks again for a message that is aside when the index changes its entry", async () => {
    let index = INDEX;
    const fake = hub(FEED, () => index);
    fake.rules.push((exchange) => (exchange.url === URLS[1] && !exchange.url.includes("?") && index === INDEX ? MISSING : undefined));
    for (let tries = 0; tries < SET_ASIDE_AFTER; tries += 1) await fake.run();
    index = INDEX.replace("<pubDate>Fri, 16 Oct 2026 01:37:10 +0000</pubDate>", () => "<pubDate>Fri, 16 Oct 2026 01:40:00 +0000</pubDate>");
    fake.rules.unshift((exchange) => (exchange.url === INDEX_URL ? xml(index) : undefined));
    const { outcome, asked } = await fake.run();
    expect(asked).toEqual([INDEX_URL, URLS[1]]);
    expect(urlsOf(outcome)).toEqual([URLS[1]]);
    expect(completeOf(outcome)).toBe(true);
  });

  it("stops at a failure of the host, gives the messages of the fetch, and asks for the others in the next fetch", async () => {
    const { run, rules } = hub();
    let down = true;
    rules.push((exchange) => (down && exchange.url === URLS[2] ? DOWN : undefined));
    const first = await run();
    expect(first.asked).toEqual([INDEX_URL, URLS[0], URLS[1], URLS[2]]);
    expect(urlsOf(first.outcome)).toEqual([URLS[0], URLS[1]]);
    expect(completeOf(first.outcome)).toBe(false);
    // The host is still down: no new message, so the fetch fails.
    const second = await run();
    expect(second.asked).toEqual([INDEX_URL, URLS[2]]);
    expect(failureOf(second.outcome)).toMatchObject({ kind: "server" });
    down = false;
    const third = await run();
    expect(third.asked).toEqual([INDEX_URL, URLS[2], URLS[3], URLS[4]]);
    expect(urlsOf(third.outcome)).toEqual([URLS[2], URLS[3], URLS[4]]);
    expect(completeOf(third.outcome)).toBe(true);
  });

  it("counts a cut message as a failed try, and keeps no observation of it", async () => {
    const { run, rules } = hub();
    const body = MESSAGES.get(URLS[0] as string) as string;
    rules.push(at(URLS[0] as string, xml(body.slice(0, body.indexOf("</cap:alert>")))));
    const { outcome } = await run();
    expect(urlsOf(outcome)).toEqual(URLS.slice(1));
    expect(completeOf(outcome)).toBe(false);
    rules.length = 0;
    expect(urlsOf((await run()).outcome)).toEqual([URLS[0]]);
  });

  it("fails for a cut index, an answer that is not an index, and a 304 with no earlier answer, and then sends no condition", async () => {
    const cases: readonly [Reply, string][] = [
      [xml(INDEX.slice(0, INDEX.indexOf("</channel>")), 200, { "last-modified": LAST_MODIFIED }), "network"],
      [xml(MESSAGES.get(URLS[0] as string) as string, 200, { "last-modified": LAST_MODIFIED }), "server"],
      [NOT_MODIFIED, "network"],
    ];
    for (const [reply, kind] of cases) {
      const { run, rules, sent } = hub();
      let first = true;
      rules.push((exchange) => (exchange.url === INDEX_URL && first ? ((first = false), reply) : undefined));
      const { outcome } = await run();
      expect(failureOf(outcome)).toMatchObject({ kind });
      const next = await run();
      expect(sent[0]?.headers["if-modified-since"]).toBeUndefined();
      expect(urlsOf(next.outcome)).toEqual(URLS);
    }
  });

  it("does not follow a link to another base, unless the config names the base", async () => {
    const other = "https://alerts.example.org/cap/1.xml";
    const index = INDEX.replace("<item>", () => `<item><guid>urn:test:other</guid><link>${other}</link></item><item>`);
    const closed = hub(FEED, () => index);
    const { outcome, asked } = await closed.run();
    expect(asked).toEqual([INDEX_URL, ...URLS]);
    expect(urlsOf(outcome)).toEqual(URLS);
    expect(completeOf(outcome)).toBe(false);
    const open = hub({ ...FEED, messageBases: ["https://alerts.example.org"] }, () => index);
    open.rules.push(at(other, xml(MESSAGES.get(URLS[0] as string) as string)));
    const opened = await open.run();
    expect(opened.asked).toEqual([INDEX_URL, other, ...URLS]);
    expect(completeOf(opened.outcome)).toBe(true);
  });

  it("fails a fetch whose only new entry links to another base, once", async () => {
    let index = INDEX;
    const fake = hub(FEED, () => index);
    await fake.run();
    index = INDEX.replace("<item>", () => "<item><guid>urn:test:other</guid><link>http://cap-sources.s3.amazonaws.com/x.xml</link></item><item>");
    fake.rules.push((exchange) => (exchange.url === INDEX_URL ? xml(index) : undefined));
    expect(failureOf((await fake.run()).outcome)).toMatchObject({ kind: "refused", message: expect.stringContaining("is not on a base of the feed") });
    expect((await fake.run()).outcome).toEqual({ ok: true, observations: [], complete: false });
  });

  it("resolves a relative link on the URL of the index", async () => {
    const index = INDEX.replace(`<link>${URLS[0] as string}</link>`, () => `<link>${NAMES[0]}.xml</link>`);
    const { run } = hub(FEED, () => index);
    const { outcome } = await run();
    expect(urlsOf(outcome)).toEqual(URLS);
  });

  it("gives each observation of the index in each complete fetch of a snapshot feed, and only the new ones before", async () => {
    let index = INDEX;
    const fake = hub({ ...FEED, listing: "snapshot", perFetch: 3 }, () => index);
    expect(urlsOf((await fake.run()).outcome)).toEqual(URLS.slice(0, 3));
    expect(urlsOf((await fake.run()).outcome)).toEqual(URLS);
    expect(urlsOf((await fake.run()).outcome)).toEqual(URLS);
    // An entry that leaves the index leaves the list.
    index = INDEX.replace(/<item>(?:(?!<\/item>)[^])*2026-10-08-23-18-03(?:(?!<\/item>)[^])*<\/item>/, () => "");
    fake.rules.push((exchange) => (exchange.url === INDEX_URL ? xml(index) : undefined));
    expect(urlsOf((await fake.run()).outcome)).toEqual(URLS.slice(0, 4));
  });

  it("throws when the signal of the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("the limit of the fetch"));
    const fetch = createCapFeedFetch({
      feed: FEED,
      pace: { scheduler: new HostScheduler({ now: () => 0, sleep: async () => {} }, 1), now: () => 0 },
      transport: async () => xml(INDEX),
      userAgent: "alerts-tests",
    });
    await expect(fetch({ watch: WATCH }, controller.signal)).rejects.toThrow();
  });

  it("refuses a config with problems", () => {
    const make = (feed: CapFeed) => () => createCapFeedFetch({ feed, pace: { scheduler: new HostScheduler({ now: () => 0, sleep: async () => {} }, 1), now: () => 0 }, transport: async () => xml(""), userAgent: "alerts-tests" });
    expect(make({ ...FEED, url: "http://cap-sources.s3.amazonaws.com/nu-gov-en/rss.xml" })).toThrow(/not an https URL/);
    expect(make({ ...FEED, perFetch: 0 })).toThrow(/integer of 1 or more/);
  });

  it("gives each message at most once, and only whole messages, for any order of failures", async () => {
    const replies = fc.constantFrom("ok", "missing", "down", "cut", "throw");
    await fc.assert(
      fc.asyncProperty(fc.array(replies, { maxLength: 40 }), fc.integer({ min: 1, max: 6 }), async (plan, perFetch) => {
        const fake = hub({ ...FEED, perFetch });
        let step = 0;
        let stormy = true;
        fake.rules.push((exchange) => {
          if (!stormy) return undefined;
          const kind = plan[step++ % Math.max(plan.length, 1)] ?? "ok";
          if (kind === "missing") return MISSING;
          if (kind === "down") return DOWN;
          if (kind === "throw") throw new Error("the link of the test is down");
          if (kind === "cut" && exchange.url !== INDEX_URL) return xml((MESSAGES.get(exchange.url) ?? "").slice(0, 100));
          return undefined;
        });
        const given: string[] = [];
        for (let fetch = 0; fetch < 8; fetch += 1) {
          given.push(...urlsOf((await fake.run()).outcome).map(String));
          fake.advance(60_000);
        }
        stormy = false;
        // polite-crawler holds back a host after its failures. The hold ends in less than one hour.
        fake.advance(3_600_000);
        let last: FetchOutcome | undefined;
        for (let fetch = 0; fetch < 8; fetch += 1) {
          last = (await fake.run()).outcome;
          given.push(...urlsOf(last).map(String));
          fake.advance(60_000);
        }
        expect(new Set(given).size).toBe(given.length);
        for (const url of given) expect(URLS).toContain(url);
        // After the storm, each message comes, or the fetch tells that the list is not complete.
        expect(last?.ok).toBe(true);
        if (completeOf(last as FetchOutcome) === true) expect(new Set(given)).toEqual(new Set(URLS));
        else expect(given.length).toBeLessThan(URLS.length);
      }),
      { numRuns: 150 },
    );
  });
});
