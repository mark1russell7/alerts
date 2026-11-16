/**
 * AL-13, case 8: a copy feed that stops or lags. IPAWS carries a copy of each WEA message of the NWS (`WEA_EXPECTATION`).
 * The core checks each such message. The lateness of IPAWS goes late when copies do not come in the limit of the delay.
 *
 * Each arm has the NWS source and the IPAWS source on one fast case clock, from 00:20 UTC on 2026-11-09. Each NWS fetch
 * gives `PER_FETCH` new synthetic WEA messages, in a county that no place watches. The IPAWS copy of each message comes
 * in the feed of the same fetch or of the next fetch, from a seeded draw. Thus the core gets more than 299 delays before the
 * window, and it has a limit of the delay.
 *
 * Two watched places are in the real Flash Flood Warning KEWX.FF.W.0108 of 2026-11-08 (the fixtures of the pair in
 * `@mark1russell7/alerts-format-cap`). The place `kept` is in the NEW message and in the EXT message. The place `dropped`
 * is only in the NEW message. The NWS list has the EXT message from fetch `EXT_FROM`, and the IPAWS copy of the EXT
 * message comes in the same fetch.
 *
 * In an arm, the fault proxy of `@mark1russell7/rigor-proxy` gives the answers of the fetches in the window. The server
 * does not get them.
 *
 * - `control`: no fault. This arm is the control of the case.
 * - `copy-stopped`: each IPAWS feed in the window is empty.
 * - `ipaws-lag`: each IPAWS feed in the window is the feed of `LAG` fetches before.
 * - `nws-lag`: each NWS list in the window is the list of `LAG` fetches before. The canary stays current.
 *
 * The gates of each arm:
 *
 * - `noFalseClear`: each pass has a threat at `kept`, and a threat at `dropped` before the NWS list has the EXT message.
 * - `oneIncident`: no pass has two threats at one place. The NWS message and its IPAWS copy are one incident.
 * - `settles`: the last pass has one threat at `kept` and no threat at `dropped`.
 * - `clears`: the lateness of the last pass is `met`.
 * - `tellsStop` (`copy-stopped` and `ipaws-lag`): the lateness goes late in `TELL_WITHIN` fetches of the start of the window.
 * - `noLongLate` (`control` and `nws-lag`): each late period ends in one interval of the sources.
 *
 * The limit of the delay is the upper bound of the 0.99 quantile of the delays. A copy with a delay above that bound gives
 * a short late period, by design. The gate `noLongLate` permits these periods, and the record keeps each one.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { threats, type FetchOutcome, type LatenessState, type PlaceId, type SourceProcedures, type Watch, type WatchedPlace } from "@mark1russell7/alerts";
import { DELAY_LIMITS, openRuntime, openRuntimeLog, sourcePace, type RuntimeOptions } from "@mark1russell7/alerts-runtime";
import { COPY_SUFFIX, createIpawsSource, FEED_PATH, IPAWS_DESCRIPTOR, WEA_EXPECTATION } from "@mark1russell7/alerts-source-ipaws";
import { CANARY_PATH, createNwsSource, NWS_DESCRIPTOR, queriesOf, WEA_PATH } from "@mark1russell7/alerts-source-nws-api";
import { type Fault, faultPlanOf } from "@mark1russell7/rigor-chaos";
import { random, sha256Hex } from "@mark1russell7/rigor-generators";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { fetchTransport, type Transport } from "polite-crawler/api";
import { caseBodies } from "./nws.ts";
import { caseClock } from "./source-down.ts";

/** The id and the seed of the case. The draws of the copies and the jitter of each arm come from this seed. */
export const CASE_8_ID = "al-13-case-8";
/** The origin of the NWS source in the case. */
export const CASE_8_NWS = "http://nws.test";
/** The origin of the IPAWS source in the case. The transport of the case refuses each other origin. */
export const CASE_8_IPAWS = "http://ipaws.test";
const USER_AGENT = "alerts-testkit/0 (fault suite)";
const GEO_JSON = { "content-type": "application/geo+json" };
const XML = { "content-type": "application/xml" };

/** The count of new WEA messages in each NWS fetch. */
export const PER_FETCH = 6;
/** The fetches of the window of the faults: from `from`, and before `to`. */
export const WINDOW = { from: 70, to: 95 } as const;
/** The count of fetches between a fetch and the answer that it gets in a lag arm. */
export const LAG = 6;
/** The NWS list of a fetch has the messages of this count of fetches: the fetch and the fetches before it. */
export const LIST_SPAN = 10;
/** The first fetch with the EXT message in the NWS list, and with its IPAWS copy in the feed. */
export const EXT_FROM = 87;
/** The gate `tellsStop` permits the first late state in this count of fetches from the start of the window. */
export const TELL_WITHIN = 10;
/** The bound of the passes of an arm, for each fetch. A pass with no fetch adds no fetch. */
const PASSES_PER_FETCH = 10;

