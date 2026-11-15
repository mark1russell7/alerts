/**
 * AL-13, case 5: a source down. The host of the NWS source does not answer for a time, and then it answers again.
 *
 * The NWS source has the pace of an instance (`sourcePace` and `SOURCE_POLICY`), as in production. The case clock moves `speed` times faster
 * than real time. Thus an arm of 80 minutes takes 80 seconds at the speed 60. Each request of an arm goes through a
 * fault proxy of `@mark1russell7/rigor-proxy` to the server. The proxy reads the case clock.
 *
 * The plan of an arm with an outage has one fault of a window (the format `rigor-faults/2`). The proxy stops each
 * request of the window before the server. This includes a request on a connection that opened before the window. The
 * case has five arms:
 *
 * - `control`: no outage. This arm is the control of the case. Its plan has no fault.
 * - `reset-short`: the proxy resets each connection, for 3 minutes.
 * - `reset-long`: the proxy resets each connection, for 10 minutes.
 * - `error-long`: the proxy gives HTTP 500 to each request, for 10 minutes.
 * - `unavailable-long`: the proxy gives HTTP 503 to each request, for 10 minutes.
 *
 * The gates of each arm with an outage come from `windowResponse` of `@mark1russell7/rigor-chaos`. Their samples are
 * the health of the source at each pass of the runtime:
 *
 * - `detected`: the health goes down in 3 intervals of the source after the start of the outage.
 * - `recovered`: the health comes up in the recovery limit after the end of the outage. The limit is the backoff cap
 *   of `polite-crawler` and two intervals of the source.
 *
 * A gate has no read when the samples cannot decide it.
 */
import { DEFAULT_COVERAGE_POLICY, type HealthState } from "@mark1russell7/alerts";
import { delay, wallClock } from "@mark1russell7/algebra/clock";
import { openRuntime, openRuntimeLog, SOURCE_POLICY, sourcePace, type RuntimeOptions } from "@mark1russell7/alerts-runtime";
import { CANARY_PATH, createNwsSource, NWS_DESCRIPTOR, SOURCE_ID } from "@mark1russell7/alerts-source-nws-api";
import { type FaultPlan, type FaultWindow, faultPlanOf, type HealthSample, type WindowFault, type WindowResponse, windowResponse } from "@mark1russell7/rigor-chaos";
import { random } from "@mark1russell7/rigor-generators";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { fetchTransport, type Reply, type Transport } from "polite-crawler/api";
import type { Clock as PoliteClock, PolitenessPolicy } from "polite-crawler/politeness";
import { type CaseBodies, caseBodies, NWS_WATCH, startNwsServer } from "./nws.ts";

