import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, Watch, WatchedPlace } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createIpawsFetch, CURSOR_SINCE, FEED_PATH, feedTime, keeps, LOOKBACK_MS, OVERLAP_MS, sinceOf } from "./fetch.ts";

const fixture = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
/** The real answer of the feed when IPAWS has no new alert. */
const EMPTY = fixture("../fixtures/feed-empty.xml");
/** The real IPAWS copies of one flash flood warning of a Texas office. Their home is the package `format-cap`. */
const NEW_ALERT = fixture("../../format-cap/fixtures/pairs/kewx-ff-w-0108-new.ipaws.xml");
const EXT_ALERT = fixture("../../format-cap/fixtures/pairs/kewx-ff-w-0108-ext.ipaws.xml");
/** This function puts alerts into the real envelope of the feed. */
const feedOf = (...alerts: string[]): string => EMPTY.replace("</ns1:alerts>", `${alerts.join("")}</ns1:alerts>`);

/** A message of a different authority. It is not a real message: the sender is a test domain and the status is Test. */
const authority = (geocodes: string): string =>
  `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>TEST-${String(geocodes.length)}</identifier><sender>alerts@example.org</sender><sent>2026-11-15T00:00:00-00:00</sent><status>Test</status><msgType>Alert</msgType><scope>Public</scope><info><category>Safety</category><event>Test Message</event><urgency>Unknown</urgency><severity>Unknown</severity><certainty>Unknown</certainty><area><areaDesc>A test area</areaDesc>${geocodes}</area></info></alert>`;
const same = (code: string): string => `<geocode><valueName>SAME</valueName><value>${code}</value></geocode>`;
const ugc = (code: string): string => `<geocode><valueName>UGC</valueName><value>${code}</value></geocode>`;

/** A place of the tests. The codes are public regions, not the places of an owner. */
const place = (id: string, codes: WatchedPlace["codes"]): WatchedPlace => ({ id: id as PlaceId, codes, bufferKm: 0 });
const KANSAS = place("a", [{ system: "ugc", code: "KSZ083" }]);

const BASE = "https://ipaws.test/rest";
const START = Date.parse("2026-11-15T00:00:00.400Z");

/** A clock of the tests: each wait moves the time at once. */
const testClock = (): { now: () => number; sleep: (ms: number) => Promise<void>; move: (ms: number) => void } => {
  let time = START;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    move: (ms) => {
      time += ms;
    },
  };
};

const xml = (body: string, status = 200, headers: Record<string, string> = {}): Reply => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { "content-type": "application/xml", ...headers },
  body,
});