/** The settings of the case. */
export interface CopySettings {
  /** The milliseconds of the case clock in one real millisecond. */
  readonly speed: number;
  /** The count of fetches of each source in each arm. */
  readonly fetches: number;
  /** The start of the case clock, in milliseconds since the epoch. */
  readonly start: number;
}

/** The settings of the case. Each arm has 110 fetches of 1 minute: 110 minutes of the case clock, 220 seconds at the speed 30. */
export const CASE_8_SETTINGS: CopySettings = { speed: 30, fetches: 110, start: Date.parse("2026-11-09T00:20:00Z") };

/** The names of the watched places. */
export type CopyPlace = "kept" | "dropped";

/** The id of each watched place. */
const PLACE_IDS: Readonly<Record<CopyPlace, PlaceId>> = { kept: "kept" as PlaceId, dropped: "dropped" as PlaceId };

/** The watched places: the county TXC137 is in the NEW and the EXT message, and the county TXC019 is only in the NEW message. */
export const COPY_PLACES: readonly WatchedPlace[] = [
  { id: PLACE_IDS.kept, codes: [{ system: "ugc", code: "TXC137" }], bufferKm: 0 },
  { id: PLACE_IDS.dropped, codes: [{ system: "ugc", code: "TXC019" }], bufferKm: 0 },
];
const WATCH: Watch = { places: COPY_PLACES };
const VIEW: RuntimeOptions["view"] = {
  places: COPY_PLACES,
  kinds: [...new Set([...NWS_DESCRIPTOR.kinds, ...IPAWS_DESCRIPTOR.kinds])],
  expectations: [WEA_EXPECTATION],
  delay: DELAY_LIMITS,
};

/** The county of the synthetic messages. No place of the case is in it. */
const COUNTY = { ugc: "TXC001", same: "048001", desc: "Anderson, TX" } as const;

/** One synthetic WEA message of the NWS. */
export interface WeaMessage {
  /** The number of the message, from 0. */
  readonly index: number;
  /** The NWS fetch that gives the message first. */
  readonly fetch: number;
  /** The id of the message, as the NWS API gives it. */
  readonly id: string;
  /** The event tracking number of the VTEC of the message. Each message is one event. */
  readonly etn: number;
  readonly sent: number;
  readonly expires: number;
  /** The count of fetches between the NWS fetch of the message and the first IPAWS feed with its copy: 0 or 1. */
  readonly delay: 0 | 1;
}

/** This function gives the synthetic messages of the case, in their order. A seeded draw gives the delay of each copy. */
export function messagesOf(settings: CopySettings): WeaMessage[] {
  const draw = random(`${CASE_8_ID}-copies`);
  const interval = NWS_DESCRIPTOR.interval;
  return Array.from({ length: settings.fetches * PER_FETCH }, (_, index) => {
    const fetch = Math.floor(index / PER_FETCH);
    const sent = settings.start + (fetch - 1) * interval;
    return {
      index,
      fetch,
      id: `urn:oid:2.49.0.1.840.0.${sha256Hex(`${CASE_8_ID}-${String(index)}`).slice(0, 40)}.001.1`,
      etn: 2000 + index,
      sent,
      expires: sent + 10 * interval,
      delay: draw.chance(0.5) ? 1 : 0,
    };
  });
}

const CST_OFFSET = 6 * 3_600_000;

/** This function gives a time in the form of the NWS, at the offset of the Central Standard Time: `2026-11-09T18:19:00-06:00`. */
export function cstTime(time: number): string {
  return new Date(time - CST_OFFSET).toISOString().replace(/\.\d{3}Z$/, "-06:00");
}

