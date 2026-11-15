/**
 * AL-13, case 5: a source down. The host of the NWS source does not answer for a time, and then it answers again.
 *
 * The NWS source has the default pace of `polite-crawler`, as in production. The case clock moves `speed` times faster
 * than real time. Thus an arm of 80 minutes takes 80 seconds at the speed 60. In the outage window, each request goes
 * to a fault proxy of `@mark1russell7/rigor-proxy`. The proxy stops each request before the server. The case has five
 * arms:
 *
 * - `control`: no outage. This arm is the control of the case.
 * - `reset-short`: the proxy resets each connection, for 3 minutes.
 * - `reset-long`: the proxy resets each connection, for 10 minutes.
 * - `error-long`: the proxy gives HTTP 500 to each request, for 10 minutes.
 * - `unavailable-long`: the proxy gives HTTP 503 to each request, for 10 minutes.
 *
 * The gates of each arm with an outage, from the health of the source at each pass of the runtime:
 *
 * - `detected`: the health goes down in 3 intervals of the source after the start of the outage.
 * - `recovers`: the health comes up in the recovery limit after the end of the outage. The limit is the backoff cap
 *   of `polite-crawler` and two intervals of the source.
 */
import { DEFAULT_COVERAGE_POLICY, type HealthState } from "@mark1russell7/alerts";
import { openRuntime, openRuntimeLog, type RuntimeOptions } from "@mark1russell7/alerts-runtime";
import { CANARY_PATH, createNwsSource, NWS_DESCRIPTOR, SOURCE_ID } from "@mark1russell7/alerts-source-nws-api";
import { type Fault, faultPlanOf } from "@mark1russell7/rigor-chaos";
import { random } from "@mark1russell7/rigor-generators";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { fetchTransport, type Reply, type Transport } from "polite-crawler/api";
import { DEFAULT_POLICY, HostScheduler, type Clock as PoliteClock, type PolitenessPolicy } from "polite-crawler/politeness";
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
  /** The count of connections in the plan of the proxy. Each connection of the outage gets a fault, up to this count. */
  readonly connections: number;
}

/**
 * The settings of the case in CI, as the prediction states. The outage starts between two fetches. Each arm is long
 * enough to show the end of a stop of the host for failures, 60 minutes in `DEFAULT_POLICY`.
 */
export const CASE_5_SETTINGS: DownSettings = { speed: 60, armMs: 80 * MINUTE, outageAtMs: 4.5 * MINUTE, shortMs: 3 * MINUTE, longMs: 10 * MINUTE, connections: 64 };

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
export function downLimits(policy: PolitenessPolicy = DEFAULT_POLICY, intervalMs: number = NWS_DESCRIPTOR.interval): DownLimits {
  return { intervalMs, detectMs: 3 * intervalMs, recoverMs: policy.backoffCapMs + 2 * intervalMs, stopAfter: policy.maxFailures };
}

/** The outage window of an arm, after the start of the arm. The window has its start and does not have its end. */
export interface Window {
  readonly from: number;
  readonly to: number;
}

/** This function gives the outage window of an arm, or `undefined` for `control`. */
export function outageOf(arm: DownArm, settings: DownSettings = CASE_5_SETTINGS): Window | undefined {
  if (arm === "control") return undefined;
  const from = settings.outageAtMs;
  return { from, to: from + (arm === "reset-short" ? settings.shortMs : settings.longMs) };
}

/** This function gives the faults of an arm: one fault at the start of each connection, up to `connections`. */
export function faultsOf(arm: DownArm, settings: DownSettings = CASE_5_SETTINGS): Fault[] {
  if (arm === "control") return [];
  return Array.from({ length: settings.connections }, (_, connection): Fault => {
    if (arm === "reset-short" || arm === "reset-long") return { connection, direction: "up", at: { byte: 0 }, kind: "reset" };
    return { connection, direction: "up", at: { frame: 0 }, kind: "answer", status: arm === "error-long" ? 500 : 503 };
  });
}

/** The clock of the case. The runtime reads `now` and `after`. The scheduler of `polite-crawler` reads `now` and `sleep`. */
export type CaseClock = RuntimeOptions["clock"] & PoliteClock;

/**
 * This function gives a clock that moves `speed` times faster than real time, from the time `start` since the epoch. Each
 * timer ends after `ms / speed` real milliseconds. The clock is local until `@mark1russell7/algebra/clock` has a fast clock.
 */
