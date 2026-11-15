/**
 * AL-13, case 1: a cut of the connection in the body of the reply to the main query of the NWS source.
 *
 * The scripted server of `@mark1russell7/rigor-testkit/http` gives one reply in three framings: `length`
 * (`Content-Length`), `chunked`, and `close` (no length, the end of the connection ends the body). A fault
 * proxy of `@mark1russell7/rigor-proxy` cuts connection 0 at a byte point inside the body. The NWS fetch then
 * reads a reply that stops early. The gates of the case:
 *
 * - `length` and `chunked`: each cut gives `{ ok: false }` with the kind `network`.
 * - All framings: a cut does not give `{ ok: true, complete: true }` at any time. For `close`, the client cannot see the
 *   cut in the framing, so only the parse of the body can see it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { FetchOutcome, PlaceId, Watch } from "@mark1russell7/alerts";
import { CANARY_PATH, createNwsFetch } from "@mark1russell7/alerts-source-nws-api";
import { faultPlanOf, sweepPoints } from "@mark1russell7/rigor-chaos";
import { splitBytes, startFaultProxy } from "@mark1russell7/rigor-proxy";
import { FRAMINGS, type Framing, startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { fetchTransport } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";

/** The id and the seed of the case. The cut points of each framing come from this seed, as the prediction states. */
export const CASE_1_ID = "al-13-case-1";
/** The number of seeded cut points of each framing, in addition to the edges 0, 1 and the last byte. */
export const CASE_1_DRAWS = 16;
/** The server writes the body in this number of parts, so a cut can fall in a part or between two parts. */
export const CASE_1_PARTS = 4;
/** The main query of the watch of the case. */
export const MAIN_PATH = "/alerts/active?area=KS";
/** The watch of the case: one state, a public region and not the place of an owner. */
export const CASE_1_WATCH: Watch = { places: [{ id: "ks" as PlaceId, codes: [{ system: "state", code: "KS" }], bufferKm: 0 }] };

const USER_AGENT = "alerts-testkit/0 (fault suite)";
const TIMEOUT_MS = 10_000;
const CONTENT_TYPE = { "content-type": "application/geo+json" };

/** The result of one fetch, with no body. */
export type OutcomeSummary =
  | { readonly ok: true; readonly complete: boolean; readonly observations: number }
  | { readonly ok: false; readonly kind: string; readonly message: string };

/** The fetch of a framing with no fault. It gives the place of the body on the wire. */
export interface Baseline {
  readonly framing: Framing;
  /** The bytes of the head of the main reply on the wire. */
  readonly head: number;
  /** The bytes of the body of the main reply on the wire. A `chunked` body includes its size lines. */
  readonly body: number;
  /** True when the main reply started its connection and the server wrote it whole. */
  readonly whole: boolean;
  readonly outcome: OutcomeSummary;
}

/** The fetch of one cut. */
export interface CutRecord {
  readonly framing: Framing;
  /** The bytes of the body that go through before the cut. */
  readonly offset: number;
  /** The byte point of the cut on connection 0, down: the head and `offset` bytes of the body. */
  readonly cutByte: number;
  /** True when the proxy recorded the cut at `cutByte`, on connection 0, down. */
  readonly cut: boolean;
  /** True when the main reply started its connection, with the head of the baseline. */
  readonly sameHead: boolean;
  readonly outcome: OutcomeSummary;
  readonly ms: number;
}

