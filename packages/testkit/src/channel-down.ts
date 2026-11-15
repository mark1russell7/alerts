/**
 * AL-13, case 7: a channel down. The Pushover API does not take a message for a time, and then it takes messages again.
 *
 * Each arm has one source with one tornado warning, one person with a `life-safety` policy on Pushover, and the delivery
 * times of an instance (`DELIVERY_TIMES`). Each Pushover request goes through a fault proxy of `@mark1russell7/rigor-proxy`
 * to a scripted Pushover API. The runtime pings a fake check of Healthchecks.io after each pass, with the heartbeat
 * hook of an instance. The case clock moves `speed` times faster than real time, and the clock of the proxy has its
 * speed and its start.
 *
 * The plan of an arm with an outage has one fault of a window, from the start of the arm. The case has five arms:
 *
 * - `control`: no outage. Its plan has no fault.
 * - `reset`: the proxy resets each connection.
 * - `error`: the proxy gives HTTP 500 to each request.
 * - `unavailable`: the proxy gives HTTP 503 to each request.
 * - `limited`: the proxy gives HTTP 429 to each request. The channel tells a refusal of the kind `rate-limited`.
 *
 * The gates of each arm:
 *
 * - `delivered`, `single` and `stopped`: the gates of case 4, from the ledger of the API and the log of the runtime.
 * - `recovered`: the first delivery comes in two retries and one tick after the end of the outage.
 * - `told`: a fail ping goes to the check during the outage. The control arm has no fail ping.
 * - `cleared`: the last ping of the arm is a success ping.
 */
import { platformClock, wallClock } from "@mark1russell7/algebra/clock";
import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import { DELIVERY_TIMES, HEARTBEAT_EVERY, heartbeat, heldOf, openRuntime, openRuntimeLog, type Runtime } from "@mark1russell7/alerts-runtime";
import { type FaultPlan, type FaultWindow, faultPlanOf, type WindowFault } from "@mark1russell7/rigor-chaos";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { type PushoverLedger, pushoverApi, pushoverFetchTo, pushoverLedgerOf } from "@procedures/notify/testing";
import { type CallFailure, deliveryFixture, FIXTURE_PLACE, type LogSummary, logSummaryOf } from "./delivery-fixture.ts";
import { acceptGatesOf } from "./late-accept.ts";
import { caseClock, type RequestCounts } from "./source-down.ts";

/** The id of the case. */
export const CASE_7_ID = "al-13-case-7";
const MINUTE = 60_000;
const USER_AGENT = "alerts-testkit/0 (fault suite)";
/** The ping URL of the fake check. No request goes to this host: the fetch of the heartbeat records each ping. */
const PING_URL = "https://hc-ping.test/al-13-case-7";

/** An arm of the case: the control, or an outage of a kind. */
export type ChannelArm = "control" | "reset" | "error" | "unavailable" | "limited";

/** The arms of the case. The run starts them at the same time, each with its own server, proxy and clock. */
export const CHANNEL_ARMS: readonly ChannelArm[] = ["control", "reset", "error", "unavailable", "limited"];

/** The arms with an outage. */
export const CHANNEL_OUTAGE_ARMS: readonly ChannelArm[] = CHANNEL_ARMS.filter((arm) => arm !== "control");

/** The gates of each arm. */
export const CHANNEL_GATES = ["delivered", "single", "stopped", "recovered", "told", "cleared"] as const;

/** A gate of an arm. */
export type ChannelGate = (typeof CHANNEL_GATES)[number];

/** The settings of the case. Each time is in milliseconds of the case clock. */
export interface ChannelSettings {
  /** The milliseconds of the case clock in one real millisecond. */
  readonly speed: number;
  /** The time of each arm. */
  readonly armMs: number;
  /** The time of the outage. It starts at the start of the arm. */
  readonly outageMs: number;
  /** The longest wait between two passes. */
  readonly tickMs: number;
  /** The count of receipts of the scripted API. */
  readonly receipts: number;
}

/** The settings of the case in CI, as the prediction states. */
export const CASE_7_SETTINGS: ChannelSettings = { speed: 10, armMs: 14 * MINUTE, outageMs: 10 * MINUTE, tickMs: 5_000, receipts: 12 };

