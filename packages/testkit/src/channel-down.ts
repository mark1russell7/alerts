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
 * - `paced`: the requests in progress at one time are not more than the `maxInFlight` of the channel.
 * - `probed`: in an arm that held a stop in the outage, the first stop after the outage starts in `PROBE_LIMIT`.
 */
import { platformClock, wallClock } from "@mark1russell7/algebra/clock";
import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import { DELIVERY_TIMES, HEARTBEAT_EVERY, heartbeat, heldOf, openRuntime, openRuntimeLog, PROBE_LIMIT, type Runtime } from "@mark1russell7/alerts-runtime";
import { type FaultPlan, type FaultWindow, faultPlanOf, type WindowFault } from "@mark1russell7/rigor-chaos";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { type PushoverLedger, pushoverApi, pushoverFetchTo, pushoverLedgerOf } from "@procedures/notify/testing";
import { type CallFailure, deliveryFixture, FIXTURE_PLACE, type LogSummary, logSummaryOf } from "./delivery-fixture.ts";
import { acceptGatesOf } from "./late-accept.ts";
import { caseClock, caseDeliveryTimes, type RequestCounts } from "./source-down.ts";

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

/**
 * The arms whose outage stops the stop requests of the copies. Each one holds a stop in its outage. In run 2 of the case, the `limited` arm
 * sent no stop in its outage, because a send that got HTTP 429 made no copy.
 */
export const CHANNEL_PROBE_ARMS: readonly ChannelArm[] = ["reset", "error", "unavailable"];

/** The gates of each arm. */
export const CHANNEL_GATES = ["delivered", "single", "stopped", "recovered", "told", "cleared", "paced", "probed"] as const;

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

/** One Pushover request of the channel. Each time is after the start of the arm. */
export interface TimedRequest {
  /** The path of the address of the Pushover API, for example `/1/messages.json`. */
  readonly path: string;
  readonly start: number;
  /** The time when the answer came or the request failed. */
  readonly end: number;
  /** The status of the answer. A request that failed has no status. */
  readonly status?: number;
}

/**
 * The start of the path of a stop of the copies of a send: a cancel by tag. The ledger of `@procedures/notify/testing`
 * has the same rule, but it does not export it.
 */
export const STOP_PATH = "/1/receipts/cancel_by_tag/";

/** The stops of an arm with an outage. */
export interface StopProbe {
  /** The count of the stops that started in the outage. */
  readonly held: number;
  /** The time from the end of the outage to the start of the first stop after it. No stop after the outage gives `undefined`. */
  readonly after?: number;
}

/** This function gives the stops of an arm with an outage. An arm with no outage holds no stop. */
export function stopProbeOf(record: Pick<ChannelRecord, "outage" | "exchanges">): StopProbe {
  const { outage } = record;
  if (outage === undefined) return { held: 0 };
  const stops = record.exchanges.filter((exchange) => exchange.path.startsWith(STOP_PATH));
  const held = stops.filter((stop) => stop.start >= outage.from && stop.start < outage.to).length;
  const first = Math.min(...stops.filter((stop) => stop.start >= outage.to).map((stop) => stop.start));
  return Number.isFinite(first) ? { held, after: first - outage.to } : { held };
}

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
  /** Each Pushover request of the channel, in the order of its start. */
  readonly exchanges: readonly TimedRequest[];
  /** The most Pushover requests in progress at one time. */
  readonly inFlight: number;
  /** The `maxInFlight` of the descriptor of the channel. */
  readonly maxInFlight?: number;
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
  const exchanges: TimedRequest[] = [];
  let open = 0;
  let inFlight = 0;
  const toProxy = pushoverFetchTo(`http://${proxy.host}:${String(proxy.port)}`);
  // A counter at the start and at the end of each request gives the most requests in progress, with no error of the clock.
  const fetch: typeof toProxy = async (url, init) => {
    const begin = clock.now() - start;
    sent.push(begin);
    open += 1;
    inFlight = Math.max(inFlight, open);
    let status: number | undefined;
    try {
      const reply = await toProxy(url, init);
      status = reply.status;
      return reply;
    } finally {
      open -= 1;
      exchanges.push({ path: new URL(url).pathname, start: begin, end: clock.now() - start, ...(status === undefined ? {} : { status }) });
    }
  };
  const channel = createPushoverChannel({ token: FIXTURE.token, fetch, now: clock.now });
  const { maxInFlight } = channel.describe();
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
      delivery: { recipients: [FIXTURE.recipient], channels: [channel], ...caseDeliveryTimes(settings.speed) },
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
    exchanges: exchanges.sort((a, b) => a.start - b.start),
    inFlight,
    ...(maxInFlight === undefined ? {} : { maxInFlight }),
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
  const paced = record.maxInFlight !== undefined && record.inFlight <= record.maxInFlight;
  if (!paced) {
    problems.push(
      record.maxInFlight === undefined
        ? `${record.arm}: the channel has no maxInFlight.`
        : `${record.arm}: ${String(record.inFlight)} requests were in progress at one time, more than ${String(record.maxInFlight)}.`,
    );
  }
  const probe = stopProbeOf(record);
  const probed = probe.held === 0 || (probe.after !== undefined && probe.after <= PROBE_LIMIT);
  if (!probed) {
    problems.push(
      probe.after === undefined
        ? `${record.arm}: the outage held ${String(probe.held)} stops, and no stop came after it.`
        : `${record.arm}: the first stop came ${String(probe.after)} ms after the outage, after the limit of ${String(PROBE_LIMIT)} ms.`,
    );
  }
  return { gates: { ...accept.gates, recovered, told, cleared, paced, probed }, problems };
}

/** This function gives the problems of the settings. With a problem, the case cannot read. */
export function channelSettingsProblems(settings: ChannelSettings): string[] {
  const problems: string[] = [];
  if (settings.outageMs < 2 * HEARTBEAT_EVERY) problems.push(`The outage (${String(settings.outageMs)} ms) is shorter than two times of the heartbeat.`);
  const last = settings.outageMs + recoverLimit(settings) + DELIVERY_TIMES.pollEvery + 2 * settings.tickMs;
  if (settings.armMs < last) problems.push(`The arm (${String(settings.armMs)} ms) ends before the poll of a delivery at the recovery limit (${String(last)} ms).`);
  // The runtime takes `PROBE_LIMIT` or the retry, the longer one. The gate `probed` uses `PROBE_LIMIT`.
  if (DELIVERY_TIMES.retry > PROBE_LIMIT) problems.push(`The retry (${String(DELIVERY_TIMES.retry)} ms) is longer than PROBE_LIMIT (${String(PROBE_LIMIT)} ms).`);
  if (settings.armMs < settings.outageMs + PROBE_LIMIT + 2 * settings.tickMs) problems.push(`The arm (${String(settings.armMs)} ms) ends before the first stop after the outage.`);
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
    if (record.exchanges.length !== sent) problems.push(`${arm}: the channel sent ${String(sent)} requests, but ${String(record.exchanges.length)} have a time.`);
    if (CHANNEL_PROBE_ARMS.includes(arm) && stopProbeOf(record).held === 0) problems.push(`${arm}: the outage held no stop, thus the gate probed has no read.`);
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
  return { id: CASE_7_ID, settings, times: caseDeliveryTimes(settings.speed), records, verdict: channelVerdictOf(records, settings) };
}