export function fastClock(start: number, speed: number): CaseClock {
  if (!Number.isFinite(speed) || speed < 1) throw new RangeError(`The speed ${String(speed)} is not a finite number of 1 or more.`);
  const origin = performance.now();
  const realMs = (ms: number): number => Math.max(0, ms) / speed;
  return {
    // The time starts at an instant (`Date.now()` in the case), thus this clock is a wall clock.
    time: "wall",
    now: () => start + Math.floor((performance.now() - origin) * speed),
    after: (ms, run) => {
      const timer = setTimeout(run, realMs(ms));
      return Object.assign(() => clearTimeout(timer), { unref: () => void timer.unref() });
    },
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted === true) return resolve();
        const stop = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", stop);
          resolve();
        }, realMs(ms));
        signal?.addEventListener("abort", stop, { once: true });
      }),
  };
}

/** The count of the requests of an arm on each route. */
export interface RouteCounts {
  /** The requests to the server, out of the outage window. */
  direct: number;
  /** The requests to the fault proxy, in the outage window. */
  faulty: number;
  /** The canary requests that the transport answered, out of the outage window. */
  canary: number;
}

/** The options of the transport of the case. */
export interface OutageTransportOptions {
  /** The transport that sends each request to a server. */
  readonly inner: Transport;
  readonly clock: { readonly now: () => number };
  /** The outage window, in the time of the clock. With no window, the source has no outage. */
  readonly outage?: Window;
  /** The origin of the server, out of the outage window. */
  readonly direct: string;
  /** The origin of the fault proxy, in the outage window. */
  readonly faulty: string;
  /** This function gives the canary answer at a time of the clock. */
  readonly canary: (at: number) => Reply;
  readonly counts: RouteCounts;
}

/**
 * This function gives the transport of the case. It refuses each origin other than `CASE_5_ORIGIN`. In the outage window,
 * it sends each request to the fault proxy. Out of the window, it answers the canary query with a recent keepalive, and
 * it sends each other request to the server.
 */
