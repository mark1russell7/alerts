/**
 * AL-13, case 2: a slow source. The reply of the main query of the NWS source comes slowly, and the fetch has a time
 * limit for each query.
 *
 * A fault proxy of `@mark1russell7/rigor-proxy` slows connection 0, down, at a byte point of the main reply. The case
 * has three arms, for each framing of the reply:
 *
 * - `long`: a stall that is longer than the limit. Each fetch gives `{ ok: false }` with the kind `timeout`, and ends
 *   before the stall ends.
 * - `trickle`: the body goes out in many small writes, with a gap between two writes. Each write comes in less
 *   than the limit, but the full body does not. Each fetch gives the kind `timeout`, and ends before the trickle ends.
 * - `short`: a stall that is much shorter than the limit. Each fetch gives the full list, with no failure.
 *
 * Thus the limit covers the head and the body of a reply, and a short pause does not give a false failure.
 */
import { faultPlanOf, sweepPoints } from "@mark1russell7/rigor-chaos";
import type { Fault } from "@mark1russell7/rigor-chaos";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { FRAMINGS, type Framing } from "@mark1russell7/rigor-testkit/http";
import { type Baseline, baselineOf, caseBodies, type FetchLimits, fetchOnce, mainAfter, type OutcomeSummary, sameHead, startNwsServer } from "./nws.ts";

/** The id and the seed of the case. The stall points of each framing come from this seed, as the prediction states. */
export const CASE_2_ID = "al-13-case-2";

/** An arm of the case: a long stall, a trickle or a short stall. */
export type SlowArm = "long" | "trickle" | "short";

/** The arms of the case, in the order of a run. */
export const SLOW_ARMS: readonly SlowArm[] = ["long", "trickle", "short"];

/** The settings of the case. */
export interface SlowSettings {
  /** The number of seeded points in the body, in addition to the edges of the body. */
  readonly draws: number;
  /** The time limit of each query of the NWS fetch, in milliseconds. The transport has its default limit. */
  readonly limitMs: number;
  /** The stall of the arm `long`, in milliseconds. It is longer than the limit. */
  readonly longStallMs: number;
  /** The stall of the arm `short`, in milliseconds. It is a quarter of the limit or less. */
  readonly shortStallMs: number;
  /** The writes of the arm `trickle`, and the gap between two writes, in milliseconds. */
  readonly trickle: { readonly pieces: number; readonly gapMs: number };
}

/** The settings of the case in CI, as the prediction states. */
export const CASE_2_SETTINGS: SlowSettings = { draws: 4, limitMs: 2000, longStallMs: 8000, shortStallMs: 500, trickle: { pieces: 40, gapMs: 100 } };

/** The fetch of one fault. */
export interface SlowRecord {
  readonly framing: Framing;
  readonly arm: SlowArm;
  /** The byte point of the fault on connection 0, down, from the start of the main reply. */
  readonly point: number;
  /** True when the proxy recorded the fault at `point`, on connection 0, down. */
  readonly faulted: boolean;
  /** True when the main reply started its connection, with the head of the baseline. */
  readonly sameHead: boolean;
  readonly outcome: OutcomeSummary;
  /** The time from the call of the fetch to its end, in milliseconds. */
  readonly ms: number;
}