/** This function gives a time in the form of a VTEC string: `261109T0019Z`. */
export function vtecTime(time: number): string {
  const iso = new Date(time).toISOString();
  return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

/** This function gives the VTEC string of a synthetic message: a new Flash Flood Warning of the office KEWX. */
export function vtecOf(message: Pick<WeaMessage, "etn" | "sent" | "expires">): string {
  return `/O.NEW.KEWX.FF.W.${String(message.etn).padStart(4, "0")}.${vtecTime(message.sent)}-${vtecTime(message.expires)}/`;
}

/** The fixtures of the real pair KEWX.FF.W.0108, and the empty IPAWS feed. */
export interface PairFixtures {
  /** The NEW message of the NWS API, as a GeoJSON feature. */
  readonly newFeature: Readonly<Record<string, unknown>>;
  /** The EXT message of the NWS API, as a GeoJSON feature. */
  readonly extFeature: Readonly<Record<string, unknown>>;
  /** The IPAWS copy of the NEW message, as CAP XML. */
  readonly newCopy: string;
  /** The IPAWS copy of the EXT message, as CAP XML. */
  readonly extCopy: string;
  /** The IPAWS feed with no alert. */
  readonly emptyFeed: string;
}

const folderOf = (name: string, folder: string): string => join(dirname(createRequire(import.meta.url).resolve(`${name}/package.json`)), folder);

/** This function reads the fixtures of the real pair from `@mark1russell7/alerts-format-cap`, and the empty feed from the IPAWS source. */
export function readPair(): PairFixtures {
  const pairs = folderOf("@mark1russell7/alerts-format-cap", join("fixtures", "pairs"));
  const text = (name: string): string => readFileSync(join(pairs, name), "utf8");
  const emptyFeed = readFileSync(join(folderOf("@mark1russell7/alerts-source-ipaws", "fixtures"), "feed-empty.xml"), "utf8");
  return {
    newFeature: JSON.parse(text("kewx-ff-w-0108-new.nws-api.json")) as Record<string, unknown>,
    extFeature: JSON.parse(text("kewx-ff-w-0108-ext.nws-api.json")) as Record<string, unknown>,
    newCopy: text("kewx-ff-w-0108-new.ipaws.xml").trim(),
    extCopy: text("kewx-ff-w-0108-ext.ipaws.xml").trim(),
    emptyFeed,
  };
}

/** The fields of the NEW message that the synthetic messages do not keep: they name the real EXT message. */
const DROPPED_FIELDS: ReadonlySet<string> = new Set(["replacedBy", "replacedAt"]);

/** This function gives the NWS feature of a synthetic message from the real NEW message. The feature has the id, times, area and VTEC of the message. */
export function featureOf(message: WeaMessage, template: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const properties = template["properties"] as Readonly<Record<string, unknown>>;
  const parameters = properties["parameters"] as Readonly<Record<string, unknown>>;
  const url = `https://api.weather.gov/alerts/${message.id}`;
  const kept = Object.fromEntries(Object.entries(properties).filter(([name]) => !DROPPED_FIELDS.has(name)));
  return {
    ...template,
    id: url,
    geometry: null,
    properties: {
      ...kept,
      "@id": url,
      id: message.id,
      areaDesc: COUNTY.desc,
      geocode: { SAME: [COUNTY.same], UGC: [COUNTY.ugc] },
      affectedZones: [`https://api.weather.gov/zones/county/${COUNTY.ugc}`],
      references: [],
      sent: cstTime(message.sent),
      effective: cstTime(message.sent),
      onset: cstTime(message.sent),
      expires: cstTime(message.expires),
      ends: cstTime(message.expires),
      headline: `Flash Flood Warning ${String(message.etn)} of the fault case by NWS Austin/San Antonio TX`,
      description: `The synthetic message ${String(message.index)} of the fault case ${CASE_8_ID}.`,
      instruction: "Turn around, do not drown.",
      parameters: { ...parameters, VTEC: [vtecOf(message)], eventEndingTime: [cstTime(message.expires)] },
    },
  };
}

/** This function replaces the first match of `pattern` in `text`. It throws when there is no match, because then the template changed. */
function swap(text: string, pattern: RegExp, value: string): string {
  if (!pattern.test(text)) throw new Error(`The template of the IPAWS copy has no match of ${String(pattern)}.`);
  return text.replace(pattern, () => value);
}

/** This function replaces the value of the parameter `name` of a CAP message. */
function swapParameter(text: string, name: string, value: string): string {
  return swap(text, new RegExp(`<valueName>${name}</valueName><value>[^<]*</value>`), `<valueName>${name}</valueName><value>${value}</value>`);
}

/**
 * This function gives the IPAWS copy of a synthetic message, from the real IPAWS copy of the NEW message. The copy keeps
 * the first `info` (en-US) only. It has no signature, because the reader does not read the signature.
 */
export function copyOf(message: WeaMessage, template: string): string {
  const first = template.indexOf("<info>");
  const end = template.indexOf("</info>", first);
  if (first === -1 || end === -1) throw new Error("The template of the IPAWS copy has no info.");
  let head = template.slice(0, first);
  head = swap(head, /<identifier>[^<]*<\/identifier>/, `<identifier>${message.id}${COPY_SUFFIX}</identifier>`);
  head = swap(head, /<sent>[^<]*<\/sent>/, `<sent>${cstTime(message.sent)}</sent>`);
  let info = template.slice(first, end + "</info>".length);
  info = swap(info, /<effective>[^<]*<\/effective>/, `<effective>${cstTime(message.sent)}</effective>`);
  info = swap(info, /<onset>[^<]*<\/onset>/, `<onset>${cstTime(message.sent)}</onset>`);
  info = swap(info, /<expires>[^<]*<\/expires>/, `<expires>${cstTime(message.expires)}</expires>`);
  info = swap(info, /<headline>[^<]*<\/headline>/, `<headline>Flash Flood Warning ${String(message.etn)} of the fault case by NWS Austin/San Antonio TX</headline>`);
  info = swap(info, /<description>[\s\S]*?<\/description>/, `<description>The synthetic message ${String(message.index)} of the fault case ${CASE_8_ID}.</description>`);
  info = swap(info, /<instruction>[\s\S]*?<\/instruction>/, "<instruction>Turn around, do not drown.</instruction>");
  info = swapParameter(info, "VTEC", vtecOf(message));
  info = swapParameter(info, "eventEndingTime", cstTime(message.expires));
  const area = `<area><areaDesc>${COUNTY.desc}</areaDesc><geocode><valueName>SAME</valueName><value>${COUNTY.same}</value></geocode><geocode><valueName>UGC</valueName><value>${COUNTY.ugc}</value></geocode></area>`;
  info = swap(info, /<area>[\s\S]*<\/area>/, area);
  return `${head}${info}</alert>`;
}

/** This function gives an IPAWS feed with the alerts, in the envelope of the empty feed. */
export function feedOf(emptyFeed: string, alerts: readonly string[]): string {
  const close = "</ns1:alerts>";
  if (!emptyFeed.includes(close)) throw new Error("The empty feed has no end tag of its envelope.");
  return emptyFeed.replace(close, () => `${alerts.join("")}${close}`);
}

/** A route of the server of the case. The NWS source asks for `zone`, `wea` and `canary` in each fetch, and the IPAWS source for `feed`. */
export type CopyRoute = "zone" | "wea" | "canary" | "feed";

/** The routes of the server, in their order. */
export const COPY_ROUTES: readonly CopyRoute[] = ["zone", "wea", "canary", "feed"];

/** The main query of the watch: the NWS zones of the two places. */
export const ZONE_PATH: string = (() => {
  const main = queriesOf(WATCH).filter((query) => query.main);
  if (main.length !== 1 || main[0] === undefined) throw new Error(`The watch of case 8 has ${String(main.length)} main queries, not 1.`);
  return main[0].path;
})();

/** The target of each route on the server. The transport sends each IPAWS request to `FEED_PATH`, with no time. */
export const ROUTE_PATHS: Readonly<Record<CopyRoute, string>> = { zone: ZONE_PATH, wea: WEA_PATH, canary: CANARY_PATH, feed: FEED_PATH };

/** The bodies of each route for each fetch. */
export interface CopyBodies {
  readonly zone: readonly string[];
  readonly wea: readonly string[];
  readonly canary: readonly Uint8Array[];
  readonly feed: readonly string[];
  /** The IPAWS feed with no alert. */
  readonly empty: string;
}

/** This function gives the bodies of each fetch of the case. Each arm has the same bodies. A fault gives the body of another fetch. */
export function copyBodiesOf(settings: CopySettings, pair: PairFixtures = readPair()): CopyBodies {
  const items = messagesOf(settings).map((message) => ({ message, feature: featureOf(message, pair.newFeature), copy: copyOf(message, pair.newCopy) }));
  const fetches = Array.from({ length: settings.fetches }, (_, fetch) => fetch);
  const collection = (list: readonly unknown[]): string => JSON.stringify({ type: "FeatureCollection", features: list });
  // The feed of a fetch has the copies that first come in that fetch or in the fetch before it.
  const inFeed = (first: number, fetch: number): boolean => first === fetch || first === fetch - 1;
  return {
    zone: fetches.map((fetch) => collection([fetch < EXT_FROM ? pair.newFeature : pair.extFeature])),
    wea: fetches.map((fetch) => collection(items.filter(({ message }) => message.fetch > fetch - LIST_SPAN && message.fetch <= fetch).map((item) => item.feature))),
    canary: fetches.map((fetch) => caseBodies({ keepaliveSent: settings.start + fetch * NWS_DESCRIPTOR.interval }).canary),
    feed: fetches.map((fetch) => {
      const due = items.filter(({ message }) => inFeed(message.fetch + message.delay, fetch)).map((item) => item.copy);
      return feedOf(pair.emptyFeed, inFeed(EXT_FROM, fetch) ? [...due, pair.extCopy] : due);
    }),
    empty: pair.emptyFeed,
  };
}

/** An arm of the case: the control, or a plan of faults in the window. */
export type CopyArm = "control" | "copy-stopped" | "ipaws-lag" | "nws-lag";

/** The arms of the case. The run starts them at the same time, each with its own servers, proxies and clock. */
export const COPY_ARMS: readonly CopyArm[] = ["control", "copy-stopped", "ipaws-lag", "nws-lag"];

/** The body that a fault gives: the body of the route at another fetch, or the empty feed. */
export type FaultBody = number | "empty";

const windowFetches = (): number[] => Array.from({ length: WINDOW.to - WINDOW.from }, (_, at) => WINDOW.from + at);

/** This function gives the faults of an arm on each route: for each fetch with a fault, the body that the proxy gives. */
export function copyFaultsOf(arm: CopyArm): Readonly<Record<CopyRoute, ReadonlyMap<number, FaultBody>>> {
  const none = new Map<number, FaultBody>();
  const lag = new Map<number, FaultBody>(windowFetches().map((fetch) => [fetch, fetch - LAG]));
  const empty = new Map<number, FaultBody>(windowFetches().map((fetch) => [fetch, "empty"]));
  switch (arm) {
    case "control":
      return { zone: none, wea: none, canary: none, feed: none };
    case "copy-stopped":
      return { zone: none, wea: none, canary: none, feed: empty };
    case "ipaws-lag":
      return { zone: none, wea: none, canary: none, feed: lag };
    case "nws-lag":
      return { zone: lag, wea: lag, canary: none, feed: none };
  }
}

/** This function gives the first NWS fetch of an arm with the EXT message in the list. */
export function extFetchOf(arm: CopyArm, fetches: number): number {
  const zone = copyFaultsOf(arm).zone;
  for (let fetch = 0; fetch < fetches; fetch += 1) {
    const body = zone.get(fetch) ?? fetch;
    if (body !== "empty" && body >= EXT_FROM) return fetch;
  }
  return fetches;
}

/** The requests of a route of an arm. */
export interface RouteCounts {
  /** The requests to the server. */
  direct: number;
  /** The requests to the fault proxy of the route. */
  proxied: number;
}

/** The options of the transport of the case. */
export interface CopyTransportOptions {
  /** The transport that sends each request to a server. */
  readonly inner: Transport;
  /** The origin of the server. */
  readonly direct: string;
  /** The origin of the fault proxy of each route with faults. */
  readonly proxies: Readonly<Partial<Record<CopyRoute, string>>>;
  /** The requests of each route that go to the proxy. The transport counts the requests of each route from 0. */
  readonly faulted: Readonly<Record<CopyRoute, ReadonlySet<number>>>;
  readonly counts: Record<CopyRoute, RouteCounts>;
}

/** This function gives the route of a request of a source, or `undefined` when the request is not a request of the case. */
export function routeOf(url: URL): CopyRoute | undefined {
  const target = `${url.pathname}${url.search}`;
  if (url.origin === CASE_8_NWS) return target === ZONE_PATH ? "zone" : target === WEA_PATH ? "wea" : target === CANARY_PATH ? "canary" : undefined;
  if (url.origin === CASE_8_IPAWS && url.search === "" && url.pathname.startsWith(`${FEED_PATH}/`)) return "feed";
  return undefined;
}

/**
 * This function gives the transport of the case. It refuses each request that is not on a route of the case. It sends each
 * request with a fault to the proxy of its route, and each other request to the server. An IPAWS request goes to `FEED_PATH`.
 */
export function copyTransport(options: CopyTransportOptions): Transport {
  const { inner, faulted, counts } = options;
  return (exchange, signal) => {
    const url = new URL(exchange.url);
    const route = routeOf(url);
    if (route === undefined) return Promise.reject(new TypeError(`The address ${exchange.url} is not an address of the case.`));
    const count = counts[route];
    const proxy = options.proxies[route];
    const faults = faulted[route].has(count.direct + count.proxied) && proxy !== undefined;
    if (faults) count.proxied += 1;
    else count.direct += 1;
    return inner({ ...exchange, url: `${faults ? proxy : options.direct}${ROUTE_PATHS[route]}` }, signal);
  };
}

/** This function gives the body of a route for a fault. */
function faultBody(bodies: CopyBodies, route: CopyRoute, body: FaultBody): string {
  if (body === "empty") return bodies.empty;
  if (route === "canary") throw new Error("The case has no fault on the canary.");
  const text = bodies[route][body];
  if (text === undefined) throw new Error(`The route ${route} has no body for the fetch ${String(body)}.`);
  return text;
}

/** This function gives the faults of the proxy of a route. Each connection gets one answer, in the order of the fetches. */
export function answersOf(bodies: CopyBodies, route: CopyRoute, faults: ReadonlyMap<number, FaultBody>): Fault[] {
  return [...faults.values()].map((body, connection) => ({
    connection,
    direction: "up",
    at: { frame: 0 },
    kind: "answer",
    status: 200,
    fields: route === "feed" ? XML : GEO_JSON,
    body: faultBody(bodies, route, body),
  }));
}

/** One fetch of a source in an arm. */
export interface CopyFetch {
  /** The time of the end of the fetch, after the start of the arm. */
  readonly at: number;
  readonly ok: boolean;
  readonly complete: boolean;
  readonly observations: number;
}

/** The state of one pass of an arm. */
export interface CopyPass {
  /** The time of the pass, after the start of the arm. */
  readonly at: number;
  /** The count of NWS fetches before the end of the pass. */
  readonly nws: number;
  /** The count of IPAWS fetches before the end of the pass. */
  readonly ipaws: number;
  /** The count of threats at each place. */
  readonly threats: Readonly<Record<CopyPlace, number>>;
  /** The state of the lateness of `WEA_EXPECTATION`. */
  readonly state: LatenessState | "none";
  /** The limit of the delay, in milliseconds. */
  readonly limit?: number;
  /** The count of misses that makes the source late. */
  readonly misses?: number;
  /** The count of checks that passed their limit with no copy. */
  readonly missed: number;
}

/** A period of late states. */
export interface LatePeriod {
  /** The time of the first late pass, after the start of the arm. */
  readonly from: number;
  /** The time of the first pass after the period that is not late. A period at the end of the arm has no end. */
  readonly to?: number;
  /** The count of NWS fetches at the first late pass. */
  readonly nws: number;
}

/** The records of one arm. */
export interface CopyRecord {
  readonly arm: CopyArm;
  readonly passes: readonly CopyPass[];
  readonly fetches: Readonly<Record<"nws" | "ipaws", readonly CopyFetch[]>>;
  readonly requests: Readonly<Record<CopyRoute, Readonly<RouteCounts>>>;
  /** The count of the faults that each proxy recorded. */
  readonly faults: Readonly<Record<CopyRoute, number>>;
  /** The count of the requests that the server read. */
  readonly served: number;
  /** The count of the requests that the servers behind the proxies read. When each fault falls at its point, the count is 0. */
  readonly leaked: number;
  /** The message of a throw of a pass. */
  readonly error?: string;
}

const fetchOf = (outcome: FetchOutcome, at: number): CopyFetch => ({
  at,
  ok: outcome.ok,
  complete: outcome.ok && outcome.complete,
  observations: outcome.ok ? outcome.observations.length : 0,
});

/** This function starts one arm: a server, a proxy for each route with faults, a new runtime and its passes on a new clock. */
export async function runCopyArm(arm: CopyArm, settings: CopySettings = CASE_8_SETTINGS, bodies: CopyBodies = copyBodiesOf(settings)): Promise<CopyRecord> {
  const faults = copyFaultsOf(arm);
  const fetches = Array.from({ length: settings.fetches }, (_, fetch) => fetch);
  const repliesOf = (route: CopyRoute) =>
    fetches
      .filter((fetch) => !faults[route].has(fetch))
      .map((fetch) => ({ fields: route === "feed" ? XML : GEO_JSON, body: bodies[route][fetch] ?? "" }));
  const server = await startScriptedServer({ routes: COPY_ROUTES.map((route) => ({ path: ROUTE_PATHS[route], replies: repliesOf(route) })) });
  const proxied = COPY_ROUTES.filter((route) => faults[route].size > 0);
  const behinds = await Promise.all(proxied.map(() => startScriptedServer({ routes: [] })));
  const proxies = await Promise.all(
    proxied.map((route, at) => {
      const behind = behinds[at];
      if (behind === undefined) throw new Error("A proxy has no server behind it.");
      return startFaultProxy({ target: { host: behind.host, port: behind.port }, plan: faultPlanOf(answersOf(bodies, route, faults[route])), protocol: "http" });
    }),
  );
  const clock = caseClock(settings.start, settings.speed);
  const counts: Record<CopyRoute, RouteCounts> = { zone: { direct: 0, proxied: 0 }, wea: { direct: 0, proxied: 0 }, canary: { direct: 0, proxied: 0 }, feed: { direct: 0, proxied: 0 } };
  const transport = copyTransport({
    inner: fetchTransport({ userAgent: USER_AGENT }),
    direct: server.url,
    proxies: Object.fromEntries(proxied.map((route, at) => [route, `http://${proxies[at]?.host ?? ""}:${String(proxies[at]?.port ?? 0)}`])),
    faulted: { zone: new Set(faults.zone.keys()), wea: new Set(faults.wea.keys()), canary: new Set(faults.canary.keys()), feed: new Set(faults.feed.keys()) },
    counts,
  });
  const jitter = random(`${CASE_8_ID}-${arm}`);
  // The pace of production: one scheduler for the two hosts on the case clock, with the jitter of the arm.
  const pace = { ...sourcePace({ now: clock.now, after: clock.after }, clock, 2), random: () => jitter.next() };
  const records: Record<"nws" | "ipaws", CopyFetch[]> = { nws: [], ipaws: [] };
  const captured = (inner: SourceProcedures, into: CopyFetch[]): SourceProcedures => ({
    ...inner,
    fetch: async (input) => {
      const outcome = await inner.fetch(input);
      into.push(fetchOf(outcome, clock.now() - settings.start));
      return outcome;
    },
  });
  const nws = captured(createNwsSource({ pace, transport, userAgent: USER_AGENT, baseUrl: CASE_8_NWS }), records.nws);
  const ipaws = captured(createIpawsSource({ pace, transport, userAgent: USER_AGENT, baseUrl: CASE_8_IPAWS }), records.ipaws);
  const log = openRuntimeLog(":memory:");
  const passes: CopyPass[] = [];
  let error: string | undefined;
  try {
    const runtime = openRuntime({ log, clock, sources: [nws, ipaws], watch: () => WATCH, view: VIEW, run: `${CASE_8_ID}-${arm}` });
    const done = (): boolean => records.nws.length >= settings.fetches && records.ipaws.length >= settings.fetches;
    for (let pass = 0; !done() && pass < PASSES_PER_FETCH * settings.fetches; pass += 1) {
      const result = await runtime.pass();
      const found = threats(result.view.incidents, COPY_PLACES);
      const late = result.view.lateness.find((one) => one.expectation === WEA_EXPECTATION.id);
      passes.push({
        at: result.at - settings.start,
        nws: records.nws.length,
        ipaws: records.ipaws.length,
        threats: { kept: found.filter((one) => one.place === PLACE_IDS.kept).length, dropped: found.filter((one) => one.place === PLACE_IDS.dropped).length },
        state: late?.state ?? "none",
        ...(late?.limit === undefined ? {} : { limit: late.limit.delay, misses: late.limit.misses }),
        missed: late?.missed.length ?? 0,
      });
      const next = Math.min(result.wakeAt ?? Number.POSITIVE_INFINITY, clock.now() + NWS_DESCRIPTOR.interval);
      await clock.sleep(next - clock.now());
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  log.close();
  await Promise.all(proxies.map((proxy) => proxy.close()));
  const leaked = behinds.reduce((sum, behind) => sum + behind.requests.length, 0);
  await Promise.all(behinds.map((behind) => behind.close()));
  const served = server.requests.length;
  await server.close();
  const recorded = Object.fromEntries(COPY_ROUTES.map((route) => [route, proxies[proxied.indexOf(route)]?.records.length ?? 0])) as Record<CopyRoute, number>;
  return {
    arm,
    passes,
    fetches: records,
    requests: { zone: { ...counts.zone }, wea: { ...counts.wea }, canary: { ...counts.canary }, feed: { ...counts.feed } },
    faults: recorded,
    served,
    leaked,
    ...(error === undefined ? {} : { error }),
  };
}

/** The names of the gates, in their order. */
export const COPY_GATES = ["noFalseClear", "oneIncident", "settles", "clears", "tellsStop", "noLongLate"] as const;

/** A gate of the case. */
export type CopyGate = (typeof COPY_GATES)[number];

/** The gates of each arm. */
export const ARM_GATES: Readonly<Record<CopyArm, readonly CopyGate[]>> = {
  control: ["noFalseClear", "oneIncident", "settles", "clears", "noLongLate"],
  "copy-stopped": ["noFalseClear", "oneIncident", "settles", "clears", "tellsStop"],
  "ipaws-lag": ["noFalseClear", "oneIncident", "settles", "clears", "tellsStop"],
  "nws-lag": ["noFalseClear", "oneIncident", "settles", "clears", "noLongLate"],
};

/** This function gives the periods of late states of an arm, from its passes. */
export function latePeriodsOf(passes: readonly CopyPass[]): LatePeriod[] {
  const periods: LatePeriod[] = [];
  let open: { readonly from: number; readonly nws: number } | undefined;
  for (const pass of passes) {
    if (pass.state === "late" && open === undefined) {
      open = { from: pass.at, nws: pass.nws };
    } else if (pass.state !== "late" && open !== undefined) {
      periods.push({ ...open, to: pass.at });
      open = undefined;
    }
  }
  if (open !== undefined) periods.push(open);
  return periods;
}

/** The gates of an arm, and the facts that decide them. */
export interface CopyResult {
  readonly gates: Readonly<Partial<Record<CopyGate, boolean>>>;
  readonly periods: readonly LatePeriod[];
  /** The count of NWS fetches at the first late pass from the start of the window. */
  readonly toldAt?: number;
  /** The time of each pass with no threat at `kept`, or with no threat at `dropped` before the EXT message. */
  readonly falseClears: readonly number[];
  /** The time of each pass with two threats or more at one place. */
  readonly doubles: readonly number[];
}

/** This function gives the gates of an arm from its passes. */
export function copyGatesOf(record: Pick<CopyRecord, "arm" | "passes">, settings: CopySettings = CASE_8_SETTINGS): CopyResult {
  const { arm, passes } = record;
  const ext = extFetchOf(arm, settings.fetches);
  const fetched = passes.filter((pass) => pass.nws > 0);
  const falseClears = fetched.filter((pass) => pass.threats.kept < 1 || (pass.nws <= ext && pass.threats.dropped < 1)).map((pass) => pass.at);
  const doubles = passes.filter((pass) => pass.threats.kept > 1 || pass.threats.dropped > 1).map((pass) => pass.at);
  const last = passes.at(-1);
  const periods = latePeriodsOf(passes);
  // The count of NWS fetches is the number of the last fetch and 1. The window starts at the count WINDOW.from + 1.
  const told = passes.find((pass) => pass.nws > WINDOW.from && pass.state === "late");
  const all: Record<CopyGate, boolean> = {
    noFalseClear: fetched.length > 0 && falseClears.length === 0,
    oneIncident: doubles.length === 0,
    settles: last !== undefined && last.threats.kept === 1 && last.threats.dropped === 0,
    clears: last?.state === "met",
    tellsStop: told !== undefined && told.nws <= WINDOW.from + TELL_WITHIN,
    noLongLate: periods.every((period) => period.to !== undefined && period.to - period.from <= NWS_DESCRIPTOR.interval),
  };
  const gates = Object.fromEntries(ARM_GATES[arm].map((gate) => [gate, all[gate]]));
  return { gates, periods, ...(told === undefined ? {} : { toldAt: told.nws }), falseClears, doubles };
}

/** The verdict of the case. A case with no read does not pass. */
export interface CopyVerdict {
  /**
   * True when the settings are valid, and each arm has each fetch with no error. Each fetch is complete. Each fault came
   * from its proxy, and none got past it. Each arm has a limit of the delay before the window.
   */
  readonly read: boolean;
  readonly results: Readonly<Partial<Record<CopyArm, CopyResult>>>;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** This function gives each problem of the settings. */
export function copySettingsProblems(settings: CopySettings, pair: PairFixtures = readPair()): string[] {
  const problems: string[] = [];
  const interval = NWS_DESCRIPTOR.interval;
  if (IPAWS_DESCRIPTOR.interval !== interval) problems.push(`The IPAWS interval ${String(IPAWS_DESCRIPTOR.interval)} is not the NWS interval ${String(interval)}.`);
  if (!Number.isFinite(settings.speed) || settings.speed < 1) problems.push(`The speed ${String(settings.speed)} is not a finite number of 1 or more.`);
  const ext = Math.max(...COPY_ARMS.map((arm) => extFetchOf(arm, settings.fetches)));
  if (settings.fetches < WINDOW.to + LIST_SPAN || ext >= settings.fetches) problems.push(`The arm has ${String(settings.fetches)} fetches, too few for the end of the window and the EXT message.`);
  const time = (feature: Readonly<Record<string, unknown>>, field: string): number => Date.parse(String((feature["properties"] as Record<string, unknown>)[field]));
  const extSent = time(pair.extFeature, "sent");
  if (!(extSent >= settings.start + (EXT_FROM - 1) * interval && extSent < settings.start + EXT_FROM * interval)) {
    problems.push(`The EXT message is not sent in the minute before the fetch ${String(EXT_FROM)}.`);
  }
  if (time(pair.newFeature, "sent") > settings.start) problems.push("The NEW message is sent after the start of the arm.");
  if (time(pair.newFeature, "expires") <= settings.start + (ext + 1) * interval) problems.push("The NEW message expires before the last arm gets the EXT message.");
  if (time(pair.extFeature, "expires") <= settings.start + (settings.fetches + 1) * interval) problems.push("The EXT message expires in the arm.");
  return problems;
}

/** This function gives the verdict of the records of a run. */
export function copyVerdictOf(records: readonly CopyRecord[], settings: CopySettings = CASE_8_SETTINGS, pair: PairFixtures = readPair()): CopyVerdict {
  const problems = copySettingsProblems(settings, pair);
  for (const arm of COPY_ARMS) {
    const count = records.filter((record) => record.arm === arm).length;
    if (count !== 1) problems.push(`${arm}: ${String(count)} records, not 1.`);
  }
  for (const record of records) {
    const faults = copyFaultsOf(record.arm);
    if (record.error !== undefined) problems.push(`${record.arm}: a pass threw: ${record.error}`);
    for (const source of ["nws", "ipaws"] as const) {
      const list = record.fetches[source];
      if (list.length < settings.fetches) problems.push(`${record.arm}: ${String(list.length)} ${source} fetches, not ${String(settings.fetches)}.`);
      const bad = list.flatMap((fetch, at) => (fetch.ok && fetch.complete ? [] : [at]));
      if (bad.length > 0) problems.push(`${record.arm}: the ${source} fetches ${bad.join(", ")} failed or are not complete.`);
    }
    let direct = 0;
    for (const route of COPY_ROUTES) {
      const planned = faults[route].size;
      const counts = record.requests[route];
      direct += counts.direct;
      if (counts.proxied !== planned || record.faults[route] !== planned) {
        problems.push(`${record.arm}: ${String(counts.proxied)} ${route} requests to the proxy and ${String(record.faults[route])} faults, not ${String(planned)}.`);
      }
    }
    if (record.leaked > 0) problems.push(`${record.arm}: ${String(record.leaked)} requests got to the servers behind the proxies.`);
    if (record.served !== direct) problems.push(`${record.arm}: the server read ${String(record.served)} requests, not the ${String(direct)} direct requests.`);
    const before = record.passes.filter((pass) => pass.nws <= WINDOW.from).at(-1);
    if (before?.limit === undefined) problems.push(`${record.arm}: the lateness has no limit of the delay before the window.`);
  }
  const read = problems.length === 0;
  const results: Partial<Record<CopyArm, CopyResult>> = {};
  for (const record of records) results[record.arm] = copyGatesOf(record, settings);
  const pass = read && COPY_ARMS.every((arm) => ARM_GATES[arm].every((gate) => results[arm]?.gates[gate] === true));
  return { read, results, pass, problems };
}

/** The records of one run of the case. */
export interface CopyRun {
  readonly id: string;
  readonly seed: string;
  readonly settings: CopySettings;
  readonly records: readonly CopyRecord[];
  readonly verdict: CopyVerdict;
}

/** This function starts the case: each arm at the same time. It gives the records and the verdict. */
export async function runCopyLate(given: Partial<CopySettings> = {}): Promise<CopyRun> {
  const settings: CopySettings = { ...CASE_8_SETTINGS, ...given };
  const pair = readPair();
  const bodies = copyBodiesOf(settings, pair);
  const records = await Promise.all(COPY_ARMS.map((arm) => runCopyArm(arm, settings, bodies)));
  return { id: CASE_8_ID, seed: CASE_8_ID, settings, records, verdict: copyVerdictOf(records, settings, pair) };
}
