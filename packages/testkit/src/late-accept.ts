/**
 * AL-13, case 4: a late accept of a channel. The runtime sends a `life-safety` alert through the Pushover channel. A
 * fault proxy of `@mark1russell7/rigor-proxy` stands between the channel and a scripted Pushover API. The proxy stalls
 * connection 0, which carries the first send. The case has four arms:
 *
 * - `prompt`: no fault. This arm is the control of the case.
 * - `late-answer`: the API accepts the message, and its answer comes after the call limit of the delivery step.
 * - `hang-after-accept`: the API accepts the message, and its answer does not come in the arm.
 * - `hang-before-accept`: the request does not get to the API in the arm. Thus a send again is necessary.
 *
 * The gates of each arm, from the ledger of the API and the log of the runtime:
 *
 * - `delivered`: the API accepted a message, the log holds its delivery, and the log holds an acknowledgment.
 * - `single`: for each delivery key, one accepted message has no cancel before the first acknowledgment of the key.
 * - `stopped`: a cancel or an acknowledgment reaches each accepted message. Thus no repeats continue.
 */
import { wallClock } from "@mark1russell7/algebra/clock";
import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import { openRuntime, openRuntimeLog } from "@mark1russell7/alerts-runtime";
import { type Fault, faultPlanOf } from "@mark1russell7/rigor-chaos";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { type PushoverLedger, type PushoverLedgerMessage, pushoverApi, pushoverFetchTo, pushoverLedgerOf } from "@procedures/notify/testing";
import { type CallFailure, deliveryFixture, FIXTURE_PLACE, type LogSummary, logSummaryOf } from "./delivery-fixture.ts";

export type { CallFailure, LogSummary } from "./delivery-fixture.ts";

/** The id of the case. */
export const CASE_4_ID = "al-13-case-4";

/** An arm of the case. */
export type AcceptArm = "prompt" | "late-answer" | "hang-after-accept" | "hang-before-accept";

/** The arms of the case, in the order of a run. */
export const ACCEPT_ARMS: readonly AcceptArm[] = ["prompt", "late-answer", "hang-after-accept", "hang-before-accept"];

/** A gate of an arm. */
export type AcceptGate = "delivered" | "single" | "stopped";

/** The gates of each arm. */
export const ACCEPT_GATES: readonly AcceptGate[] = ["delivered", "single", "stopped"];

/** The settings of the case. Each time is in milliseconds. */
export interface AcceptSettings {
  /** The longest time of one call of a channel in the delivery step (`DeliveryOptions.callLimit`). */
  readonly callLimitMs: number;
  /** The longest time of a send in flight (`DeliveryOptions.flightLimit`). No second send of its key goes before it ends. */
  readonly flightLimitMs: number;
  /** The wait before a failed call goes again (`DeliveryOptions.retry`). */
  readonly retryMs: number;
  /** The time between two reads of one receipt (`DeliveryOptions.pollEvery`). */
  readonly pollEveryMs: number;
  /** The time limit of the Pushover channel on one request (`timeoutMs` of the channel). */
  readonly channelLimitMs: number;
  /** The stall of the answer in the arm `late-answer`. It is longer than the call limit, and shorter than the flight limit and the channel limit. */
  readonly lateMs: number;
  /** The stall of the two arms with a hang. It is longer than the arm. */
  readonly hangMs: number;
  /** The time of one arm, from its first pass. */
  readonly armMs: number;
  /** The longest wait between two passes. */
  readonly tickMs: number;
  /** The count of receipts of the scripted API. */
  readonly receipts: number;
}

/** The settings of the case in CI, as the prediction states. */
export const CASE_4_SETTINGS: AcceptSettings = {
  callLimitMs: 1000,
  flightLimitMs: 3000,
  retryMs: 1500,
  pollEveryMs: 1000,
  channelLimitMs: 4000,
  lateMs: 2500,
  hangMs: 15_000,
  armMs: 10_000,
  tickMs: 200,
  receipts: 12,
};

/** The record of one arm. */
export interface AcceptRecord {
  readonly arm: AcceptArm;
  /** True when the proxy recorded the stall of the arm at byte 0 of connection 0, or no fault for `prompt`. */
  readonly faulted: boolean;
  readonly ledger: PushoverLedger;
  readonly log: LogSummary;
  readonly failures: readonly CallFailure[];
  /** The count of late deliveries that the delivery step found in the log already (`DeliveryStep.duplicates`). */
  readonly duplicates: number;
  readonly passes: number;
  /** The text of the error of a pass that threw. */
  readonly error?: string;
}