/** The verdict of the case. A case with no read does not pass. */
export interface Verdict {
  /** True when each baseline is whole and each cut fell at its point in the body. */
  readonly read: boolean;
  /** For each framing: true when each cut gave `{ ok: false }` with the kind `network`. */
  readonly network: Readonly<Record<Framing, boolean>>;
  /** True when no cut gave `{ ok: true, complete: true }`. */
  readonly neverWhole: boolean;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** The records of one run of the case. */
export interface CaseRun {
  readonly id: string;
  readonly seed: string;
  readonly bodyBytes: number;
  readonly baselines: readonly Baseline[];
  readonly records: readonly CutRecord[];
  readonly verdict: Verdict;
}

/**
 * This function gives the bodies of the replies. The main body is one feature collection of each fixture of the NWS
 * source. The canary body has the keepalive fixture. A fetch gives the observations of each query, so a whole fetch
 * gives `observations`: the features of the main body and of the canary body.
 */
export function caseBodies(): { readonly main: Uint8Array; readonly canary: Uint8Array; readonly features: number; readonly observations: number } {
  const root = dirname(createRequire(import.meta.url).resolve("@mark1russell7/alerts-source-nws-api/package.json"));
  const folder = join(root, "fixtures");
  const names = readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const read = (name: string): unknown => JSON.parse(readFileSync(join(folder, name), "utf8"));
  const features = names.map(read);
  const canary = names.filter((name) => name.includes("keepalive")).map(read);
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  return {
    main: encode({ type: "FeatureCollection", features }),
    canary: encode({ type: "FeatureCollection", features: canary }),
    features: features.length,
    observations: features.length + canary.length,
  };
}

const summaryOf = (outcome: FetchOutcome): OutcomeSummary =>
  outcome.ok
    ? { ok: true, complete: outcome.complete, observations: outcome.observations.length }
    : { ok: false, kind: outcome.failure.kind, message: outcome.failure.message };

const nwsFetchAt = (baseUrl: string): ReturnType<typeof createNwsFetch> =>
  createNwsFetch({
    pace: { scheduler: new HostScheduler(realClock, 1), now: () => realClock.now() },
    transport: fetchTransport({ userAgent: USER_AGENT, timeoutMs: TIMEOUT_MS }),
    userAgent: USER_AGENT,
    baseUrl,
    minIntervalMs: 0,
    timeoutMs: TIMEOUT_MS,
  });

/** This function fetches the watch of the case one time. A throw becomes a failure of the kind `thrown`. */
async function fetchOnce(baseUrl: string): Promise<OutcomeSummary> {
  try {
    return summaryOf(await nwsFetchAt(baseUrl)({ watch: CASE_1_WATCH }));
  } catch (error) {
    return { ok: false, kind: "thrown", message: error instanceof Error ? error.message : String(error) };
  }
}

/** The options of a run. The defaults are the options of the case in CI. */
export interface CaseOptions {
  readonly draws?: number;
  readonly framings?: readonly Framing[];
}

/** This function starts the case: a baseline and each cut, for each framing. It gives the records and the verdict. */
export async function runCutInBody(options: CaseOptions = {}): Promise<CaseRun> {
  const draws = options.draws ?? CASE_1_DRAWS;
  const bodies = caseBodies();
  const baselines: Baseline[] = [];
  const records: CutRecord[] = [];
  for (const framing of options.framings ?? FRAMINGS) {
    const server = await startScriptedServer({
      routes: [
        { path: MAIN_PATH, replies: [{ fields: CONTENT_TYPE, body: splitBytes(bodies.main, CASE_1_PARTS), framing }] },
        { path: CANARY_PATH, replies: [{ fields: CONTENT_TYPE, body: bodies.canary }] },
      ],
    });
    try {
      const mainAfter = (from: number) => server.requests.slice(from).find((request) => request.target === MAIN_PATH);
      const outcome = await fetchOnce(server.url);
      const wire = mainAfter(0)?.wire;
      const baseline: Baseline = {
        framing,
        head: wire?.head ?? 0,
        body: wire?.body ?? 0,
        whole: wire !== undefined && wire.offset === 0 && wire.whole,
        outcome,
      };
      baselines.push(baseline);
      if (!baseline.whole || baseline.body < draws + 3) continue;
      for (const offset of sweepPoints(baseline.body, draws, CASE_1_ID)) {
        const cutByte = baseline.head + offset;
        const proxy = await startFaultProxy({
          target: { host: server.host, port: server.port },
          plan: faultPlanOf([{ connection: 0, direction: "down", at: { byte: cutByte }, kind: "cut" }]),
          protocol: "http",
        });
        const from = server.requests.length;
        const started = performance.now();
        let result: OutcomeSummary;
        try {
          result = await fetchOnce(`http://${proxy.host}:${String(proxy.port)}`);
        } finally {
          await proxy.close();
        }
        const ms = Math.round(performance.now() - started);
        const seen = mainAfter(from)?.wire;
        records.push({
          framing,
          offset,
          cutByte,
          cut: proxy.records.some((r) => r.kind === "cut" && r.connection === 0 && r.direction === "down" && r.byte === cutByte),
          sameHead: seen !== undefined && seen.offset === 0 && seen.head === baseline.head,
          outcome: result,
          ms,
        });
      }
    } finally {
      await server.close();
    }
  }
  return { id: CASE_1_ID, seed: CASE_1_ID, bodyBytes: bodies.main.length, baselines, records, verdict: verdictOf(baselines, records, bodies.observations, draws, options.framings ?? FRAMINGS) };
}

/** This function gives the verdict of the records of a run. `observations` is the count of a whole fetch. */
export function verdictOf(
  baselines: readonly Baseline[],
  records: readonly CutRecord[],
  observations: number,
  draws: number,
  framings: readonly Framing[] = FRAMINGS,
): Verdict {
  const problems: string[] = [];
  for (const framing of framings) {
    const baseline = baselines.find((b) => b.framing === framing);
    if (baseline === undefined) {
      problems.push(`${framing}: no baseline.`);
      continue;
    }
    if (!baseline.whole) problems.push(`${framing}: the baseline reply did not start its connection, or the server did not write it whole.`);
    const o = baseline.outcome;
    if (!(o.ok && o.complete && o.observations === observations)) problems.push(`${framing}: the baseline fetch gave ${JSON.stringify(o)}, not ${String(observations)} observations, complete.`);
    const count = records.filter((r) => r.framing === framing).length;
    if (count !== draws + 3) problems.push(`${framing}: ${String(count)} cuts, not ${String(draws + 3)}.`);
  }
  for (const r of records) {
    if (!r.cut) problems.push(`${r.framing} offset ${String(r.offset)}: the proxy has no record of the cut at byte ${String(r.cutByte)}.`);
    if (!r.sameHead) problems.push(`${r.framing} offset ${String(r.offset)}: the main reply did not start connection 0 with the head of the baseline.`);
  }
  const read = problems.length === 0;
  const isNetwork = (r: CutRecord): boolean => !r.outcome.ok && r.outcome.kind === "network";
  const network = Object.fromEntries(
    FRAMINGS.map((framing) => {
      const of = records.filter((r) => r.framing === framing);
      return [framing, of.length > 0 && of.every(isNetwork)];
    }),
  ) as Record<Framing, boolean>;
  const whole = records.filter((r) => r.outcome.ok && r.outcome.complete);
  for (const r of whole) problems.push(`${r.framing} offset ${String(r.offset)}: a cut body gave ok and complete, with ${String(r.outcome.ok ? r.outcome.observations : 0)} observations.`);
  for (const r of records.filter((x) => (x.framing === "length" || x.framing === "chunked") && !isNetwork(x))) {
    problems.push(`${r.framing} offset ${String(r.offset)}: the outcome is ${JSON.stringify(r.outcome)}, not a network failure.`);
  }
  const neverWhole = whole.length === 0;
  const pass = read && neverWhole && framings.filter((f) => f !== "close").every((f) => network[f]);
  return { read, network, neverWhole, pass, problems };
}