/**
 * This function gives the longest time from the end of an outage to the first delivery: two retries and one tick. The
 * first send after the outage comes in one retry. The second retry is for a connection that the outage closed.
 */
export function recoverLimit(settings: ChannelSettings = CASE_7_SETTINGS): number {
  return 2 * DELIVERY_TIMES.retry + settings.tickMs;
}

/** This function gives the outage window of an arm, or `undefined` for `control`. */
export function channelOutageOf(arm: ChannelArm, settings: ChannelSettings = CASE_7_SETTINGS): FaultWindow | undefined {
  return arm === "control" ? undefined : { from: 0, to: settings.outageMs };
}

/** This function gives the fault of the outage window of an arm, or `undefined` for `control`. */
export function channelFaultOf(arm: ChannelArm, settings: ChannelSettings = CASE_7_SETTINGS): WindowFault | undefined {
  const window = channelOutageOf(arm, settings);
  if (window === undefined) return undefined;
  if (arm === "reset") return { window, direction: "up", at: { byte: 0 }, kind: "reset" };
  const status = arm === "error" ? 500 : arm === "unavailable" ? 503 : 429;
  return { window, direction: "up", at: { frame: 0 }, kind: "answer", status };
}

/** This function gives the fault plan of an arm: no fault for `control`, and one fault of a window for each other arm. */
export function channelPlanOf(arm: ChannelArm, settings: ChannelSettings = CASE_7_SETTINGS): FaultPlan {
  const fault = channelFaultOf(arm, settings);
  return faultPlanOf([], fault === undefined ? [] : [fault]);
}

/** One ping of the heartbeat, at its time after the start of the arm. */
export interface PingRecord {
  readonly at: number;
  readonly kind: "success" | "fail";
}

/** A failed call of a pass, at the time of the pass after the start of the arm. */
export type TimedFailure = CallFailure & { readonly at: number };

/** The records of one arm. Each time is after the start of the arm. */
export interface ChannelRecord {
  readonly arm: ChannelArm;
  readonly outage?: FaultWindow;
  readonly ledger: PushoverLedger;
  /** The log of the runtime. The time of each delivery is after the start of the arm. */
  readonly log: LogSummary;
  readonly failures: readonly TimedFailure[];
  readonly pings: readonly PingRecord[];
  /** The errors that the heartbeat gave. */
  readonly pingErrors: readonly string[];
  /** The Pushover requests of the channel. Each request goes to the fault proxy. */
  readonly requests: RequestCounts;
  /** The count of the faults that the proxy recorded. */
  readonly faults: number;
  readonly passes: number;
  /** The time of the last pass. */
  readonly lastPassAt?: number;
  /** The message of a throw of a pass. */
  readonly error?: string;
}

/** The source, the person and the test values of the case. */
const FIXTURE = deliveryFixture("case-7", "caseseven");

