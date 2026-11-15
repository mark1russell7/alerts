/**
 * The parts that the fault cases of the NWS source share. They are the bodies of the replies, the scripted server of
 * each framing, the fetch of the watch and the baseline fetch with no fault.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import { CANARY_PATH, createNwsFetch, WEA_PATH } from "@mark1russell7/alerts-source-nws-api";
import { splitBytes } from "@mark1russell7/rigor-proxy";
import { type Framing, type ScriptedRequest, type ScriptedServer, startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { fetchTransport } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";

/** The main query of the watch of the cases. */
export const MAIN_PATH = "/alerts/active?area=KS";
/** The watch of the cases: one state, a public region and not the place of an owner. */
export const NWS_WATCH: Watch = { places: [{ id: "ks" as PlaceId, codes: [{ system: "state", code: "KS" }], bufferKm: 0 }] };
/** The server writes the main body in this number of parts, so a fault can fall in a part or between two parts. */
export const BODY_PARTS = 4;

const USER_AGENT = "alerts-testkit/0 (fault suite)";
const CONTENT_TYPE = { "content-type": "application/geo+json" };
const EMPTY: Uint8Array = new TextEncoder().encode(JSON.stringify({ type: "FeatureCollection", features: [] }));

/** The result of one fetch, with no body. */
export type OutcomeSummary =
  | { readonly ok: true; readonly complete: boolean; readonly observations: number }
  | { readonly ok: false; readonly kind: string; readonly message: string };

/** The bodies of the replies of the scripted server. */
export interface CaseBodies {
  /** The main body: one feature collection of each fixture of the NWS source. */
  readonly main: Uint8Array;
  /** The canary body: the keepalive fixture. */
  readonly canary: Uint8Array;
  /** The count of the features of the main body. */
  readonly features: number;
  /**
   * The count of the observations of a whole fetch: the different features of the main body and of the canary body. The
   * fetch keeps one observation of a feature in two answers, and the keepalive fixture is in both bodies.
   */
  readonly observations: number;
}

/** The options of the bodies. */
export interface BodyOptions {
  /** The sent time of the keepalive of the canary body. When it is absent, the keepalive keeps its recorded time. */
  readonly keepaliveSent?: number;
}

/**
 * This function gives the bodies of the replies, from the fixtures of the NWS source. The recorded keepalive is old, so the
 * canary check fails for it. A case that reads the canary gives a recent `keepaliveSent`.
 */
export function caseBodies(options: BodyOptions = {}): CaseBodies {
  const root = dirname(createRequire(import.meta.url).resolve("@mark1russell7/alerts-source-nws-api/package.json"));
  const folder = join(root, "fixtures");
  const names = readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const read = (name: string): unknown => JSON.parse(readFileSync(join(folder, name), "utf8"));
  const features = names.map(read);
  const sent = options.keepaliveSent === undefined ? undefined : new Date(options.keepaliveSent).toISOString();
  const fresh = (feature: unknown): unknown =>
    sent === undefined ? feature : { ...(feature as object), properties: { ...(feature as { properties: object }).properties, sent } };
  const canary = names.filter((name) => name.includes("keepalive")).map((name) => fresh(read(name)));
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  const different = new Set([...features, ...canary].map((feature) => JSON.stringify(feature)));
  return {
    main: encode({ type: "FeatureCollection", features }),
    canary: encode({ type: "FeatureCollection", features: canary }),
    features: features.length,
    observations: different.size,
  };
}

/** The time limits of a fetch. */
export interface FetchLimits {
  /** The limit of each query of the NWS fetch, in milliseconds. */
  readonly timeoutMs: number;
  /** The limit of the transport, in milliseconds. When it is absent, the transport has the default of `fetchTransport`, as in production. */
  readonly transportTimeoutMs?: number;
}

/** This function gives the outcome of a fetch with no body. */
export const summaryOf = (outcome: FetchOutcome): OutcomeSummary =>
  outcome.ok
    ? { ok: true, complete: outcome.complete, observations: outcome.observations.length }
    : { ok: false, kind: outcome.failure.kind, message: outcome.failure.message };

