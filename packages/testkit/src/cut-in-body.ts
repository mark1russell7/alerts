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
import { faultPlanOf, sweepPoints } from "@mark1russell7/rigor-chaos";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { FRAMINGS, type Framing } from "@mark1russell7/rigor-testkit/http";
import { type Baseline, baselineOf, caseBodies, type FetchLimits, fetchOnce, mainAfter, type OutcomeSummary, sameHead, startNwsServer } from "./nws.ts";

/** The id and the seed of the case. The cut points of each framing come from this seed, as the prediction states. */
export const CASE_1_ID = "al-13-case-1";
/** The number of seeded cut points of each framing, in addition to the edges 0, 1 and the last byte. */
export const CASE_1_DRAWS = 16;
/** The time limits of the fetches of the case: 10 s for each query and for the transport. */
export const CASE_1_LIMITS: FetchLimits = { timeoutMs: 10_000, transportTimeoutMs: 10_000 };

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

/** The options of a run. The defaults are the options of the case in CI. */
export interface CaseOptions {
  readonly draws?: number;
  readonly framings?: readonly Framing[];
}

/** This function starts the case: a baseline and each cut, for each framing. It gives the records and the verdict. */
export async function runCutInBody(options: CaseOptions = {}): Promise<CaseRun> {
  const draws = options.draws ?? CASE_1_DRAWS;
  const framings = options.framings ?? FRAMINGS;
  const bodies = caseBodies();
  const baselines: Baseline[] = [];
  const records: CutRecord[] = [];
  for (const framing of framings) {
    const server = await startNwsServer(bodies, framing);
    try {
      const baseline = await baselineOf(server, framing, CASE_1_LIMITS);
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
          result = await fetchOnce(`http://${proxy.host}:${String(proxy.port)}`, CASE_1_LIMITS);
        } finally {
          await proxy.close();
        }
        const ms = Math.round(performance.now() - started);
        records.push({
          framing,
          offset,
          cutByte,
          cut: proxy.records.some((r) => r.kind === "cut" && r.connection === 0 && r.direction === "down" && r.byte === cutByte),
          sameHead: sameHead(mainAfter(server, from), baseline),
          outcome: result,
          ms,
        });
      }
    } finally {
      await server.close();
    }
  }
  return { id: CASE_1_ID, seed: CASE_1_ID, bodyBytes: bodies.main.length, baselines, records, verdict: verdictOf(baselines, records, bodies.observations, draws, framings) };
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