/** This function starts one arm: a scripted API, a fault proxy, a runtime with a heartbeat, and its passes on a new clock. */
export async function runChannelArm(arm: ChannelArm, settings: ChannelSettings = CASE_7_SETTINGS): Promise<ChannelRecord> {
  const outage = channelOutageOf(arm, settings);
  const server = await startScriptedServer(pushoverApi({ receipts: settings.receipts, tags: "any" }));
  const start = Date.now();
  const clock = caseClock(start, settings.speed);
  // The proxy takes a monotonic clock with the speed and the start of the case clock. Thus the window of the plan is in the time of the arm.
  const proxy = await startFaultProxy({ target: { host: server.host, port: server.port }, plan: channelPlanOf(arm, settings), protocol: "http", clock: platformClock({ speed: settings.speed, start }), origin: start });
  const sent: number[] = [];
  const toProxy = pushoverFetchTo(`http://${proxy.host}:${String(proxy.port)}`);
  const fetch: typeof toProxy = (url, init) => {
    sent.push(clock.now() - start);
    return toProxy(url, init);
  };
  const channel = createPushoverChannel({ token: FIXTURE.token, fetch, now: clock.now });
  const log = openRuntimeLog(":memory:");
  const pings: PingRecord[] = [];
  const pingErrors: string[] = [];
  const failures: TimedFailure[] = [];
  let passes = 0;
  let lastPassAt: number | undefined;
  let error: string | undefined;
  try {
    // The hook of an instance: `heldOf` gives the refused channels of the log at the first pass.
    const beat = heartbeat({
      url: PING_URL,
      fetch: async (url) => {
        pings.push({ at: clock.now() - start, kind: url.endsWith("/fail") ? "fail" : "success" });
        return { status: 200 };
      },
      clock: wallClock({ start, speed: settings.speed, unref: true }),
      userAgent: USER_AGENT,
      held: (at) => heldOf(runtime.state(), at),
      onError: (message) => pingErrors.push(message),
    });
    const runtime: Runtime = openRuntime({
      log,
      clock,
      sources: [FIXTURE.sourceOf(clock.now())],
      watch: () => ({ places: [FIXTURE_PLACE], kinds: ["met"] }),
      view: FIXTURE.view,
      run: `${CASE_7_ID}-${arm}`,
      delivery: { recipients: [FIXTURE.recipient], channels: [channel], ...DELIVERY_TIMES },
      onPass: (pass) => beat(pass),
    });
    const end = start + settings.armMs;
    while (clock.now() < end) {
      const pass = await runtime.pass();
      passes += 1;
      lastPassAt = pass.at - start;
      for (const failure of pass.delivery?.failures ?? []) failures.push({ at: pass.at - start, call: failure.call, kind: failure.kind, message: failure.message });
      const next = Math.min(pass.wakeAt ?? Number.POSITIVE_INFINITY, clock.now() + settings.tickMs, end);
      await clock.sleep(next - clock.now());
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const summary = logSummaryOf(log);
  log.close();
  await proxy.close();
  const ledger = pushoverLedgerOf([...server.requests]);
  const reached = server.requests.length;
  await server.close();
  const inWindow = outage === undefined ? 0 : sent.filter((at) => at >= outage.from && at < outage.to).length;
  return {
    arm,
    ...(outage === undefined ? {} : { outage }),
    ledger,
    log: { ...summary, deliveries: summary.deliveries.map((delivery) => ({ ...delivery, at: delivery.at - start })) },
    failures,
    pings,
    pingErrors,
    requests: { sent: sent.length, inWindow, reached },
    faults: proxy.records.length,
    passes,
    ...(lastPassAt === undefined ? {} : { lastPassAt }),
    ...(error === undefined ? {} : { error }),
  };
}

/** This function gives the gates of one record, and a problem for each gate that fails. */
export function channelGatesOf(record: ChannelRecord, settings: ChannelSettings = CASE_7_SETTINGS): { readonly gates: Readonly<Record<ChannelGate, boolean>>; readonly problems: readonly string[] } {
  const accept = acceptGatesOf(record);
  const problems = [...accept.problems];
  const { outage } = record;
  const due = (outage?.to ?? 0) + recoverLimit(settings);
  const first = Math.min(...record.log.deliveries.map((delivery) => delivery.at));
  const recovered = first <= due;
  if (!recovered) problems.push(`${record.arm}: the first delivery is at ${Number.isFinite(first) ? `${String(first)} ms` : "no time"}, after the limit of ${String(due)} ms.`);
  const fails = record.pings.filter((ping) => ping.kind === "fail");
  const told = outage === undefined ? fails.length === 0 : fails.some((ping) => ping.at >= outage.from && ping.at < outage.to);
  if (!told) {
    problems.push(
      outage === undefined
        ? `${record.arm}: the heartbeat gave ${String(fails.length)} fail pings with no outage.`
        : `${record.arm}: the heartbeat gave no fail ping in the outage (${String(record.pings.length)} pings, ${String(record.failures.filter((failure) => failure.call === "send").length)} failed sends).`,
    );
  }
  const cleared = record.pings.at(-1)?.kind === "success";
  if (!cleared) problems.push(`${record.arm}: the last ping of the arm is not a success ping.`);
  return { gates: { ...accept.gates, recovered, told, cleared }, problems };
}

/** This function gives the problems of the settings. With a problem, the case cannot read. */
export function channelSettingsProblems(settings: ChannelSettings): string[] {
  const problems: string[] = [];
  if (settings.outageMs < 2 * HEARTBEAT_EVERY) problems.push(`The outage (${String(settings.outageMs)} ms) is shorter than two times of the heartbeat.`);
  const last = settings.outageMs + recoverLimit(settings) + DELIVERY_TIMES.pollEvery + 2 * settings.tickMs;
  if (settings.armMs < last) problems.push(`The arm (${String(settings.armMs)} ms) ends before the poll of a delivery at the recovery limit (${String(last)} ms).`);
  return problems;
}

/** The verdict of the case. A case with no read does not pass. */
export interface ChannelVerdict {
  /** True when the settings are valid, each arm completed with no error, each fault fell in its window and the heartbeat pinged. */
  readonly read: boolean;
  readonly gates: Readonly<Partial<Record<ChannelArm, Readonly<Record<ChannelGate, boolean>>>>>;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** This function gives the verdict of the records of a run. */
export function channelVerdictOf(records: readonly ChannelRecord[], settings: ChannelSettings = CASE_7_SETTINGS): ChannelVerdict {
  const problems = channelSettingsProblems(settings);
  for (const arm of CHANNEL_ARMS) {
    const count = records.filter((record) => record.arm === arm).length;
    if (count !== 1) problems.push(`${arm}: ${String(count)} records, not 1.`);
  }
  for (const record of records) {
    const { arm, outage } = record;
    if (record.error !== undefined) problems.push(`${arm}: a pass threw: ${record.error}`);
    if (record.lastPassAt === undefined || record.lastPassAt < settings.armMs - 2 * settings.tickMs) problems.push(`${arm}: the passes end before the end of the arm.`);
    if (record.pings.length === 0) problems.push(`${arm}: the heartbeat gave no ping.`);
    for (const message of record.pingErrors) problems.push(`${arm}: a ping failed: ${message}`);
    const { sent, inWindow, reached } = record.requests;
    if (outage === undefined && record.faults > 0) problems.push(`${arm}: the proxy recorded ${String(record.faults)} faults with no outage.`);
    if (outage !== undefined && record.faults === 0) problems.push(`${arm}: the proxy has no record of a fault.`);
    if (outage !== undefined && inWindow === 0) problems.push(`${arm}: the channel sent no request in the outage window.`);
    if (outage !== undefined && record.log.deliveries.some((delivery) => delivery.at < outage.to)) problems.push(`${arm}: a delivery came before the end of the outage.`);
    // Each fault stops one request before the server. Thus each request gets to the server or has one fault.
    if (reached + record.faults !== sent) {
      problems.push(`${arm}: the channel sent ${String(sent)} requests, but ${String(reached)} got to the server and ${String(record.faults)} stopped at the proxy.`);
    }
  }
  const read = problems.length === 0;
  const gates: Partial<Record<ChannelArm, Readonly<Record<ChannelGate, boolean>>>> = {};
  for (const record of records) {
    const result = channelGatesOf(record, settings);
    gates[record.arm] = result.gates;
    problems.push(...result.problems);
  }
  const pass = read && CHANNEL_ARMS.every((arm) => CHANNEL_GATES.every((gate) => gates[arm]?.[gate] === true));
  return { read, gates, pass, problems };
}

/** The records of one run of the case. */
export interface ChannelRun {
  readonly id: string;
  readonly settings: ChannelSettings;
  /** The delivery times of an instance, as the arms use them. */
  readonly times: typeof DELIVERY_TIMES;
  readonly records: readonly ChannelRecord[];
  readonly verdict: ChannelVerdict;
}

/** This function starts the case: each arm at the same time. It gives the records and the verdict. */
export async function runChannelDown(given: Partial<ChannelSettings> = {}): Promise<ChannelRun> {
  const settings: ChannelSettings = { ...CASE_7_SETTINGS, ...given };
  const records = await Promise.all(CHANNEL_ARMS.map((arm) => runChannelArm(arm, settings)));
  return { id: CASE_7_ID, settings, times: DELIVERY_TIMES, records, verdict: channelVerdictOf(records, settings) };
}