/** The verdict of the case. A case with no read does not pass. */
export interface AcceptVerdict {
  /** True when the settings are valid, each arm completed with no error, each fault fell at its point, and `prompt` passed each gate. */
  readonly read: boolean;
  readonly gates: Readonly<Record<AcceptArm, Readonly<Record<AcceptGate, boolean>>>>;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** The records of one run of the case. */
export interface AcceptRun {
  readonly id: string;
  readonly settings: AcceptSettings;
  readonly records: readonly AcceptRecord[];
  readonly verdict: AcceptVerdict;
}

/** The source, the person and the test values of the case. */
const FIXTURE = deliveryFixture("case-4", "casefour");

/** The clock of the case: the instant of the platform. Its timers do not keep the process alive. */
const EPOCH_CLOCK = wallClock({ unref: true });

/** This function gives the fault of an arm on connection 0, or `undefined` for `prompt`. */
export function faultOf(arm: AcceptArm, settings: AcceptSettings): Fault | undefined {
  if (arm === "prompt") return undefined;
  const direction = arm === "hang-before-accept" ? "up" : "down";
  return { connection: 0, direction, at: { byte: 0 }, kind: "stall", ms: arm === "late-answer" ? settings.lateMs : settings.hangMs };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** This function starts one arm: a scripted API, a proxy with the fault of the arm, and the passes of a new runtime. */
export async function runArm(arm: AcceptArm, settings: AcceptSettings = CASE_4_SETTINGS): Promise<AcceptRecord> {
  const server = await startScriptedServer(pushoverApi({ receipts: settings.receipts, tags: "any" }));
  const fault = faultOf(arm, settings);
  const proxy = await startFaultProxy({ target: { host: server.host, port: server.port }, plan: faultPlanOf(fault === undefined ? [] : [fault]), protocol: "http" });
  const base = `http://${proxy.host}:${String(proxy.port)}`;
  // The channel calls the address of the Pushover API. This fetch sends each call to the proxy, with the same path and query.
  const channel = createPushoverChannel({ token: FIXTURE.token, fetch: pushoverFetchTo(base), timeoutMs: settings.channelLimitMs });
  const log = openRuntimeLog(":memory:");
  const clock = EPOCH_CLOCK;
  const failures: CallFailure[] = [];
  let duplicates = 0;
  let passes = 0;
  let error: string | undefined;
  try {
    const runtime = openRuntime({
      log,
      clock,
      sources: [FIXTURE.sourceOf(clock.now())],
      watch: () => ({ places: [FIXTURE_PLACE], kinds: ["met"] }),
      view: FIXTURE.view,
      run: `${CASE_4_ID}-${arm}`,
      delivery: {
        recipients: [FIXTURE.recipient],
        channels: [channel],
        pollEvery: settings.pollEveryMs,
        retry: settings.retryMs,
        callLimit: settings.callLimitMs,
        flightLimit: settings.flightLimitMs,
      },
    });
    const end = clock.now() + settings.armMs;
    while (clock.now() < end) {
      const pass = await runtime.pass();
      passes += 1;
      for (const failure of pass.delivery?.failures ?? []) failures.push({ call: failure.call, kind: failure.kind, message: failure.message });
      duplicates += pass.delivery?.duplicates.length ?? 0;
      const next = Math.min(pass.wakeAt ?? Number.POSITIVE_INFINITY, clock.now() + settings.tickMs, end);
      await sleep(Math.max(0, next - clock.now()));
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const ledger = pushoverLedgerOf([...server.requests]);
  const summary: LogSummary = logSummaryOf(log);
  log.close();
  await proxy.close();
  await server.close();
  const faulted =
    fault === undefined
      ? proxy.records.length === 0
      : proxy.records.some((r) => r.kind === "stall" && r.connection === 0 && r.direction === fault.direction && r.byte === 0);
  return { arm, faulted, ledger, log: summary, failures, duplicates, passes, ...(error === undefined ? {} : { error }) };
}

/** This function starts the case: each arm, in order. It gives the records and the verdict. */
export async function runLateAccept(given: Partial<AcceptSettings> = {}): Promise<AcceptRun> {
  const settings: AcceptSettings = { ...CASE_4_SETTINGS, ...given };
  const records: AcceptRecord[] = [];
  for (const arm of ACCEPT_ARMS) records.push(await runArm(arm, settings));
  return { id: CASE_4_ID, settings, records, verdict: acceptVerdictOf(records, settings) };
}

/** The first tag of a message, or a text for a message with no tag. A `life-safety` message has the delivery key as its first tag. */
const tagOf = (message: PushoverLedgerMessage): string => message.tags[0] ?? "(no tag)";

/** The parts of the record of an arm that `acceptGatesOf` reads. The records of case 4 and case 7 have them. */
export interface DeliveryEvidence {
  readonly arm: string;
  readonly ledger: PushoverLedger;
  readonly log: LogSummary;
}

/**
 * This function gives the gates of one record, and a problem for each gate that fails.
 *
 * A message counts for `single` when no cancel reached it before the first acknowledgment of its key. With no
 * acknowledgment, each message with no cancel counts.
 */
export function acceptGatesOf(record: DeliveryEvidence): { readonly gates: Readonly<Record<AcceptGate, boolean>>; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const { messages } = record.ledger;
  const receipts = new Set(messages.map((message) => message.receipt));
  const delivered =
    messages.length > 0 &&
    record.log.deliveries.length > 0 &&
    record.log.deliveries.every((delivery) => delivery.receipt !== undefined && receipts.has(delivery.receipt)) &&
    record.log.acknowledgments > 0;
  if (!delivered) {
    problems.push(
      `${record.arm}: not delivered. The API accepted ${String(messages.length)} messages, the log has ${String(record.log.deliveries.length)} deliveries and ${String(record.log.acknowledgments)} acknowledgments.`,
    );
  }
  const keys = [...new Set(messages.map(tagOf))];
  const counts = keys.map((key) => {
    const of = messages.filter((message) => tagOf(message) === key);
    const reads = of.flatMap((message) => (message.readAt === undefined ? [] : [message.readAt]));
    const firstRead = reads.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...reads);
    return { key, count: of.filter((message) => message.cancelledAt === undefined || message.cancelledAt > firstRead).length };
  });
  const single = counts.length > 0 && counts.every((entry) => entry.count === 1);
  for (const entry of counts.filter((c) => c.count !== 1)) {
    problems.push(`${record.arm}: the key ${entry.key.slice(0, 12)} has ${String(entry.count)} messages with no cancel before its acknowledgment, not 1.`);
  }
  const open = messages.filter((message) => message.readAt === undefined && message.cancelledAt === undefined);
  const stopped = open.length === 0;
  for (const message of open) {
    problems.push(`${record.arm}: the message ${message.receipt} (send ${String(message.position)}, connection ${String(message.connection)}) has no cancel and no acknowledgment. Its repeats continue.`);
  }
  return { gates: { delivered, single, stopped }, problems };
}

/** This function gives the verdict of the records of a run. */
export function acceptVerdictOf(records: readonly AcceptRecord[], settings: AcceptSettings = CASE_4_SETTINGS): AcceptVerdict {
  const problems: string[] = [];
  const shortest = Math.min(settings.flightLimitMs, settings.channelLimitMs);
  if (!(settings.callLimitMs < settings.lateMs && settings.lateMs < shortest)) {
    problems.push(
      `The late answer (${String(settings.lateMs)} ms) is not between the call limit (${String(settings.callLimitMs)} ms) and the shorter of the flight limit and the channel limit (${String(shortest)} ms).`,
    );
  }
  if (settings.hangMs <= settings.armMs) problems.push(`The hang (${String(settings.hangMs)} ms) is not longer than the arm (${String(settings.armMs)} ms).`);
  const need = Math.max(settings.flightLimitMs, settings.channelLimitMs) + settings.retryMs + 2 * settings.pollEveryMs;
  if (settings.armMs < need) problems.push(`The arm (${String(settings.armMs)} ms) is shorter than the longer limit, a retry and two reads (${String(need)} ms).`);
  const gates = {} as Record<AcceptArm, Readonly<Record<AcceptGate, boolean>>>;
  const failed: string[] = [];
  for (const arm of ACCEPT_ARMS) {
    const of = records.filter((record) => record.arm === arm);
    const record = of[0];
    if (of.length !== 1 || record === undefined) {
      problems.push(`${arm}: ${String(of.length)} records, not 1.`);
      gates[arm] = { delivered: false, single: false, stopped: false };
      continue;
    }
    if (record.error !== undefined) problems.push(`${arm}: a pass threw: ${record.error}`);
    if (!record.faulted) problems.push(arm === "prompt" ? "prompt: the proxy recorded a fault." : `${arm}: the proxy has no record of the stall at byte 0 of connection 0.`);
    if (record.ledger.counts.sends >= settings.receipts) problems.push(`${arm}: ${String(record.ledger.counts.sends)} sends used each receipt of the scripted API.`);
    if ((arm === "late-answer" || arm === "hang-after-accept") && record.ledger.messages[0]?.connection !== 0) {
      problems.push(`${arm}: the first send that the API read did not come on connection 0, thus the stall did not hit it.`);
    }
    const result = acceptGatesOf(record);
    gates[arm] = result.gates;
    // The control arm passes each gate, or the case cannot read.
    if (arm === "prompt") problems.push(...result.problems.map((problem) => `${problem} The control arm fails, thus the case cannot read.`));
    else failed.push(...result.problems);
  }
  const read = problems.length === 0;
  const pass = read && ACCEPT_ARMS.every((arm) => ACCEPT_GATES.every((gate) => gates[arm][gate]));
  return { read, gates, pass, problems: [...problems, ...failed] };
}