/** The id and the seed of the case. The jitter of the backoff of each arm comes from this seed and the name of the arm. */
export const CASE_5_ID = "al-13-case-5";
const MINUTE = 60_000;
/** The origin of the source in the case. The transport of the case refuses each other origin. */
export const CASE_5_ORIGIN = "http://nws.test";
const USER_AGENT = "alerts-testkit/0 (fault suite)";
const VIEW: RuntimeOptions["view"] = { places: NWS_WATCH.places, kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

/** An arm of the case: the control, or an outage of a kind and a length. */
export type DownArm = "control" | "reset-short" | "reset-long" | "error-long" | "unavailable-long";

/** The arms of the case. The run starts them at the same time, each with its own servers, proxy and clock. */
export const DOWN_ARMS: readonly DownArm[] = ["control", "reset-short", "reset-long", "error-long", "unavailable-long"];

/** The arms with an outage. */
export const OUTAGE_ARMS: readonly DownArm[] = DOWN_ARMS.filter((arm) => arm !== "control");

/** The settings of the case. Each time is in milliseconds of the case clock. */
export interface DownSettings {
  /** The milliseconds of the case clock in one real millisecond. */
  readonly speed: number;
  /** The time of each arm. */
  readonly armMs: number;
  /** The start of the outage after the start of the arm. */
  readonly outageAtMs: number;
  /** The time of the outage of `reset-short`. */
  readonly shortMs: number;
  /** The time of the outage of each other arm with an outage. */
  readonly longMs: number;
}

/**
 * The settings of the case in CI, as the prediction states. The outage starts between two fetches. Each arm is long
 * enough to show the end of the stop of one hour of `DEFAULT_POLICY` of `polite-crawler`, the policy before `SOURCE_POLICY`.
 */
export const CASE_5_SETTINGS: DownSettings = { speed: 60, armMs: 80 * MINUTE, outageAtMs: 4.5 * MINUTE, shortMs: 3 * MINUTE, longMs: 10 * MINUTE };

/** The limits of the gates, from the policy of `polite-crawler` and the interval of the source. */
export interface DownLimits {
  /** The interval of the fetches of the source. */
  readonly intervalMs: number;
  /** The health goes down in this time after the start of the outage. */
  readonly detectMs: number;
  /** The health comes up in this time after the end of the outage. */
  readonly recoverMs: number;
  /** The count of failures in a row that stops the host, from the policy. */
  readonly stopAfter: number;
}

/**
 * This function gives the limits of the gates. A wait of the backoff ends in `backoffCapMs` after the end of the outage.
 * A fetch starts in one interval after that, and it ends in one more interval, its limit in the runtime.
 */
export function downLimits(policy: PolitenessPolicy = SOURCE_POLICY, intervalMs: number = NWS_DESCRIPTOR.interval): DownLimits {
  return { intervalMs, detectMs: 3 * intervalMs, recoverMs: policy.backoffCapMs + 2 * intervalMs, stopAfter: policy.maxFailures };
}

/**
 * This function gives the outage window of an arm, or `undefined` for `control`. The times are after the start of the
 * arm. The window has its start and does not have its end.
 */
export function outageOf(arm: DownArm, settings: DownSettings = CASE_5_SETTINGS): FaultWindow | undefined {
  if (arm === "control") return undefined;
  const from = settings.outageAtMs;
  return { from, to: from + (arm === "reset-short" ? settings.shortMs : settings.longMs) };
}

/**
 * This function gives the fault of the outage window of an arm, or `undefined` for `control`. The fault stops the first
 * byte or the first request of each connection in the window.
 */
export function windowFaultOf(arm: DownArm, settings: DownSettings = CASE_5_SETTINGS): WindowFault | undefined {
  const window = outageOf(arm, settings);
  if (window === undefined) return undefined;
  if (arm === "reset-short" || arm === "reset-long") return { window, direction: "up", at: { byte: 0 }, kind: "reset" };
  return { window, direction: "up", at: { frame: 0 }, kind: "answer", status: arm === "error-long" ? 500 : 503 };
}

/** This function gives the fault plan of an arm: no fault for `control`, and one fault of a window for each other arm. */
export function planOf(arm: DownArm, settings: DownSettings = CASE_5_SETTINGS): FaultPlan {
  const fault = windowFaultOf(arm, settings);
  return faultPlanOf([], fault === undefined ? [] : [fault]);
}

/** The clock of the case. The runtime reads `now` and `after`. The scheduler of `polite-crawler` reads `now` and `sleep`. */
export type CaseClock = RuntimeOptions["clock"] & PoliteClock;

/**
 * This function gives the clock of a case: the scaled wall clock of `@mark1russell7/algebra/clock`, from the instant `start`.
 * The clock moves `speed` times faster than real time. A timer that the platform fires early waits again.
 */
export function caseClock(start: number, speed: number): CaseClock {
  const wall = wallClock({ start, speed });
  return {
    time: "wall",
    now: () => wall.now(),
    after: (ms, run) => wall.after(ms, run),
    // The function `delay` rejects when the signal aborts. A sleep of `polite-crawler` ends early with no error.
    sleep: (ms, signal) => delay(wall, ms, signal).catch(() => undefined),
  };
}

/** The options of the transport of the case. */
export interface CaseTransportOptions {
  /** The transport that sends each request to a server. */
  readonly inner: Transport;
  readonly clock: { readonly now: () => number };
  /** The origin of the fault proxy. */
  readonly proxy: string;
  /** This function gives the canary answer at a time of the clock. */
  readonly canary: (at: number) => Reply;
  /** The transport adds the time of each request on the clock to this list. */
  readonly sent: number[];
}

/**
 * This function gives the transport of the case. It refuses each origin other than `CASE_5_ORIGIN`. It sends each
 * request to the fault proxy, and it does not know the outage window. The canary check of the source needs a recent
 * keepalive, thus a canary reply of 200 gets the keepalive of the time of the request.
 */
export function caseTransport(options: CaseTransportOptions): Transport {
  const { inner, clock, sent } = options;
  return async (exchange, signal) => {
    const url = new URL(exchange.url);
    if (url.origin !== CASE_5_ORIGIN) throw new TypeError(`The address ${exchange.url} is not an address of the case.`);
    const at = clock.now();
    sent.push(at);
    const target = `${url.pathname}${url.search}`;
    const reply = await inner({ ...exchange, url: `${options.proxy}${target}` }, signal);
    return target === CANARY_PATH && reply.status === 200 ? options.canary(at) : reply;
  };
}

/**
 * This function gives the canary answer of the case at a time: the keepalive messages of the canary body, sent one
 * minute before the time. Thus the canary check of the source passes at each fetch.
 */
export function canaryAnswer(bodies: CaseBodies): (at: number) => Reply {
  const { features } = JSON.parse(new TextDecoder().decode(bodies.canary)) as { readonly features: readonly { readonly properties: object }[] };
  return (at) => ({
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/geo+json" },
    body: JSON.stringify({
      type: "FeatureCollection",
      features: features.map((feature) => ({ ...feature, properties: { ...feature.properties, sent: new Date(at - MINUTE).toISOString() } })),
    }),
  });
}

/** One pass of the runtime in an arm. */
export interface DownPass {
  /** The time of the view of the pass, after the start of the arm. */
  readonly at: number;
  readonly state: HealthState;
  /** True when the pass fetched the source. */
  readonly fetched: boolean;
  /** The failure of the fetch of the pass, when the fetch failed. */
  readonly failure?: { readonly kind: string; readonly message: string };
}

/** The count of the requests of an arm. */
export interface RequestCounts {
  /** The requests that the source sent. Each request goes to the fault proxy. */
  readonly sent: number;
  /** The requests that the source sent in the outage window. */
  readonly inWindow: number;
  /** The requests that the server behind the proxy read. */
  readonly reached: number;
}

/** The records of one arm. */
export interface DownRecord {
  readonly arm: DownArm;
  readonly outage?: FaultWindow;
  readonly passes: readonly DownPass[];
  readonly requests: RequestCounts;
  /** The count of the faults that the proxy recorded. */
  readonly faults: number;
  /** The count of the connections that the proxy accepted. */
  readonly connections: number;
  /** The message of a throw of a pass. */
  readonly error?: string;
}

/** This function starts one arm: a server, a fault proxy in front of it, a new runtime and its passes on a new clock. */
export async function runDownArm(arm: DownArm, settings: DownSettings = CASE_5_SETTINGS, bodies: CaseBodies = caseBodies()): Promise<DownRecord> {
  const outage = outageOf(arm, settings);
  const server = await startNwsServer(bodies, "length");
  const start = Date.now();
  const clock = caseClock(start, settings.speed);
  // The proxy reads the case clock from the start of the arm. Thus the windows of the plan are in the time of the arm.
  const proxy = await startFaultProxy({ target: { host: server.host, port: server.port }, plan: planOf(arm, settings), protocol: "http", clock, origin: start });
  const sent: number[] = [];
  const transport = caseTransport({
    inner: fetchTransport({ userAgent: USER_AGENT }),
    clock,
    proxy: `http://${proxy.host}:${String(proxy.port)}`,
    canary: canaryAnswer(bodies),
    sent,
  });
  const jitter = random(`${CASE_5_ID}-${arm}`);
  // The pace of production: the pace of an instance on the case clock, with the jitter of the arm. The timers of the case clock are its monotonic clock.
  const pace = { ...sourcePace({ now: clock.now, after: clock.after }, clock, 1), random: () => jitter.next() };
  const source = createNwsSource({ pace, transport, userAgent: USER_AGENT, baseUrl: CASE_5_ORIGIN });
  const log = openRuntimeLog(":memory:");
  const passes: DownPass[] = [];
  let error: string | undefined;
  try {
    const runtime = openRuntime({ log, clock, sources: [source], watch: () => NWS_WATCH, view: VIEW, run: `${CASE_5_ID}-${arm}` });
    const end = start + settings.armMs;
    while (clock.now() < end) {
      const before = clock.now();
      const pass = await runtime.pass();
      const health = pass.view.health.find((one) => one.source === SOURCE_ID);
      const fetched = pass.fetched.includes(SOURCE_ID);
      const last = health?.lastFailure;
      const failed = fetched && last !== undefined && last.at >= before;
      passes.push({
        at: pass.at - start,
        state: health?.state ?? "unknown",
        fetched,
        ...(failed ? { failure: { kind: last.failure.kind, message: last.failure.message } } : {}),
      });
      const next = Math.min(pass.wakeAt ?? Number.POSITIVE_INFINITY, clock.now() + NWS_DESCRIPTOR.interval, end);
      await clock.sleep(next - clock.now());
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  log.close();
  await proxy.close();
  const reached = server.requests.length;
  await server.close();
  const inWindow = outage === undefined ? 0 : sent.filter((at) => at - start >= outage.from && at - start < outage.to).length;
  return {
    arm,
    ...(outage === undefined ? {} : { outage }),
    passes,
    requests: { sent: sent.length, inWindow, reached },
    faults: proxy.records.length,
    connections: proxy.connections.length,
    ...(error === undefined ? {} : { error }),
  };
}

/** The response of the health of an arm to its outage window, and the problems with the name of the arm. */
export type DownResult = WindowResponse;

const isUp = (state: HealthState): boolean => DEFAULT_COVERAGE_POLICY.up.includes(state);

/** This function gives the health samples of an arm: one for each pass. A sample is up when the coverage counts the state of the pass. */
export function samplesOf(record: DownRecord): HealthSample[] {
  return record.passes.map((pass) => ({ at: pass.at, up: isUp(pass.state) }));
}

/** This function gives the response of an arm to its outage window, from `windowResponse` of `@mark1russell7/rigor-chaos`. */
export function downGatesOf(record: DownRecord, limits: DownLimits = downLimits()): DownResult {
  const { outage } = record;
  if (outage === undefined) return { detected: "no read", recovered: "no read", problems: [`${record.arm}: the arm has no outage.`] };
  const response = windowResponse(outage, samplesOf(record), limits);
  return { ...response, problems: response.problems.map((problem) => `${record.arm}: ${problem}`) };
}

/** The verdict of the case. A case with no read does not pass. */
export interface DownVerdict {
  /**
   * True when the settings are valid, the control arm stays up, each fault falls at its point and no pass throws. The
   * samples of each arm with an outage also decide its gates.
   */
  readonly read: boolean;
  readonly results: Readonly<Partial<Record<DownArm, DownResult>>>;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** This function gives the problems of the settings. With a problem, the case cannot read. */
export function settingsProblems(settings: DownSettings, limits: DownLimits = downLimits()): string[] {
  const { intervalMs, stopAfter, recoverMs } = limits;
  const problems: string[] = [];
  if (settings.outageAtMs < 2 * intervalMs) problems.push(`The outage starts before two fetches (${String(settings.outageAtMs)} ms).`);
  // One fetch more than the count of intervals, for the drift of the passes
  if (Math.ceil(settings.shortMs / intervalMs) + 1 >= stopAfter) problems.push(`The short outage (${String(settings.shortMs)} ms) can have ${String(stopAfter)} failures in a row, the count that stops the host.`);
  if (settings.longMs < (stopAfter + 1) * intervalMs) problems.push(`The long outage (${String(settings.longMs)} ms) does not have ${String(stopAfter)} failures in a row.`);
  if (settings.armMs < settings.outageAtMs + settings.longMs + recoverMs) problems.push(`The arm (${String(settings.armMs)} ms) ends before the recovery limit of a long outage.`);
  return problems;
}

/** This function gives the verdict of the records of a run. */
export function downVerdictOf(records: readonly DownRecord[], settings: DownSettings = CASE_5_SETTINGS, limits: DownLimits = downLimits()): DownVerdict {
  const problems = settingsProblems(settings, limits);
  for (const arm of DOWN_ARMS) {
    const count = records.filter((record) => record.arm === arm).length;
    if (count !== 1) problems.push(`${arm}: ${String(count)} records, not 1.`);
  }
  for (const record of records) {
    if (record.error !== undefined) problems.push(`${record.arm}: a pass threw: ${record.error}`);
    const last = record.passes.at(-1);
    if (last === undefined || last.at < settings.armMs - limits.intervalMs) problems.push(`${record.arm}: the passes end before the end of the arm.`);
    const first = record.passes.findIndex((pass) => pass.fetched && isUp(pass.state));
    const from = record.outage?.from ?? Number.POSITIVE_INFINITY;
    const before = record.passes.filter((pass, index) => first !== -1 && index >= first && pass.at < from);
    if (first === -1 || before.some((pass) => !isUp(pass.state))) {
      problems.push(`${record.arm}: the source is not up at each pass ${record.outage === undefined ? "after its first fetch" : "before the outage"}.`);
    }
    const { sent, inWindow, reached } = record.requests;
    if (record.outage === undefined && record.faults > 0) problems.push(`${record.arm}: the proxy recorded ${String(record.faults)} faults with no outage.`);
    if (record.outage !== undefined && record.faults === 0) problems.push(`${record.arm}: the proxy has no record of a fault.`);
    if (record.outage !== undefined && inWindow === 0) problems.push(`${record.arm}: the source sent no request in the outage window.`);
    // Each fault stops one request and closes its connection. Thus each request gets to the server or has one fault.
    if (reached + record.faults !== sent) {
      problems.push(`${record.arm}: the source sent ${String(sent)} requests, but ${String(reached)} got to the server and ${String(record.faults)} stopped at the proxy.`);
    }
  }
  const recordsRead = problems.length === 0;
  const results: Partial<Record<DownArm, DownResult>> = {};
  for (const record of records.filter((one) => one.outage !== undefined)) {
    const result = downGatesOf(record, limits);
    results[record.arm] = result;
    problems.push(...result.problems);
  }
  const read = recordsRead && OUTAGE_ARMS.every((arm) => gatesRead(results[arm]));
  const pass = read && OUTAGE_ARMS.every((arm) => results[arm]?.detected === "pass" && results[arm].recovered === "pass");
  return { read, results, pass, problems };
}

/**
 * This function tells if the samples decide the gates of an arm. A gate with no read stops the read of the case. A fail
 * of `detected` decides the arm, thus `recovered` with no read after it does not stop the read.
 */
export function gatesRead(result: DownResult | undefined): boolean {
  if (result === undefined || result.detected === "no read") return false;
  return result.detected === "fail" || result.recovered !== "no read";
}

/** The records of one run of the case. */
export interface DownRun {
  readonly id: string;
  readonly seed: string;
  readonly settings: DownSettings;
  readonly limits: DownLimits;
  readonly records: readonly DownRecord[];
  readonly verdict: DownVerdict;
}

/** This function starts the case: each arm at the same time. It gives the records and the verdict. */
export async function runSourceDown(given: Partial<DownSettings> = {}): Promise<DownRun> {
  const settings: DownSettings = { ...CASE_5_SETTINGS, ...given };
  const limits = downLimits();
  const bodies = caseBodies();
  const records = await Promise.all(DOWN_ARMS.map((arm) => runDownArm(arm, settings, bodies)));
  return { id: CASE_5_ID, seed: CASE_5_ID, settings, limits, records, verdict: downVerdictOf(records, settings, limits) };
}