/** The outcome of one fetch, or the message of a throw. */
export type FetchResult = { readonly outcome: FetchOutcome } | { readonly thrown: string };

/**
 * This function fetches the watch of the cases one time at `baseUrl`, and gives the outcome with its observations. Each
 * fetch has a new scheduler, so the pace of one fetch does not change the next fetch.
 */
export async function fetchResult(baseUrl: string, limits: FetchLimits): Promise<FetchResult> {
  const transport = fetchTransport({ userAgent: USER_AGENT, ...(limits.transportTimeoutMs === undefined ? {} : { timeoutMs: limits.transportTimeoutMs }) });
  const fetch = createNwsFetch({
    pace: { scheduler: new HostScheduler(realClock, 1), now: () => realClock.now() },
    transport,
    userAgent: USER_AGENT,
    baseUrl,
    minIntervalMs: 0,
    timeoutMs: limits.timeoutMs,
  });
  try {
    return { outcome: await fetch({ watch: NWS_WATCH }) };
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

/** This function fetches the watch one time, as `fetchResult` does, and gives the outcome with no body. A throw becomes the kind `thrown`. */
export async function fetchOnce(baseUrl: string, limits: FetchLimits): Promise<OutcomeSummary> {
  const result = await fetchResult(baseUrl, limits);
  return "thrown" in result ? { ok: false, kind: "thrown", message: result.thrown } : summaryOf(result.outcome);
}

/**
 * This function starts the scripted server of a framing. The main reply has `BODY_PARTS` parts. The reply of the national WEA
 * query is an empty collection, and the canary reply has one part. So a whole fetch has the three queries of production.
 */
export function startNwsServer(bodies: CaseBodies, framing: Framing): Promise<ScriptedServer> {
  return startScriptedServer({
    routes: [
      { path: MAIN_PATH, replies: [{ fields: CONTENT_TYPE, body: splitBytes(bodies.main, BODY_PARTS), framing }] },
      { path: WEA_PATH, replies: [{ fields: CONTENT_TYPE, body: EMPTY }] },
      { path: CANARY_PATH, replies: [{ fields: CONTENT_TYPE, body: bodies.canary }] },
    ],
  });
}

/** This function gives the first request of the main query that the server read after its first `from` requests. */
export function mainAfter(server: ScriptedServer, from: number): ScriptedRequest | undefined {
  return server.requests.slice(from).find((request) => request.target === MAIN_PATH);
}

/** The fetch of a framing with no fault. It gives the place of the main body on the wire. */
export interface Baseline {
  readonly framing: Framing;
  /** The bytes of the head of the main reply on the wire. */
  readonly head: number;
  /** The bytes of the body of the main reply on the wire. A `chunked` body includes its size lines. */
  readonly body: number;
  /** True when the main reply started its connection and the server wrote it whole. */
  readonly whole: boolean;
  readonly outcome: OutcomeSummary;
  /** The time of the fetch, in milliseconds. */
  readonly ms: number;
}

/** This function fetches the watch from the server with no fault, and gives the baseline of the framing. */
export async function baselineOf(server: ScriptedServer, framing: Framing, limits: FetchLimits): Promise<Baseline> {
  const from = server.requests.length;
  const started = performance.now();
  const outcome = await fetchOnce(server.url, limits);
  const ms = Math.round(performance.now() - started);
  const wire = mainAfter(server, from)?.wire;
  return { framing, head: wire?.head ?? 0, body: wire?.body ?? 0, whole: wire !== undefined && wire.offset === 0 && wire.whole, outcome, ms };
}

/** This function tells if the main reply of a request started its connection, with the head of the baseline. */
export function sameHead(request: ScriptedRequest | undefined, baseline: Baseline): boolean {
  return request !== undefined && request.wire.offset === 0 && request.wire.head === baseline.head;
}
