import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeClock, type FakeClock, type WallClock } from "@mark1russell7/algebra/clock";
import { CONFIG_FORMAT, matchPlaces, parseConfig, type AlertConfig, type Watch, type ChannelId, type EscalationPolicy, type PersonId, type PlaceId, type SecretLookup, type SourceId } from "@mark1russell7/alerts";
import { PUSHOVER_QUOTA, PUSHOVER_RESERVE_NOTICES, PUSHOVER_TIMEOUT_MS, type PushoverChannelOptions } from "@mark1russell7/alerts-channel-pushover";
import { memoryCache, type ShapeCache } from "@mark1russell7/alerts-shapes-nws";
import { CANARY_PATH, createNwsSource } from "@mark1russell7/alerts-source-nws-api";
import { quotaGate, type Exchange, type Transport } from "polite-crawler/api";
import { DEFAULT_POLICY } from "polite-crawler/politeness";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKS_KEY, checksKeys, DAEMON_CHECK, DELIVERY_TIMES, INSTANCE_CHANNELS, INSTANCE_CHECK, INSTANCE_SOURCES, INSTANCE_TIMES, instanceProblems, LOUD_PING_URL_KEY, openInstance, PING_URL_KEY, pingTargets, SOURCE_POLICY, sourcePace, USER_AGENT_NAME, type Instance, type InstanceOptions } from "./instance.ts";
import { overdueLimit } from "./delivery.ts";
import type { ShapeOutcome } from "./shapes.ts";
import { nextFetch } from "./view.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";

// The Flood Warning was sent at 14:54 UTC on 2026-11-14, and it expires at 06:00 UTC on 2026-11-15.
// The keepalive was sent at 22:44:55 UTC. Thus at T0 the warning is active, and the keepalive is recent.
const T0 = Date.UTC(2026, 10, 14, 22, 50);
/** The host of the NWS API. */
const HOST = "api.weather.gov";
const MINUTE = 60_000;
const pushover = "pushover" as ChannelId;
const person = "person-1" as PersonId;
const place = "place-1" as PlaceId;

// A public point in McMullen County TX, in the polygon of the recorded Flood Warning. The polygon decides the
// match, not the county code. No request of a source holds the point.
const LONGITUDE = -98.55;
const LATITUDE = 28.3;

const policy = (level: EscalationPolicy["level"]): EscalationPolicy => ({ level, steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 20 * MINUTE });

const CONFIG: AlertConfig = {
  format: CONFIG_FORMAT,
  places: [
    {
      id: place,
      label: "Place",
      at: [LONGITUDE, LATITUDE],
      codes: [
        { system: "state", code: "TX" },
        { system: "ugc", code: "TXC311" },
        { system: "same", code: "048311" },
        { system: "iso3166", code: "US" },
      ],
      bufferKm: 5,
    },
  ],
  people: [{ watch: { person, places: [place], rules: [] } }],
  contacts: [{ person, channel: pushover, address: { user: { secret: "PUSHOVER_USER_KEY" } } }],
  policies: [policy("life-safety"), policy("urgent"), policy("notice")],
};

// Fake keys: 30 letters and digits, as Pushover keys are. A test looks for them in each message.
const SECRETS = { PUSHOVER_APP_TOKEN: "t".repeat(30), PUSHOVER_USER_KEY: "u".repeat(30) };
const store =
  (values: Readonly<Record<string, string>>): SecretLookup =>
  (name) =>
    values[name];

/** This function reads a recorded answer of a source package. */
function fixture(source: string, name: string): string {
  const root = dirname(createRequire(import.meta.url).resolve(`@mark1russell7/${source}/package.json`));
  return readFileSync(join(root, "fixtures", name), "utf8");
}

/**
 * A fake network with recorded answers. The NWS API gives the Flood Warning to the request of the
 * state, the keepalive to the canary, and no alert to the WEA request. The IPAWS feed has no alert.
 * Each exchange takes `delay` milliseconds of real time, as on a busy runner. With `Infinity`, no exchange ends.
 */