/** The verdict of the case. A case with no read does not pass. */
export interface SlowVerdict {
  /** True when the settings are valid, each baseline is whole and fast, and each fault fell at its point. */
  readonly read: boolean;
  /** For each arm: true when each fetch of the arm gave the result of its gate. */
  readonly gates: Readonly<Record<SlowArm, boolean>>;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** The records of one run of the case. */
export interface SlowRun {
  readonly id: string;
  readonly seed: string;
  readonly bodyBytes: number;
  readonly settings: SlowSettings;
  readonly baselines: readonly Baseline[];
  readonly records: readonly SlowRecord[];
  readonly verdict: SlowVerdict;
}

/** The options of a run. The defaults are the settings of the case in CI. */
export interface SlowOptions extends Partial<SlowSettings> {
  readonly framings?: readonly Framing[];
}

/**
 * This function gives the stall points of a reply, from the start of the reply. The points are the first byte of the
 * head, the middle of the head, and the head plus each point of `sweepPoints` in the body.
 */
export function stallPoints(head: number, body: number, draws: number, seed: string): number[] {
  const inBody = sweepPoints(body, draws, seed).map((offset) => head + offset);
  return [...new Set([0, Math.floor(head / 2), ...inBody])].sort((a, b) => a - b);
}

/** This function gives the time of the arm `trickle`: the gaps between its writes, in milliseconds. */
export function trickleMs(settings: SlowSettings): number {
  return (settings.trickle.pieces - 1) * settings.trickle.gapMs;
}

const faultOf = (arm: SlowArm, point: number, settings: SlowSettings): Fault => {
  const at = { connection: 0, direction: "down", at: { byte: point } } as const;
  if (arm === "trickle") return { ...at, kind: "split", pieces: settings.trickle.pieces, gapMs: settings.trickle.gapMs };
  return { ...at, kind: "stall", ms: arm === "long" ? settings.longStallMs : settings.shortStallMs };
};

/** This function starts the case: a baseline and each fault of each arm, for each framing. It gives the records and the verdict. */
export async function runSlowSource(options: SlowOptions = {}): Promise<SlowRun> {
  const { framings = FRAMINGS, ...given } = options;
  const settings: SlowSettings = { ...CASE_2_SETTINGS, ...given };
  const limits: FetchLimits = { timeoutMs: settings.limitMs };
  const bodies = caseBodies();
  const baselines: Baseline[] = [];
  const records: SlowRecord[] = [];
  for (const framing of framings) {
    const server = await startNwsServer(bodies, framing);
    try {
      const baseline = await baselineOf(server, framing, limits);
      baselines.push(baseline);
      if (!baseline.whole || baseline.head < 2 || baseline.body < settings.draws + 3) continue;
      const points = stallPoints(baseline.head, baseline.body, settings.draws, CASE_2_ID);
      for (const arm of SLOW_ARMS) {
        for (const point of arm === "trickle" ? [baseline.head] : points) {
          const fault = faultOf(arm, point, settings);
          const proxy = await startFaultProxy({ target: { host: server.host, port: server.port }, plan: faultPlanOf([fault]), protocol: "http" });
          const from = server.requests.length;
          let outcome: OutcomeSummary;
          let ms: number;
          try {
            const started = performance.now();
            outcome = await fetchOnce(`http://${proxy.host}:${String(proxy.port)}`, limits);
            ms = Math.round(performance.now() - started);
          } finally {
            await proxy.close();
          }
          records.push({
            framing,
            arm,
            point,
            faulted: proxy.records.some(
              (r) => r.kind === fault.kind && r.connection === 0 && r.direction === "down" && r.byte === point && (arm !== "trickle" || r.bytes >= settings.trickle.pieces),
            ),
            sameHead: sameHead(mainAfter(server, from), baseline),
            outcome,
            ms,
          });
        }
      }
    } finally {
      await server.close();
    }
  }
  return {
    id: CASE_2_ID,
    seed: CASE_2_ID,
    bodyBytes: bodies.main.length,
    settings,
    baselines,
    records,
    verdict: slowVerdictOf(baselines, records, bodies.observations, settings, framings),
  };
}

/** This function gives the verdict of the records of a run. `observations` is the count of a whole fetch. */
export function slowVerdictOf(
  baselines: readonly Baseline[],
  records: readonly SlowRecord[],
  observations: number,
  settings: SlowSettings,
  framings: readonly Framing[] = FRAMINGS,
): SlowVerdict {
  const problems: string[] = [];
  const fastBaseline = settings.limitMs / 4;
  if (settings.longStallMs <= settings.limitMs) problems.push(`The long stall (${String(settings.longStallMs)} ms) is not longer than the limit (${String(settings.limitMs)} ms).`);
  if (trickleMs(settings) <= settings.limitMs) problems.push(`The trickle (${String(trickleMs(settings))} ms) is not longer than the limit (${String(settings.limitMs)} ms).`);
  if (settings.shortStallMs > fastBaseline) problems.push(`The short stall (${String(settings.shortStallMs)} ms) is longer than a quarter of the limit.`);
  const expected: Record<SlowArm, number> = { long: settings.draws + 5, trickle: 1, short: settings.draws + 5 };
  for (const framing of framings) {
    const baseline = baselines.find((b) => b.framing === framing);
    if (baseline === undefined) {
      problems.push(`${framing}: no baseline.`);
      continue;
    }
    if (!baseline.whole) problems.push(`${framing}: the baseline reply did not start its connection, or the server did not write it whole.`);
    const o = baseline.outcome;
    if (!(o.ok && o.complete && o.observations === observations)) problems.push(`${framing}: the baseline fetch gave ${JSON.stringify(o)}, not ${String(observations)} observations, complete.`);
    if (baseline.ms >= fastBaseline) problems.push(`${framing}: the baseline fetch took ${String(baseline.ms)} ms, not less than ${String(fastBaseline)} ms.`);
    for (const arm of SLOW_ARMS) {
      const count = records.filter((r) => r.framing === framing && r.arm === arm).length;
      if (count !== expected[arm]) problems.push(`${framing} ${arm}: ${String(count)} faults, not ${String(expected[arm])}.`);
    }
  }
  for (const r of records) {
    if (!r.faulted) problems.push(`${r.framing} ${r.arm} at byte ${String(r.point)}: the proxy has no record of the fault at its point.`);
    if (!r.sameHead) problems.push(`${r.framing} ${r.arm} at byte ${String(r.point)}: the main reply did not start connection 0 with the head of the baseline.`);
  }
  const read = problems.length === 0;
  const timeoutBefore = (end: number) => (r: SlowRecord) => !r.outcome.ok && r.outcome.kind === "timeout" && r.ms < end;
  const whole = (r: SlowRecord) => r.outcome.ok && r.outcome.complete && r.outcome.observations === observations;
  const meets: Record<SlowArm, (r: SlowRecord) => boolean> = {
    long: timeoutBefore(settings.longStallMs),
    trickle: timeoutBefore(trickleMs(settings)),
    short: whole,
  };
  const wants: Record<SlowArm, string> = {
    long: `a timeout in less than ${String(settings.longStallMs)} ms`,
    trickle: `a timeout in less than ${String(trickleMs(settings))} ms`,
    short: `the full list of ${String(observations)} observations`,
  };
  const gates = Object.fromEntries(
    SLOW_ARMS.map((arm) => {
      const of = records.filter((r) => r.arm === arm);
      for (const r of of.filter((x) => !meets[arm](x))) {
        problems.push(`${r.framing} ${arm} at byte ${String(r.point)}: the fetch gave ${JSON.stringify(r.outcome)} in ${String(r.ms)} ms, not ${wants[arm]}.`);
      }
      return [arm, of.length > 0 && of.every(meets[arm])];
    }),
  ) as Record<SlowArm, boolean>;
  return { read, gates, pass: read && SLOW_ARMS.every((arm) => gates[arm]), problems };
}