export function outageTransport(options: OutageTransportOptions): Transport {
  const { inner, clock, outage, counts } = options;
  return (exchange, signal) => {
    const url = new URL(exchange.url);
    if (url.origin !== CASE_5_ORIGIN) return Promise.reject(new TypeError(`The address ${exchange.url} is not an address of the case.`));
    const at = clock.now();
    const target = `${url.pathname}${url.search}`;
    if (outage !== undefined && at >= outage.from && at < outage.to) {
      counts.faulty += 1;
      return inner({ ...exchange, url: `${options.faulty}${target}` }, signal);
    }
    if (target === CANARY_PATH) {
      counts.canary += 1;
      return Promise.resolve(options.canary(at));
    }
    counts.direct += 1;
    return inner({ ...exchange, url: `${options.direct}${target}` }, signal);
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

/** The records of one arm. */
export interface DownRecord {
  readonly arm: DownArm;
  readonly outage?: Window;
  readonly passes: readonly DownPass[];
  readonly requests: Readonly<RouteCounts>;
  /** The count of the faults that the proxy recorded. */
  readonly faults: number;
  /** The count of the requests that the server behind the proxy read. When each fault falls at its point, the count is 0. */
  readonly leaked: number;
  /** The message of a throw of a pass. */
  readonly error?: string;
}

/** This function starts one arm: a server, a proxy behind its own server, a new runtime and its passes on a new clock. */
export async function runDownArm(arm: DownArm, settings: DownSettings = CASE_5_SETTINGS, bodies: CaseBodies = caseBodies()): Promise<DownRecord> {
  const outage = outageOf(arm, settings);
  const server = await startNwsServer(bodies, "length");
  const behind = outage === undefined ? undefined : await startNwsServer(bodies, "length");
  const proxy =
    behind === undefined ? undefined : await startFaultProxy({ target: { host: behind.host, port: behind.port }, plan: faultPlanOf(faultsOf(arm, settings)), protocol: "http" });
  const start = Date.now();
  const clock = fastClock(start, settings.speed);
  const counts: RouteCounts = { direct: 0, faulty: 0, canary: 0 };
  const transport = outageTransport({
    inner: fetchTransport({ userAgent: USER_AGENT }),
    clock,
    ...(outage === undefined ? {} : { outage: { from: start + outage.from, to: start + outage.to } }),
    direct: `http://${server.host}:${String(server.port)}`,
    faulty: proxy === undefined ? CASE_5_ORIGIN : `http://${proxy.host}:${String(proxy.port)}`,
    canary: canaryAnswer(bodies),
    counts,
  });
  const jitter = random(`${CASE_5_ID}-${arm}`);
  // The pace of production: one request at a time to the host, the default policy and the default limits of the source.
  const source = createNwsSource({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now, random: () => jitter.next() }, transport, userAgent: USER_AGENT, baseUrl: CASE_5_ORIGIN });
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
  await proxy?.close();
  const leaked = behind?.requests.length ?? 0;
  await behind?.close();
  await server.close();
  return {
    arm,
    ...(outage === undefined ? {} : { outage }),
    passes,
    requests: { ...counts },
    faults: proxy?.records.length ?? 0,
    leaked,
    ...(error === undefined ? {} : { error }),
  };
}

/** The gates of an arm with an outage. */
export interface DownGates {
  readonly detected: boolean;
  readonly recovers: boolean;
}

/** The gates of an arm, and the times that decide them. */
export interface DownResult {
  readonly gates: DownGates;
  /** The time from the start of the outage to the first pass with the health down. */
  readonly detectedAfterMs?: number;
  /** The time from the end of the outage to the first pass with the health up. */
  readonly recoveredAfterMs?: number;
  readonly problems: readonly string[];
}

const isUp = (state: HealthState): boolean => DEFAULT_COVERAGE_POLICY.up.includes(state);

/** This function gives the gates of an arm with an outage, from the health at each pass. The health is up when the coverage counts it. */
export function downGatesOf(record: DownRecord, limits: DownLimits = downLimits()): DownResult {
  const { outage } = record;
  if (outage === undefined) return { gates: { detected: false, recovers: false }, problems: [`${record.arm}: the arm has no outage.`] };
  const down = record.passes.find((pass) => pass.at >= outage.from && !isUp(pass.state));
  const up = record.passes.find((pass) => pass.at >= outage.to && isUp(pass.state));
  const detectedAfterMs = down === undefined ? undefined : down.at - outage.from;
  const recoveredAfterMs = up === undefined ? undefined : up.at - outage.to;
  const detected = detectedAfterMs !== undefined && detectedAfterMs <= limits.detectMs;
  const recovers = recoveredAfterMs !== undefined && recoveredAfterMs <= limits.recoverMs;
  const minutes = (ms: number | undefined): string => (ms === undefined ? "never in the arm" : `after ${(ms / MINUTE).toFixed(1)} min`);
  const problems = [
    ...(detected ? [] : [`${record.arm}: the health went down ${minutes(detectedAfterMs)}, not in ${String(limits.detectMs / MINUTE)} min of the start of the outage.`]),
    ...(recovers ? [] : [`${record.arm}: the health came up ${minutes(recoveredAfterMs)}, not in ${String(limits.recoverMs / MINUTE)} min of the end of the outage.`]),
  ];
  return {
    gates: { detected, recovers },
    ...(detectedAfterMs === undefined ? {} : { detectedAfterMs }),
    ...(recoveredAfterMs === undefined ? {} : { recoveredAfterMs }),
    problems,
  };
}

/** The verdict of the case. A case with no read does not pass. */
export interface DownVerdict {
  /** True when the settings are valid, the control arm stays up, each fault falls at its point and no pass throws. */
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
  if (settings.connections < 2 * Math.ceil(settings.longMs / intervalMs)) problems.push(`The plan of the proxy has ${String(settings.connections)} connections, fewer than two for each fetch of a long outage.`);
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
    if (record.outage === undefined) {
      if (record.requests.faulty > 0) problems.push(`${record.arm}: ${String(record.requests.faulty)} requests went to the proxy with no outage.`);
      continue;
    }
    if (record.faults === 0) problems.push(`${record.arm}: the proxy has no record of a fault.`);
    if (record.leaked > 0) problems.push(`${record.arm}: ${String(record.leaked)} requests of the outage got to the server behind the proxy.`);
  }
  const read = problems.length === 0;
  const results: Partial<Record<DownArm, DownResult>> = {};
  for (const record of records.filter((one) => one.outage !== undefined)) {
    const result = downGatesOf(record, limits);
    results[record.arm] = result;
    problems.push(...result.problems);
  }
  const pass = read && OUTAGE_ARMS.every((arm) => results[arm]?.gates.detected === true && results[arm].gates.recovers);
  return { read, results, pass, problems };
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