function network(delay = 0) {
  const exchanges: Exchange[] = [];
  const collection = (...names: string[]): string => JSON.stringify({ type: "FeatureCollection", features: names.map((name) => JSON.parse(fixture("alerts-source-nws-api", name))) });
  const nws: Readonly<Record<string, string>> = { "/alerts/active?area=TX": collection("nws-flw.json"), [CANARY_PATH]: collection("nws-keepalive.json") };
  const transport: Transport = async (exchange) => {
    exchanges.push(exchange);
    if (delay === Infinity) await new Promise<never>(() => undefined);
    if (delay > 0) await pause(delay);
    const url = new URL(exchange.url);
    if (url.hostname === "apps.fema.gov") return { status: 200, statusText: "OK", headers: { "content-type": "application/xml" }, body: fixture("alerts-source-ipaws", "feed-empty.xml") };
    if (url.hostname !== "api.weather.gov") throw new Error(`The fake network has no route to ${url.hostname}.`);
    const body = nws[url.pathname + url.search] ?? collection();
    return { status: 200, statusText: "OK", headers: { "content-type": "application/geo+json" }, body };
  };
  return { transport, exchanges };
}

// The outlines of a county and a forecast zone that contain the place. TXZ230 is a code of these tests only.
const zoneSquare = (west: number, south: number, size: number): number[][] => [
  [west, south],
  [west + size, south],
  [west + size, south + size],
  [west, south + size],
  [west, south],
];
const ZONE_ANSWERS: Readonly<Record<string, string>> = {
  "/zones?area=TX&type=county": JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: null, properties: { id: "TXC311", type: "county", name: "County" } }] }),
  "/zones?area=TX&type=forecast": JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: null, properties: { id: "TXZ230", type: "public", name: "Zone" } }] }),
  "/zones/county/TXC311": JSON.stringify({ type: "Feature", geometry: { type: "Polygon", coordinates: [zoneSquare(-99, 28, 1)] }, properties: { id: "TXC311", name: "County" } }),
  "/zones/forecast/TXZ230": JSON.stringify({ type: "Feature", geometry: { type: "Polygon", coordinates: [zoneSquare(-98.6, 28.2, 0.2)] }, properties: { id: "TXZ230", name: "Zone" } }),
};

/** This function adds the answers of the zone service to a fake network. */
function withZones(net: ReturnType<typeof network>): Transport {
  return async (exchange, signal) => {
    const url = new URL(exchange.url);
    const body = url.hostname === "api.weather.gov" ? ZONE_ANSWERS[url.pathname + url.search] : undefined;
    if (body === undefined) return net.transport(exchange, signal);
    net.exchanges.push(exchange);
    return { status: 200, statusText: "OK", headers: { "content-type": "application/geo+json" }, body };
  };
}

/** A fake Pushover server. It accepts each message. */
function pushoverServer() {
  const calls: Array<{ url: string; fields: Record<string, string> }> = [];
  const fetch: PushoverChannelOptions["fetch"] = async (url, init) => {
    calls.push({ url, fields: Object.fromEntries(new URLSearchParams(init.body ?? "")) });
    const body = { status: 1, request: `request-${calls.length}`, receipt: `receipt-${calls.length}` };
    return { status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
  };
  return { fetch, calls };
}

// The limit of each fetch in these tests. With the interval of 60 s, a stall of 1.2 s of real time stops a fetch.
const TEST_FETCH_LIMIT = 60 * 60 * 1000;

// The real time between two steps of the fake clock. In this time, the microtasks, the callbacks and the real work of a step end.
const REAL_STEP_MS = 20;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This function moves the clock in steps of one second until the work ends. The waits of the pace of the sources end in the steps.
 * Before each step, it waits `REAL_STEP_MS` of real time. Thus slow real work does not move the fake time. On a busy runner, a step
 * after each turn of the event loop moved the clock 60 seconds in one fetch.
 * Then the limit of the fetch stopped the NWS source.
 */
async function finish<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let done = false;
  work.then(
    () => (done = true),
    () => (done = true),
  );
  for (let step = 0; !done && step < 10 * 60; step++) {
    await pause(REAL_STEP_MS);
    if (!done) await clock.advance(1000);
  }
  return work;
}

/** This function gives the message of the error of a start. */
function messageOf(start: () => unknown): string {
  try {
    start();
  } catch (error) {
    return String(error);
  }
  throw new Error("The start did not throw.");
}

