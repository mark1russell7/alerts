import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeClock, type FakeClock, type WallClock } from "@mark1russell7/algebra/clock";
import { CONFIG_FORMAT, parseConfig, type AlertConfig, type ChannelId, type EscalationPolicy, type PersonId, type PlaceId, type SecretLookup, type SourceId } from "@mark1russell7/alerts";
import { PUSHOVER_TIMEOUT_MS, type PushoverChannelOptions } from "@mark1russell7/alerts-channel-pushover";
import { CANARY_PATH } from "@mark1russell7/alerts-source-nws-api";
import type { Exchange, Transport } from "polite-crawler/api";
import { afterEach, describe, expect, it } from "vitest";
import { INSTANCE_CHANNELS, INSTANCE_TIMES, openInstance, USER_AGENT, type Instance } from "./instance.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";

// The Flood Warning was sent at 14:54 UTC on 2026-11-14, and it expires at 06:00 UTC on 2026-11-15.
// The keepalive was sent at 22:44:55 UTC. Thus at T0 the warning is active, and the keepalive is recent.
const T0 = Date.UTC(2026, 10, 14, 22, 50);
const MINUTE = 60_000;
const pushover = "pushover" as ChannelId;
const person = "person-1" as PersonId;
const place = "place-1" as PlaceId;

// A public point in McMullen County TX. No request of a source holds it.
const LONGITUDE = -98.55;
const LATITUDE = 28.46;

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
 */
function network() {
  const exchanges: Exchange[] = [];
  const collection = (...names: string[]): string => JSON.stringify({ type: "FeatureCollection", features: names.map((name) => JSON.parse(fixture("alerts-source-nws-api", name))) });
  const nws: Readonly<Record<string, string>> = { "/alerts/active?area=TX": collection("nws-flw.json"), [CANARY_PATH]: collection("nws-keepalive.json") };
  const transport: Transport = async (exchange) => {
    exchanges.push(exchange);
    const url = new URL(exchange.url);
    if (url.hostname === "apps.fema.gov") return { status: 200, statusText: "OK", headers: { "content-type": "application/xml" }, body: fixture("alerts-source-ipaws", "feed-empty.xml") };
    if (url.hostname !== "api.weather.gov") throw new Error(`The fake network has no route to ${url.hostname}.`);
    const body = nws[url.pathname + url.search] ?? collection();
    return { status: 200, statusText: "OK", headers: { "content-type": "application/geo+json" }, body };
  };
  return { transport, exchanges };
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

// The microtasks and the callbacks of the promises end before this promise resolves.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** This function moves the clock in steps of one second until the work ends. The waits of the pace of the sources end in the steps. */
async function finish<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let done = false;
  work.then(
    () => (done = true),
    () => (done = true),
  );
  for (let step = 0; !done && step < 10 * 60; step++) {
    await clock.advance(1000);
    await settle();
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

function open(secret: SecretLookup = store(SECRETS), config: AlertConfig = CONFIG) {
  // The entry reads the configuration so: a refused parse stops the start before the instance.
  const parsed = parseConfig(JSON.stringify(config), INSTANCE_CHANNELS, secret);
  if (parsed.tag === "err") throw new Error(parsed.error.join("\n"));
  const folder = mkdtempSync(join(tmpdir(), "alerts-instance-"));
  const log = openRuntimeLog(join(folder, "runtime.sqlite"));
  opened.push({ log, folder });
  const clock = fakeClock(T0);
  // The fake clock starts at T0. Thus its time is also the instant of the test.
  const wall: WallClock = { time: "wall", now: () => clock.now(), after: (ms, run) => clock.after(ms, run) };
  const net = network();
  const server = pushoverServer();
  const instance: Instance = openInstance({ config: parsed.value, secret, log, clock, wall, transport: net.transport, pushover: server.fetch, run: "run-1" });
  return { instance, clock, net, server };
}

describe("openInstance", () => {
  it("sends a recorded NWS warning for a watched county to the person on Pushover", async () => {
    const { instance, clock, net, server } = await open();
    const pass = await finish(clock, instance.runtime.pass());
    expect(pass.fetched).toEqual(["nws-api", "ipaws"]);
    expect(server.calls).toHaveLength(1);
    const [call] = server.calls;
    expect(call?.url).toBe("https://api.pushover.net/1/messages.json");
    expect(call?.fields).toMatchObject({ token: SECRETS["PUSHOVER_APP_TOKEN"], user: SECRETS["PUSHOVER_USER_KEY"] });
    expect(call?.fields["title"]).toContain("Flood Warning");
    expect(pass.delivery?.sent).toHaveLength(1);
    // The source asks for the alerts of the state. The match to the county is local.
    expect(net.exchanges.map((exchange) => exchange.url)).toContain("https://api.weather.gov/alerts/active?area=TX");
  });

  it("names the project in the User-Agent of each request, and no request holds the position of a place", async () => {
    const { instance, clock, net } = await open();
    await finish(clock, instance.runtime.pass());
    const hosts = new Set(net.exchanges.map((exchange) => new URL(exchange.url).hostname));
    expect(hosts).toEqual(new Set(["api.weather.gov", "apps.fema.gov"]));
    for (const exchange of net.exchanges) {
      expect(exchange.headers["user-agent"]).toBe(USER_AGENT);
      const text = JSON.stringify(exchange);
      expect(text).not.toContain(String(LONGITUDE));
      expect(text).not.toContain(String(LATITUDE));
    }
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