/** This function makes a fetch whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly (Reply | ((exchange: Exchange, signal: AbortSignal | undefined) => Promise<Reply>))[], timeoutMs = 1000) => {
  const sent: Exchange[] = [];
  let index = 0;
  const transport: Transport = async (exchange, signal) => {
    sent.push(exchange);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply === undefined) throw new Error("no reply");
    return typeof reply === "function" ? reply(exchange, signal) : reply;
  };
  const clock = testClock();
  const fetch = createIpawsFetch({
    pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
    transport,
    userAgent: "alerts-tests",
    baseUrl: `${BASE}//`,
    minIntervalMs: 0,
    timeoutMs,
  });
  return { fetch, sent, clock };
};

const watch: Watch = { places: [KANSAS] };
const failureOf = (outcome: FetchOutcome): unknown => (outcome.ok ? undefined : outcome.failure);

describe("feedTime and sinceOf", () => {
  it("gives the time to the second, in UTC, with no part of a second", () => {
    expect(feedTime(START)).toBe("2026-11-15T00:00:00Z");
    expect(feedTime(Date.parse("2026-11-15T06:07:08.999Z"))).toBe("2026-11-15T06:07:08Z");
  });

  it("asks for the full window with no cursor, and tells of a gap for an old or a bad cursor", () => {
    const floor = START - LOOKBACK_MS;
    expect(sinceOf(undefined, START)).toEqual({ since: floor, complete: true });
    expect(sinceOf({}, START)).toEqual({ since: floor, complete: true });
    expect(sinceOf({ [CURSOR_SINCE]: feedTime(floor - 60_000) }, START)).toEqual({ since: floor, complete: false });
    expect(sinceOf({ [CURSOR_SINCE]: "yesterday" }, START)).toEqual({ since: floor, complete: false });
  });

  it("asks from the cursor, and not after the time of the fetch", () => {
    expect(sinceOf({ [CURSOR_SINCE]: "2026-11-14T23:50:00Z" }, START)).toEqual({ since: Date.parse("2026-11-14T23:50:00Z"), complete: true });
    expect(sinceOf({ [CURSOR_SINCE]: "2026-11-15T01:00:00Z" }, START)).toEqual({ since: START, complete: true });
  });
});

describe("keeps", () => {
  it("keeps each alert of the NWS, also out of the watched states", () => {
    expect(keeps(NEW_ALERT, new Set(["KS"]))).toBe(true);
  });

  it("keeps an alert of a different authority only in a watched state", () => {
    const states = new Set(["KS"]);
    expect(keeps(authority(same("020173")), states)).toBe(true);
    expect(keeps(authority(ugc("KSC173")), states)).toBe(true);
    expect(keeps(authority(same("048019")), states)).toBe(false);
    expect(keeps(authority(same("048019") + same("020173")), states)).toBe(true);
    expect(keeps(authority(same("048019")), undefined)).toBe(true);
  });

  it("keeps an alert with no code of a state, and an alert that does not read", () => {
    const states = new Set(["KS"]);
    expect(keeps(authority(""), states)).toBe(true);
    expect(keeps(authority(same("000000")), states)).toBe(true);
    expect(keeps("<alert>", states)).toBe(true);
  });
});

describe("createIpawsFetch", () => {
  it("asks for the full window, and gives the cursor of the next fetch for an empty feed", async () => {
    const { fetch, sent } = fetchWith([xml(EMPTY)]);
    const outcome = await fetch({ watch });
    expect(outcome).toEqual({ ok: true, observations: [], cursor: { [CURSOR_SINCE]: feedTime(START - OVERLAP_MS) }, complete: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${BASE}${FEED_PATH}/${feedTime(START - LOOKBACK_MS)}`);
    expect(sent[0]?.method).toBe("GET");
    expect(sent[0]?.headers).toEqual({ accept: "application/xml", "user-agent": "alerts-tests" });
  });

  it("gives one observation for each alert, with the real URL in the transport", async () => {
    const { fetch, sent } = fetchWith([xml(feedOf(NEW_ALERT, authority(same("048019")), EXT_ALERT))]);
    const outcome = await fetch({ watch, cursor: { [CURSOR_SINCE]: "2026-11-14T23:50:00Z" } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(sent[0]?.url).toBe(`${BASE}${FEED_PATH}/2026-11-14T23:50:00Z`);
    // The alert of a different authority in Texas is out of the watched states (Kansas)
    expect(outcome.observations.map((observation) => observation.body)).toEqual([NEW_ALERT, EXT_ALERT]);
    expect(new Set(outcome.observations.map((observation) => observation.id)).size).toBe(2);
    expect(outcome.observations[0]).toMatchObject({ source: "ipaws", fetched: START, contentType: "application/xml", transport: { url: sent[0]?.url, status: 200 } });
    expect(outcome.cursor).toEqual({ [CURSOR_SINCE]: "2026-11-14T23:55:00Z" });
    expect(outcome.complete).toBe(true);
  });

  it("gives one id to one alert in two answers that ask with two times", async () => {
    const { fetch, sent, clock } = fetchWith([xml(feedOf(NEW_ALERT)), xml(feedOf(EXT_ALERT, NEW_ALERT))]);
    const first = await fetch({ watch });
    clock.move(60_000);
    if (!first.ok || first.cursor === undefined) throw new Error("the first fetch failed");
    const second = await fetch({ watch, cursor: first.cursor });
    expect(sent[0]?.url).not.toBe(sent[1]?.url);
    if (!second.ok) throw new Error("the second fetch failed");
    expect(second.observations[1]?.id).toBe(first.observations[0]?.id);
    expect(second.observations[1]?.transport.url).not.toBe(first.observations[0]?.transport.url);
  });

  it("tells of a gap when the cursor is older than the window of the feed", async () => {
    const { fetch, sent } = fetchWith([xml(EMPTY)]);
    const outcome = await fetch({ watch, cursor: { [CURSOR_SINCE]: "2026-11-14T20:00:00Z" } });
    expect(sent[0]?.url).toBe(`${BASE}${FEED_PATH}/${feedTime(START - LOOKBACK_MS)}`);
    expect(outcome).toMatchObject({ ok: true, complete: false });
  });

  it("fails for a cut answer, and gives no cursor", async () => {
    const whole = feedOf(NEW_ALERT, EXT_ALERT);
    for (const body of [whole.slice(0, whole.length - 3), whole.slice(0, NEW_ALERT.length), ""]) {
      const { fetch } = fetchWith([xml(body)]);
      const outcome = await fetch({ watch });
      expect(outcome.ok).toBe(false);
      expect(failureOf(outcome)).toMatchObject({ kind: "network", message: expect.stringMatching(/^truncated or malformed body/) });
    }
  });

  it("gives one observation of the whole body, and a gap, for a whole answer that is not the feed", async () => {
    const page = "<html><head><title>Just a moment...</title></head><body></body></html>";
    const { fetch } = fetchWith([xml(page, 200, { "content-type": "text/html" })]);
    const outcome = await fetch({ watch });
    expect(outcome).toMatchObject({ ok: true, complete: false, observations: [{ body: page, contentType: "text/html" }] });
  });

  it("maps the failures of the server", async () => {
    const cases: readonly [Reply, unknown][] = [
      [xml("", 429, { "retry-after": "120" }), { kind: "rate-limited", retryAfter: 120_000 }],
      [xml("", 503), { kind: "server" }],
      [xml("", 500), { kind: "server" }],
      [xml("", 401), { kind: "auth" }],
      [xml("", 403), { kind: "refused" }],
      [xml("", 404), { kind: "refused" }],
    ];
    for (const [reply, failure] of cases) {
      const { fetch } = fetchWith([reply]);
      const outcome = await fetch({ watch });
      expect(outcome.ok, String(reply.status)).toBe(false);
      expect(failureOf(outcome), String(reply.status)).toMatchObject(failure as object);
    }
  });

  it("gives a network failure when the transport fails, and a timeout when the request takes too long", async () => {
    const broken = fetchWith([
      async () => {
        throw new Error("connection reset");
      },
    ]);
    expect(failureOf(await broken.fetch({ watch }))).toMatchObject({ kind: "network", message: expect.stringContaining("connection reset") });

    const slow = fetchWith(
      [
        (_exchange, signal) =>
          new Promise<Reply>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
          }),
      ],
      20,
    );
    expect(failureOf(await slow.fetch({ watch }))).toMatchObject({ kind: "timeout" });
  });

  it("throws when the signal of the caller aborts", async () => {
    const { fetch } = fetchWith([
      (_exchange, signal) =>
        new Promise<Reply>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
        }),
    ]);
    const controller = new AbortController();
    const pending = fetch({ watch }, controller.signal);
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow();
  });
});