let opened: { log: RuntimeLog; folder: string }[] = [];

afterEach(() => {
  for (const { log, folder } of opened) {
    log.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  }
  opened = [];
});

/** The contact of an operator in the tests. The domain is the example domain of RFC 2606. */
const CONTACT = "mailto:operator@example.org";

/** This function opens an instance. The limit `"interval"` keeps the default limit of each fetch: the interval of the source. */
function open(secret: SecretLookup = store(SECRETS), config: AlertConfig = CONFIG, delay = 0, fetchLimit: number | "interval" = TEST_FETCH_LIMIT, more: Partial<InstanceOptions> = {}) {
  // The entry reads the configuration so: a refused parse stops the start before the instance.
  const parsed = parseConfig(JSON.stringify(config), INSTANCE_CHANNELS, secret);
  if (parsed.tag === "err") throw new Error(parsed.error.join("\n"));
  const folder = mkdtempSync(join(tmpdir(), "alerts-instance-"));
  const log = openRuntimeLog(join(folder, "runtime.sqlite"));
  opened.push({ log, folder });
  const clock = fakeClock(T0);
  // The fake clock starts at T0. Thus its time is also the instant of the test.
  const wall: WallClock = { time: "wall", now: () => clock.now(), after: (ms, run) => clock.after(ms, run) };
  const net = network(delay);
  const server = pushoverServer();
  const instance: Instance = openInstance({ config: parsed.value, secret, log, clock, wall, transport: net.transport, pushover: server.fetch, run: "run-1", ...(fetchLimit === "interval" ? {} : { fetchLimit: () => fetchLimit }), ...more });
  return { instance, clock, net, server };
}

describe("openInstance", () => {
  it("sends a recorded NWS warning for a watched county to the person on Pushover", async () => {
    const { instance, clock, net, server } = await open();
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched).toEqual(["nws-api", "ipaws"]);
    // A fetch that ran out of time names its cause here, before the checks of the send.
    expect(pass.view?.health.map((health) => [health.source, health.state])).toEqual([
      ["nws-api", "healthy"],
      ["ipaws", "healthy"],
    ]);
    expect(server.calls).toHaveLength(1);
    const [call] = server.calls;
    expect(call?.url).toBe("https://api.pushover.net/1/messages.json");
    expect(call?.fields).toMatchObject({ token: SECRETS["PUSHOVER_APP_TOKEN"], user: SECRETS["PUSHOVER_USER_KEY"] });
    expect(call?.fields["title"]).toContain("Flood Warning");
    // The body starts with the why line, with the label of the place from the configuration.
    expect(call?.fields["message"]).toMatch(/^Why: Place is in the area\n\n\S/);
    expect(pass.delivery?.sent).toHaveLength(1);
    // The source asks for the alerts of the state. The match to the county is local.
    expect(net.exchanges.map((exchange) => exchange.url)).toContain("https://api.weather.gov/alerts/active?area=TX");
  });

  it("gives the gate of the month to the Pushover channel: a send counts, and the reserve stops a send below life-safety", async () => {
    const gate = quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", now: () => T0 });
    const counted = await open(undefined, undefined, undefined, undefined, { pushoverQuota: gate });
    await finish(counted.clock, counted.instance.runtime.pass());
    expect(counted.server.calls).toHaveLength(1);
    const priority = counted.server.calls[0]?.fields["priority"];
    expect(priority).not.toBe("2");
    expect(gate.state().used).toBe(1);

    const full = quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", now: () => T0 });
    full.note({ remaining: 1_000 });
    const held = await open(undefined, undefined, undefined, undefined, { pushoverQuota: full });
    const pass = await finish(held.clock, held.instance.runtime.pass());
    expect(held.server.calls).toEqual([]);
    expect(pass.delivery?.failures.map((failure) => failure.kind)).toEqual(["reserved"]);
  });

  it("sends the line of the entry into the reserve from the reserve, one time, and holds the other messages", async () => {
    const gate = quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", now: () => T0 });
    gate.note({ remaining: 1_000 });
    const notices = quotaGate(PUSHOVER_RESERVE_NOTICES, { key: "pushover:reserve-notices", now: () => T0 });
    const watching: AlertConfig = { ...CONFIG, people: CONFIG.people.map((entry) => ({ ...entry, watch: { ...entry.watch, subjects: [{ system: "alerts.channel" }] } })) };
    const { clock, instance, server } = await open(undefined, watching, undefined, undefined, { pushoverQuota: gate, pushoverReserveNotices: notices });
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.view.step.reports.map((report) => report.kind.code)).toEqual(["system.quota.low", "system.quota.reserve"]);
    expect(server.calls.map((call) => call.fields["title"])).toEqual([expect.stringContaining("sends only life-safety messages")]);
    // Pushover takes 2 calls at a time, thus the third message waits for the next pass. The reserve holds it there.
    expect(pass.delivery?.failures.map((failure) => failure.kind)).toEqual(["reserved"]);
    await clock.advance(1000);
    const next = await finish(clock, instance.runtime.pass());
    expect(next.delivery?.failures.map((failure) => failure.kind)).toEqual(["reserved"]);
    expect(server.calls).toHaveLength(1);
    expect(notices.state().used).toBe(1);
  });

  it("lets the polygon of the warning decide for a place in the county but out of the polygon", async () => {
    // A public point in McMullen County TX, 8.9 km north of the polygon. The buffer of the place is 5 km. The NWS API copy
    // and the IPAWS copy each give the polygon and the county code in one area block, so the polygon decides.
    const outside = { ...CONFIG.places[0]!, at: [LONGITUDE, 28.46] as const };
    const { instance, clock, server } = open(store(SECRETS), { ...CONFIG, places: [outside] });
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched).toEqual(["nws-api", "ipaws"]);
    expect(server.calls).toHaveLength(0);
    const [incident] = pass.view.incidents;
    expect(incident?.areas.some((area) => area.type === "polygon")).toBe(true);
    expect(matchPlaces(incident!, [outside])).toEqual([]);
    // With a buffer of 10 km, the polygon is in the buffer of the place, and the distance decides the match.
    const [near] = matchPlaces(incident!, [{ ...outside, bufferKm: 10 }]);
    expect(near?.codes).toEqual([]);
    expect(near?.distanceKm).toBeGreaterThan(8);
    expect(near?.distanceKm).toBeLessThan(10);
  });

  it("sends the warning when each exchange takes real time, as on a busy runner", async () => {
    // This test keeps the default limit, the interval. Before the fix of `finish`, a delay of 5 ms moved the fake clock past it.
    const { instance, clock, server } = open(store(SECRETS), CONFIG, 15, "interval");
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.view?.health.map((health) => [health.source, health.state])).toEqual([
      ["nws-api", "healthy"],
      ["ipaws", "healthy"],
    ]);
    expect(server.calls.map((call) => call.fields["title"])).toEqual([expect.stringContaining("Flood Warning")]);
  });

  it("stops each fetch at the limit of the options", async () => {
    const { instance, clock } = open(store(SECRETS), CONFIG, Infinity, 5000);
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.view?.health.map((health) => [health.source, health.lastFailure?.failure.message])).toEqual([
      ["nws-api", "The fetch took longer than 5000 ms."],
      ["ipaws", "The fetch took longer than 5000 ms."],
    ]);
  });

  it("gives no contact in the User-Agent without a contact in the configuration, and no request holds a position or an account", async () => {
    const { instance, clock, net } = await open();
    await finish(clock, instance.runtime.pass());
    const hosts = new Set(net.exchanges.map((exchange) => new URL(exchange.url).hostname));
    expect(hosts).toEqual(new Set(["api.weather.gov", "apps.fema.gov"]));
    for (const exchange of net.exchanges) {
      expect(exchange.headers["user-agent"]).toBe(USER_AGENT_NAME);
      const text = JSON.stringify(exchange);
      expect(text).not.toContain(String(LONGITUDE));
      expect(text).not.toContain(String(LATITUDE));
      expect(text).not.toContain("github.com");
    }
  });

  it("gets the outlines of the state of the place after a pass, at the pace and with the User-Agent of the instance", async () => {
    const outcomes: ShapeOutcome[] = [];
    let closed = 0;
    const cache = memoryCache();
    const counted: ShapeCache = { ...cache, close: () => (closed += 1) };
    const { instance, clock, net } = open(store(SECRETS), { ...CONFIG, contact: CONTACT }, 0, TEST_FETCH_LIMIT, { shapes: counted, onShapes: (outcome) => outcomes.push(outcome) });
    const pass = await finish(clock, instance.runtime.pass());
    await finish(clock, instance.shapes.idle());
    const zones = net.exchanges.filter((exchange) => new URL(exchange.url).pathname.startsWith("/zones"));
    expect(zones.map((exchange) => exchange.url)).toContain("https://api.weather.gov/zones?area=TX&type=county");
    expect(new Set(net.exchanges.map((exchange) => exchange.headers["user-agent"]))).toEqual(new Set([`${USER_AGENT_NAME} (+${CONTACT})`]));
    // The refresh starts after the pass, and it starts no request that can end after the next fetch of a source.
    const next = Math.min(...instance.runtime.config.sources.map((source) => nextFetch(instance.runtime.state(), source)));
    expect(clock.now()).toBeLessThanOrEqual(next);
    expect(pass.fetched).toEqual(["nws-api", "ipaws"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.ok).toBe(true);
    await instance.shapes.close();
    expect(closed).toBe(1);
  });

  it("adds the codes of the zones near a place from the outlines of the cache, and asks the NWS API by state only", async () => {
    // The records are older than the period of the refresh. Thus the refresh asks again, and gets the same outlines.
    const old = T0 - 8 * 24 * 60 * 60 * 1000;
    const shapeOf = (path: string) => (JSON.parse(ZONE_ANSWERS[path]!) as { geometry: { coordinates: [number, number][][] } }).geometry.coordinates;
    const cache = memoryCache({
      lists: [
        { state: "TX", kind: "county", fetched: old, ids: ["TXC311"] },
        { state: "TX", kind: "forecast", fetched: old, ids: ["TXZ230"] },
      ],
      zones: [
        { kind: "county", id: "TXC311", state: "TX", name: "County", fetched: old, shapes: [{ type: "polygon", rings: shapeOf("/zones/county/TXC311") }] },
        { kind: "forecast", id: "TXZ230", state: "TX", name: "Zone", fetched: old, shapes: [{ type: "polygon", rings: shapeOf("/zones/forecast/TXZ230") }] },
      ],
    });
    const net = network();
    const outcomes: ShapeOutcome[] = [];
    let told = 0;
    const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { transport: withZones(net), shapes: cache, onShapes: (outcome) => outcomes.push(outcome), onPlaceCodes: () => (told += 1) });
    // The 4 codes near the place are TXC311, its SAME code, the state and TXZ230. The file has each code but the forecast zone TXZ230.
    expect(instance.zones).toEqual({ placed: 1, outlined: 1, near: 4, added: 1 });
    expect(instance.runtime.config.places[0]?.codes.at(-1)).toEqual({ system: "ugc", code: "TXZ230" });
    await finish(clock, instance.runtime.pass());
    await finish(clock, instance.shapes.idle());
    // The refresh asked again, and the outlines did not change. Thus the codes of the place did not change.
    expect(outcomes).toEqual([{ ok: true, refreshed: expect.objectContaining({ stop: "done", failures: [] }) }]);
    expect(outcomes[0]?.ok === true && outcomes[0].refreshed.requests).toBeGreaterThan(0);
    expect(told).toBe(0);
    const alerts = net.exchanges.map((exchange) => new URL(exchange.url)).filter((url) => url.pathname === "/alerts/active");
    expect(alerts.map((url) => url.search)).toContain("?area=TX");
    expect(alerts.filter((url) => url.searchParams.has("zone"))).toEqual([]);
  });

  it("tells one time when new outlines change the codes of a place", async () => {
    const net = network();
    const outcomes: ShapeOutcome[] = [];
    let told = 0;
    const { instance, clock } = open(store(SECRETS), CONFIG, 0, TEST_FETCH_LIMIT, { transport: withZones(net), shapes: memoryCache(), onShapes: (outcome) => outcomes.push(outcome), onPlaceCodes: () => (told += 1) });
    expect(instance.zones).toEqual({ placed: 1, outlined: 0, near: 0, added: 0 });
    for (let pass = 0; pass < 4 && told === 0; pass++) {
      await finish(clock, instance.runtime.pass());
      await finish(clock, instance.shapes.idle());
    }
    expect(told).toBe(1);
    expect(outcomes.at(-1)).toEqual({ ok: true, refreshed: expect.objectContaining({ stop: "done", failures: [] }) });
    // The instance keeps the codes of its start. The supervisor starts a new instance with the new codes.
    expect(instance.runtime.config.places[0]?.codes).toEqual(CONFIG.places[0]?.codes);
    await finish(clock, instance.runtime.pass());
    await finish(clock, instance.shapes.idle());
    expect(told).toBe(1);
  });

  it("gets no outline without a cache of shapes", async () => {
    const { instance, clock, net } = open();
    await finish(clock, instance.runtime.pass());
    await instance.shapes.idle();
    expect(net.exchanges.filter((exchange) => new URL(exchange.url).pathname.startsWith("/zones"))).toEqual([]);
    expect(instance.shapes.basemap()).toEqual([]);
    expect(instance.shapes.lookup({ system: "ugc", code: "TXC311" })).toBeUndefined();
  });

  it("gives the contact of the configuration in the User-Agent of each request", async () => {
    const { instance, clock, net } = await open(store(SECRETS), { ...CONFIG, contact: CONTACT });
    await finish(clock, instance.runtime.pass());
    expect(net.exchanges.length).toBeGreaterThan(0);
    expect(new Set(net.exchanges.map((exchange) => exchange.headers["user-agent"]))).toEqual(new Set(["alerts-runtime (+mailto:operator@example.org)"]));
  });

  it("gives the loop the times of the sources and of the channel", async () => {
    const { instance } = await open();
    const intervals = instance.runtime.config.sources.map((source) => source.interval);
    expect(instance.runtime.config.sources.map((source) => source.id)).toEqual(["nws-api" as SourceId, "ipaws" as SourceId]);
    expect(instance.loop.times).toEqual({
      passLimit: Math.max(...intervals) + 2 * PUSHOVER_TIMEOUT_MS,
      retryBase: Math.min(PUSHOVER_TIMEOUT_MS, ...intervals),
      retryCap: Math.min(...intervals),
    });
    // The host reads the times before a start. They agree with the times of the loop.
    expect(instance.loop.times).toEqual(INSTANCE_TIMES);
  });

  it("does not start without the token of the application or the key of the person, and no message holds a value of a secret", () => {
    const { PUSHOVER_APP_TOKEN, PUSHOVER_USER_KEY } = SECRETS;
    const noToken = (): unknown => open(store({ PUSHOVER_USER_KEY }));
    expect(noToken).toThrow("The secret store has no value for PUSHOVER_APP_TOKEN");
    const noUser = (): unknown => open(store({ PUSHOVER_APP_TOKEN }));
    expect(noUser).toThrow("PUSHOVER_USER_KEY");
    for (const start of [noToken, noUser]) expect(messageOf(start)).not.toMatch(/t{30}|u{30}/);
  });

  it("does not start when no source covers a place", () => {
    // The place has no code of the country. The coverage of each source is a list of countries.
    const place = CONFIG.places[0]!;
    const config: AlertConfig = { ...CONFIG, places: [{ ...place, codes: place.codes.filter((code) => code.system !== "iso3166") }] };
    expect(messageOf(() => open(store(SECRETS), config))).toContain("No source covers the place place-1.");
  });

  it("does not start with a key that is not a key of Pushover, and no message holds the bad value", () => {
    const bad = { PUSHOVER_APP_TOKEN: "bad-token-value", PUSHOVER_USER_KEY: "bad-user-value" };
    const message = messageOf(() => open(store(bad)));
    expect(message).toContain("The value of PUSHOVER_APP_TOKEN is not a key of Pushover");
    expect(message).toContain("The Pushover user key of person-1 is not 30 letters and digits.");
    expect(message).not.toMatch(/bad-token-value|bad-user-value/);
  });
});

describe("the keys of the status check", () => {
  // Fake values only. The test looks for them in each problem.
  const KEY = "k".repeat(32);
  const URL_OF_CHECK = "https://hc-ping.com/00000000-0000-4000-8000-000000000000";

  it("gives the key of the management API and the ping URL of secrets.env", () => {
    expect(checksKeys({ text: `${CHECKS_KEY}=${KEY}\n${PING_URL_KEY}=${URL_OF_CHECK}\n` })).toEqual({ tag: "ok", value: { key: KEY, url: URL_OF_CHECK } });
  });

  it("gives the URL of the loud check when secrets.env has one, and no field for an empty value", () => {
    const loud = `${URL_OF_CHECK}-loud`;
    expect(checksKeys({ text: `${CHECKS_KEY}=${KEY}\n${PING_URL_KEY}=${URL_OF_CHECK}\n${LOUD_PING_URL_KEY}=${loud}\n` })).toEqual({
      tag: "ok",
      value: { key: KEY, url: URL_OF_CHECK, loudUrl: loud },
    });
    expect(checksKeys({ text: `${CHECKS_KEY}=${KEY}\n${PING_URL_KEY}=${URL_OF_CHECK}\n${LOUD_PING_URL_KEY}=\n` })).toEqual({ tag: "ok", value: { key: KEY, url: URL_OF_CHECK } });
  });

  it("gives the checks of the heartbeat: the check, then the loud check, and none for a missing or empty key", () => {
    const loud = `${URL_OF_CHECK}-loud`;
    const lookup = (values: Record<string, string>) => (key: string) => values[key];
    expect(pingTargets(lookup({ [LOUD_PING_URL_KEY]: loud, [PING_URL_KEY]: URL_OF_CHECK }))).toEqual([
      { key: PING_URL_KEY, url: URL_OF_CHECK },
      { key: LOUD_PING_URL_KEY, url: loud },
    ]);
    expect(pingTargets(lookup({ [PING_URL_KEY]: URL_OF_CHECK }))).toEqual([{ key: PING_URL_KEY, url: URL_OF_CHECK }]);
    expect(pingTargets(lookup({ [PING_URL_KEY]: URL_OF_CHECK, [LOUD_PING_URL_KEY]: "" }))).toEqual([{ key: PING_URL_KEY, url: URL_OF_CHECK }]);
    expect(pingTargets(lookup({ [LOUD_PING_URL_KEY]: loud }))).toEqual([{ key: LOUD_PING_URL_KEY, url: loud }]);
    expect(pingTargets(lookup({}))).toEqual([]);
  });

  it("gives a problem with no value and no path for a missing key, a bad line and a failed read", () => {
    const problems = [
      checksKeys({ text: `${CHECKS_KEY}=${KEY}\n` }),
      checksKeys({ text: `${CHECKS_KEY}=${KEY}\n${PING_URL_KEY}=\n` }),
      checksKeys({ text: `${CHECKS_KEY}=${KEY}\n${PING_URL_KEY}=${URL_OF_CHECK}\nnot a line\n` }),
      checksKeys({ code: "ENOENT" }),
    ].map((result) => (result.tag === "err" ? result.error.join(" ") : "ok"));
    expect(problems[0]).toBe(`The file secrets.env needs ${CHECKS_KEY} and ${PING_URL_KEY} for this check.`);
    expect(problems[1]).toBe(problems[0]);
    expect(problems[2]).toMatch(/^The file secrets\.env: /);
    expect(problems[3]).toBe("The file secrets.env cannot be read (ENOENT).");
    for (const problem of problems) {
      expect(problem).not.toContain(KEY);
      expect(problem).not.toContain(URL_OF_CHECK);
    }
  });
});

describe("the check of the instance", () => {
  const parse = (config: AlertConfig, secret: SecretLookup) => {
    const parsed = parseConfig(JSON.stringify(config), INSTANCE_CHECK.channels, secret);
    if (parsed.tag === "err") throw new Error(parsed.error.join("\n"));
    return parsed.value;
  };

  it("has the descriptors that the sources of the instance give", () => {
    const { instance } = open();
    expect(instance.runtime.config.sources).toEqual(INSTANCE_SOURCES);
  });

  it("finds each problem that stops the start, and no message holds a value of a secret", () => {
    const place = CONFIG.places[0]!;
    const uncovered: AlertConfig = { ...CONFIG, places: [{ ...place, codes: place.codes.filter((code) => code.system !== "iso3166") }] };
    const bad = store({ PUSHOVER_APP_TOKEN: "bad-token-value", PUSHOVER_USER_KEY: "bad-user-value" });
    const problems = INSTANCE_CHECK.problems(parse(uncovered, bad), bad);
    expect(problems).toEqual([
      expect.stringContaining("The value of PUSHOVER_APP_TOKEN is not a key of Pushover"),
      "The Pushover user key of person-1 is not 30 letters and digits.",
      expect.stringContaining("No source covers the place place-1."),
    ]);
    expect(problems.join("\n")).not.toMatch(/bad-token-value|bad-user-value/);
    expect(messageOf(() => open(bad, uncovered))).toContain(problems.join("\n- "));
  });

  it("finds no problem in a configuration that starts", () => {
    expect(instanceProblems(parse(CONFIG, store(SECRETS)), store(SECRETS), INSTANCE_SOURCES)).toEqual([]);
  });

  it("needs the key of the outside heartbeat only for the live instance", () => {
    const parsed = parse(CONFIG, store(SECRETS));
    expect(DAEMON_CHECK.channels).toBe(INSTANCE_CHECK.channels);
    expect(DAEMON_CHECK.problems(parsed, store(SECRETS))).toEqual([`The file secrets.env has no ${PING_URL_KEY}. The live instance needs its outside heartbeat.`]);
    expect(DAEMON_CHECK.problems(parsed, store({ ...SECRETS, [PING_URL_KEY]: "https://hc-ping.example/test" }))).toEqual([]);
  });
});

describe("the delivery times of the instance", () => {
  it("gives a send as overdue after one pass limit and two full tries: 140 s, well inside an outage of 10 minutes", () => {
    expect(DELIVERY_TIMES.overdueAfter).toBe(overdueLimit({ passLimit: INSTANCE_TIMES.passLimit, flightLimit: DELIVERY_TIMES.flightLimit, retry: DELIVERY_TIMES.retry }));
    expect(DELIVERY_TIMES.overdueAfter).toBe(140_000);
    // A send of a healthy channel ends within one pass limit and one flight. It is not overdue.
    expect(DELIVERY_TIMES.overdueAfter).toBeGreaterThan(INSTANCE_TIMES.passLimit + DELIVERY_TIMES.flightLimit + DELIVERY_TIMES.retry);
  });
});

describe("sourcePace", () => {
  it("stops a host after 5 failures for the longest step of the backoff, not for one hour", async () => {
    const clock = fakeClock(T0);
    const wall: WallClock = { time: "wall", now: () => clock.now(), after: (ms, run) => clock.after(ms, run) };
    const pace = sourcePace(clock, wall, 1);
    expect(pace.policy).toBe(SOURCE_POLICY);
    expect(SOURCE_POLICY.failureStopMs).toBe(SOURCE_POLICY.backoffCapMs);
    expect(SOURCE_POLICY.failureStopMs).toBeLessThan(DEFAULT_POLICY.failureStopMs);
    const transport: Transport = async () => ({ status: 500, statusText: "Internal Server Error", headers: {}, body: "" });
    const source = createNwsSource({ pace, transport, userAgent: USER_AGENT_NAME });
    const watch: Watch = { places: [{ id: place, codes: [{ system: "state", code: "TX" }], bufferKm: 0 }] };
    // Each fetch asks for the alerts of the state and for the canary. Each answer of HTTP 500 is one failure.
    for (let fetch = 0; fetch < SOURCE_POLICY.maxFailures && pace.scheduler.stopOf(HOST) === undefined; fetch++) {
      await finish(clock, source.fetch({ watch }));
    }
    const stop = pace.scheduler.stopOf(HOST);
    expect(stop).toBeDefined();
    expect((stop?.until ?? 0) - clock.now()).toBeGreaterThan(0);
    expect((stop?.until ?? Number.POSITIVE_INFINITY) - clock.now()).toBeLessThanOrEqual(SOURCE_POLICY.backoffCapMs);
  });
});
