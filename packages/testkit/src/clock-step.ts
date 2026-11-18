/**
 * AL-13, case 11: a step of the wall clock under the runtime. The loop of the runtime and the runtime go on two fake
 * clocks. The monotonic clock is a `fakeClock`. The wall clock is the monotonic time plus an offset. A step changes
 * only the offset, as a correction of the system time does. Thus no timer moves. The runtime, the loop and the channel
 * read the wall clock through one `frameClock`, as the instance of the runtime does.
 *
 * The runtime sends a `life-safety` alert through the Pushover channel to the scripted Pushover API of
 * `@procedures/notify/testing`, behind the fault proxy of `@mark1russell7/rigor-proxy`. The case drives the real loop
 * (`createLoop`) in steps of `tickMs`, and it holds the fake time while a pass is in flight. The arms:
 *
 * - `control`: no step.
 * - `back-poll`: a step of `backMs` back after the pass with the delivery, before the first read of the receipt.
 * - `forward-poll`: a step of `forwardMs` forward at the same point.
 * - `back-retry`: the proxy answers the first send with HTTP 503. The step of `backMs` back comes in the wait before the retry.
 * - `back-fetch`: a step of `backMs` back after the cancel of the copy, before the second fetch of the source.
 *
 * The gates of each arm, from the ledger of the API, the log of the runtime and the monotonic time of each request:
 *
 * - `delivered`, `single` and `stopped`: the gates of case 4 (`acceptGatesOf`).
 * - `copyOnce`: each copy id has one send or none.
 * - `noThrow`: no pass throws. A pass that throws after a step is a fault of the runtime, not a fault of the case.
 * - `prompt`: each due action of the arm comes by its due time on the monotonic clock, plus `slackMs`.
 * - `stepSeen`: after a step, the log has one system event with one report that names the size of the step.
 * - `oneCopy` and `noOverdue`, in `control` and `forward-poll`: the API gets one send, and no pass has a failed request or an overdue send.
 *
 * Before AL-49, a step back held each due action by the size of the step, and the log had no report of the step. The
 * frame clock of AL-49 gives each step to the runtime at the start of the next pass.
 */
import { fakeClock, fakeWallClock, frameClock } from "@mark1russell7/algebra/clock";
import { CLOCK_STEP_ABOVE, type SourceProcedures } from "@mark1russell7/alerts";
import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import { createLoop, DELIVERY_TIMES, type DeliveryOptions, loopTimes, openRuntime, openRuntimeLog, type Pass } from "@mark1russell7/alerts-runtime";
import { type Fault, faultPlanOf } from "@mark1russell7/rigor-chaos";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { errorMessage } from "@mark1russell7/text";
import { type PushoverLedger, pushoverApi, pushoverFetchTo, pushoverLedgerOf } from "@procedures/notify/testing";
import { type CallFailure, deliveryFixture, FIXTURE_PLACE, type LogSummary, logSummaryOf } from "./delivery-fixture.ts";
import { driveFakeLoop, firstFrom, passTracker } from "./fake-loop.ts";
import { type AcceptGate, acceptGatesOf, copyOnceOf } from "./late-accept.ts";

/** The id of the case. */
export const CASE_11_ID = "al-13-case-11";

/** The id of the source of the case. */
export const CASE_11_SOURCE = "case-11";

/** The word at the start of the test values of the case. */
export const CASE_11_WORD = "caseeleven";

/** The start of each arm: the instant and the monotonic time of the first pass. */
export const CASE_11_START: number = Date.UTC(2026, 3, 1, 18);

/** The source, the person and the test values of the case. */
const FIXTURE = deliveryFixture(CASE_11_SOURCE, CASE_11_WORD);

/** The interval of the source of the case: one fetch at the start, and the next fetch one interval later. */
export const CASE_11_INTERVAL: number = FIXTURE.sourceOf(CASE_11_START).describe().interval;

/** The time after which the escalation of the person ends with no acknowledgment. */
const EXHAUSTED_AFTER: number = FIXTURE.recipient.policies[0]?.exhaustedAfter ?? 0;

/** The time of the warning of the fixture, from its `sent` time to its `expires` time. */
const WARNING_MS = 45 * 60_000;

/** An arm of the case. */
export type StepArm = "control" | "back-poll" | "forward-poll" | "back-retry" | "back-fetch";

/** The arms of the case, in the order of a start. */
export const STEP_ARMS: readonly StepArm[] = ["control", "back-poll", "forward-poll", "back-retry", "back-fetch"];

/**
 * The point of the step of an arm. The case steps the wall clock in the sleep after the first pass with this fact:
 *
 * - `delivery`: the pass wrote a delivery.
 * - `send-failure`: a send of the pass failed.
 * - `cancel`: the pass cancelled a delivery.
 */
export type StepPoint = "delivery" | "send-failure" | "cancel";

/** A gate of an arm. */
export type StepGate = AcceptGate | "copyOnce" | "noThrow" | "prompt" | "stepSeen" | "oneCopy" | "noOverdue";

/** The gates of the case, in their order. */
export const STEP_GATES: readonly StepGate[] = ["delivered", "single", "stopped", "copyOnce", "noThrow", "prompt", "stepSeen", "oneCopy", "noOverdue"];

const BASE_GATES: readonly StepGate[] = ["delivered", "single", "stopped", "copyOnce", "noThrow", "prompt"];

/** The gates of each arm. Only an arm with a step has `stepSeen`. Only the arms with no fault of the API have `oneCopy` and `noOverdue`. */
export const ARM_STEP_GATES: Readonly<Record<StepArm, readonly StepGate[]>> = {
  control: [...BASE_GATES, "oneCopy", "noOverdue"],
  "back-poll": [...BASE_GATES, "stepSeen"],
  "forward-poll": [...BASE_GATES, "stepSeen", "oneCopy", "noOverdue"],
  "back-retry": [...BASE_GATES, "stepSeen"],
  "back-fetch": [...BASE_GATES, "stepSeen"],
};

/** The settings of the case. Each time is in milliseconds. The delivery uses `DELIVERY_TIMES`, the times of production. */
export interface StepSettings {
  /** The size of each step back. */
  readonly backMs: number;
  /** The size of the step forward. It is shorter than the escalation and the warning, thus the warning stays live. */
  readonly forwardMs: number;
  /** The time after its due time in which a due action comes, for the gate `prompt`. */
  readonly slackMs: number;
  /** A step larger than this time has a report in the log, for the gate `stepSeen`. */
  readonly seenAboveMs: number;
  /** The fake time of each step of the case. The case holds the fake time while a pass is in flight. */
  readonly tickMs: number;
  /** The fake time of one arm, from its first pass. */
  readonly armMs: number;
  /** The count of receipts of the scripted API. */
  readonly receipts: number;
}

/** The settings of the case in CI, as the prediction states. */
export const CASE_11_SETTINGS: StepSettings = {
  backMs: 3_600_000,
  forwardMs: 600_000,
  slackMs: 2000,
  seenAboveMs: 2000,
  tickMs: 250,
  armMs: 7_800_000,
  receipts: 12,
};

/** The step of an arm: its point and its size, negative for a step back. `control` has no step. */
export function stepOf(arm: StepArm, settings: StepSettings = CASE_11_SETTINGS): { readonly point: StepPoint; readonly size: number } | undefined {
  switch (arm) {
    case "control":
      return undefined;
    case "back-poll":
      return { point: "delivery", size: -settings.backMs };
    case "forward-poll":
      return { point: "delivery", size: settings.forwardMs };
    case "back-retry":
      return { point: "send-failure", size: -settings.backMs };
    case "back-fetch":
      return { point: "cancel", size: -settings.backMs };
  }
}

/** This function gives the fault of an arm: the answer 503 to the first send for `back-retry`, and no fault for each other arm. */
export function stepFaultOf(arm: StepArm): Fault | undefined {
  return arm === "back-retry" ? { connection: 0, direction: "up", at: { frame: 0 }, kind: "answer", status: 503 } : undefined;
}

/** A failed request of a pass, with its wait: the time from the pass to its retry, on the wall clock before the step. */
export interface StepFailure extends CallFailure {
  readonly retryIn: number;
}

/** One pass of an arm. Each time is from the start of the arm. */
export interface StepPassNote {
  /** The monotonic time of the pass. */
  readonly at: number;
  /** The time of the view on the wall clock. */
  readonly wall: number;
  /** The time from the view to the wake time of the pass. */
  readonly wakeIn?: number;
  /** The counts of the deliveries that the pass wrote, of its acknowledgments, of its cancels and of its overdue sends. */
  readonly sent: number;
  readonly acknowledged: number;
  readonly cancelled: number;
  readonly overdue: number;
  readonly failures: readonly StepFailure[];
}

/** The step of an arm, as the case made it. */
export interface StepMark {
  readonly point: StepPoint;
  /** The size of the step, negative for a step back. */
  readonly size: number;
  /** The monotonic time of the step, from the start of the arm. */
  readonly at: number;
  /** The count of the events of the log before the step. */
  readonly events: number;
}

/** A system event of the log. Its time is on the wall clock, from the start of the arm. Each report has its kind and its text. */
export interface StepSystemEvent {
  readonly at: number;
  readonly reports: readonly { readonly kind: string; readonly text: string }[];
}

/** The record of one arm. */
export interface StepRecord {
  readonly arm: StepArm;
  readonly seed: string;
  /** True when the proxy recorded the answer of `back-retry` on connection 0, or no fault for each other arm. */
  readonly faulted: boolean;
  readonly step?: StepMark;
  readonly passes: readonly StepPassNote[];
  /** The monotonic time of the start of each fetch of the source, from the start of the arm. */
  readonly fetches: readonly number[];
  /** The monotonic time of each request that the scripted API got, by its position in the ledger. */
  readonly requests: readonly number[];
  readonly ledger: PushoverLedger;
  readonly log: LogSummary;
  /** The system events of the log after the step, or each system event of an arm with no step. */
  readonly system: readonly StepSystemEvent[];
  /** The errors that the loop got from the passes, each with its monotonic time from the start of the arm. */
  readonly loopErrors: readonly { readonly at: number; readonly message: string }[];
  /** The first text of `RuntimeLoop.stuck` after the step, or after the start in an arm with no step. */
  readonly stuck?: string;
  /** The text of the error of an arm that threw. */
  readonly error?: string;
}

/** A due action of an arm: its due time and the time when it came, on the monotonic clock from the start of the arm. */
export interface DueAction {
  readonly action: "read" | "send" | "fetch";
  readonly due: number;
  /** The time of the action. It is absent when the action did not come in the arm. */
  readonly at?: number;
}

/** The result of one arm. */
export interface StepResult {
  /** The gates of the arm in `ARM_STEP_GATES`. */
  readonly gates: Readonly<Partial<Record<StepGate, boolean>>>;
  readonly due: readonly DueAction[];
  readonly problems: readonly string[];
}

/** The verdict of the case. A case with no read does not pass. */
export interface StepVerdict {
  /** True when the settings are valid, each arm completed with no error, each step fell at its point, and `control` passed each gate. */
  readonly read: boolean;
  readonly results: Readonly<Record<StepArm, StepResult>>;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** The records of one start of the case, with the times of the delivery. */
export interface StepRun {
  readonly id: string;
  readonly settings: StepSettings;
  readonly times: { readonly pollEvery: number; readonly retry: number; readonly callLimit: number; readonly flightLimit: number; readonly overdueAfter: number; readonly interval: number };
  readonly records: readonly StepRecord[];
  readonly verdict: StepVerdict;
}

/** This function tells if a pass of the list has the fact of the point. */
function reached(point: StepPoint, passes: readonly StepPassNote[]): boolean {
  switch (point) {
    case "delivery":
      return passes.some((pass) => pass.sent > 0);
    case "send-failure":
      return passes.some((pass) => pass.failures.some((failure) => failure.call === "send"));
    case "cancel":
      return passes.some((pass) => pass.cancelled > 0);
  }
}

/**
 * This function starts one arm: a scripted API, a proxy with the fault of the arm, and a new runtime with its loop.
 * The runtime and the loop use the fake clocks of the arm. The case moves the fake time in steps of `tickMs`.
 */
export async function runStepArm(arm: StepArm, settings: StepSettings = CASE_11_SETTINGS): Promise<StepRecord> {
  const seed = `${CASE_11_ID}-${arm}`;
  const server = await startScriptedServer(pushoverApi({ receipts: settings.receipts, tags: "any" }));
  const fault = stepFaultOf(arm);
  const proxy = await startFaultProxy({ target: { host: server.host, port: server.port }, plan: faultPlanOf(fault === undefined ? [] : [fault]), protocol: "http" });
  const mono = fakeClock(CASE_11_START);
  // The loop and the runtime share one queue of timers: the wall clock is on the monotonic clock of the case.
  const wall = fakeWallClock(CASE_11_START, mono);
  // The instance of the runtime puts a frame clock on its wall clock. The case does the same, thus a step comes to the
  // runtime at the start of the next pass.
  const frame = frameClock(wall, mono, { driftLimit: CLOCK_STEP_ABOVE });
  const since = (): number => mono.now() - CASE_11_START;
  // The channel requests the address of the Pushover API. This fetch sends each request to the proxy, with the same path and query.
  const channel = createPushoverChannel({ token: FIXTURE.token, fetch: pushoverFetchTo(`http://${proxy.host}:${String(proxy.port)}`), now: () => frame.now() });
  const inner = FIXTURE.sourceOf(CASE_11_START);
  const fetches: number[] = [];
  const source: SourceProcedures = {
    ...inner,
    fetch: (...args: Parameters<SourceProcedures["fetch"]>) => {
      fetches.push(since());
      return inner.fetch(...args);
    },
  };
  const log = openRuntimeLog(":memory:");
  const passes: StepPassNote[] = [];
  const requests: number[] = [];
  const loopErrors: { at: number; message: string }[] = [];
  const planned = stepOf(arm, settings);
  let step: StepMark | undefined;
  let stuck: string | undefined;
  const flight = passTracker();
  let error: string | undefined;
  // The fake time does not move while a pass is in flight. Thus each request of a pass has the time of its pass.
  const stamp = (): void => {
    while (requests.length < server.requests.length) requests.push(since());
  };
  const note = (pass: Pass): void => {
    stamp();
    const delivery = pass.delivery;
    passes.push({
      at: since(),
      wall: pass.at - CASE_11_START,
      ...(pass.wakeAt === undefined ? {} : { wakeIn: pass.wakeAt - pass.at }),
      sent: delivery?.sent.length ?? 0,
      acknowledged: delivery?.acknowledged.length ?? 0,
      cancelled: delivery?.cancelled.length ?? 0,
      overdue: (delivery?.overdue ?? []).reduce((sum, entry) => sum + entry.sends, 0),
      failures: (delivery?.failures ?? []).map((failure) => ({ call: failure.call, kind: failure.kind, message: failure.message, retryIn: failure.retryAt - pass.at })),
    });
  };
  try {
    const delivery: DeliveryOptions = { recipients: [FIXTURE.recipient], channels: [channel], ...DELIVERY_TIMES };
    let wake = (): void => undefined;
    const runtime = openRuntime({
      log,
      clock: frame,
      sources: [source],
      watch: () => ({ places: [FIXTURE_PLACE], kinds: ["met"] }),
      view: FIXTURE.view,
      run: seed,
      delivery,
      wake: () => wake(),
    });
    const loop = createLoop({
      pass: (stop) =>
        flight.track(
          runtime.pass(stop).then((pass) => {
            note(pass);
            return pass;
          }),
        ),
      clock: mono,
      wall: frame,
      times: loopTimes(runtime.config.sources, { delivery }),
      random: () => 0,
      onError: (thrown) => {
        loopErrors.push({ at: since(), message: errorMessage(thrown) });
      },
    });
    wake = () => loop.wake();
    await driveFakeLoop({
      loop,
      clock: mono,
      flight,
      tickMs: settings.tickMs,
      until: CASE_11_START + settings.armMs,
      // The step falls in the sleep after the pass with the fact of its point, as a correction of the system time does.
      beforeTick: () => {
        if (planned !== undefined && step === undefined && reached(planned.point, passes)) {
          step = { point: planned.point, size: planned.size, at: since(), events: [...log.read()].length };
          wall.set(wall.now() + planned.size);
        }
      },
      afterTick: () => {
        stamp();
        if (planned === undefined || step !== undefined) stuck ??= loop.stuck();
      },
    });
  } catch (thrown) {
    error = errorMessage(thrown);
  }
  stamp();
  const events = [...log.read()];
  const system = (step === undefined ? events : events.slice(step.events)).flatMap((event): StepSystemEvent[] =>
    event.type === "system"
      ? [
          {
            at: event.time - CASE_11_START,
            reports: event.reports.map((report) => ({ kind: report.kind.code, text: [report.headline, report.description, report.instruction].filter((part) => part !== undefined).join(" ") })),
          },
        ]
      : [],
  );
  const summary = logSummaryOf(log);
  log.close();
  const ledger = pushoverLedgerOf([...server.requests]);
  await proxy.close();
  await server.close();
  const faulted =
    fault === undefined ? proxy.records.length === 0 : proxy.records.some((r) => r.kind === "answer" && r.connection === 0 && r.direction === "up" && r.frame === 0);
  return {
    arm,
    seed,
    faulted,
    ...(step === undefined ? {} : { step }),
    passes,
    fetches,
    requests,
    ledger,
    log: summary,
    system,
    loopErrors,
    ...(stuck === undefined ? {} : { stuck }),
    ...(error === undefined ? {} : { error }),
  };
}

/** This function starts the case: each arm, in order. It gives the records and the verdict. */
export async function runClockStep(given: Partial<StepSettings> = {}): Promise<StepRun> {
  const settings: StepSettings = { ...CASE_11_SETTINGS, ...given };
  const records: StepRecord[] = [];
  for (const arm of STEP_ARMS) records.push(await runStepArm(arm, settings));
  const { pollEvery, retry, callLimit, flightLimit, overdueAfter } = DELIVERY_TIMES;
  return { id: CASE_11_ID, settings, times: { pollEvery, retry, callLimit, flightLimit, overdueAfter, interval: CASE_11_INTERVAL }, records, verdict: stepVerdictOf(records, settings) };
}

/** The monotonic times of the first read of each message, and of each send, in a record. */
function requestTimes(record: Pick<StepRecord, "ledger" | "requests">): { readonly reads: readonly (number | undefined)[]; readonly sends: readonly (number | undefined)[] } {
  const { messages } = record.ledger;
  return {
    reads: messages.map((message) => (message.readAt === undefined ? undefined : record.requests[message.readAt])),
    sends: messages.map((message) => record.requests[message.position]),
  };
}

/**
 * This function gives the due actions of a record. Each due time comes from the facts before the step, on the
 * monotonic clock:
 *
 * - the first read after a delivery: the pass of the delivery, plus `pollEvery`
 * - the retry of a failed send: the pass of the failure, plus its wait
 * - the second fetch of the source: the first fetch, plus the interval of the source.
 *
 * The function gives no action when a fact is missing. Then the gate `prompt` fails.
 */
export function dueActionsOf(record: Pick<StepRecord, "arm" | "step" | "passes" | "fetches" | "ledger" | "requests">): DueAction[] {
  const { reads, sends } = requestTimes(record);
  const from = record.step?.at ?? 0;
  const delivered = record.passes.find((pass) => pass.sent > 0);
  const read = (): DueAction[] => {
    if (delivered === undefined) return [];
    const at = firstFrom(reads, Math.max(from, delivered.at));
    return [{ action: "read", due: delivered.at + DELIVERY_TIMES.pollEvery, ...(at === undefined ? {} : { at }) }];
  };
  const fetch = (): DueAction[] => {
    const first = record.fetches[0];
    if (first === undefined) return [];
    const at = record.fetches[1];
    return [{ action: "fetch", due: first + CASE_11_INTERVAL, ...(at === undefined ? {} : { at }) }];
  };
  switch (record.arm) {
    case "control":
      return [...read(), ...fetch()];
    case "back-poll":
    case "forward-poll":
      return read();
    case "back-retry": {
      const failed = record.passes.find((pass) => pass.failures.some((failure) => failure.call === "send"));
      const failure = failed?.failures.find((entry) => entry.call === "send");
      if (failed === undefined || failure === undefined) return [];
      const at = firstFrom(sends, Math.max(from, failed.at));
      return [{ action: "send", due: failed.at + failure.retryIn, ...(at === undefined ? {} : { at }) }];
    }
    case "back-fetch":
      return fetch();
  }
}

/** The forms of a size in a report: whole seconds, and whole minutes or hours when the size has them. */
export function sizeForms(size: number): string[] {
  const ms = Math.abs(size);
  return [`${String(ms / 1000)} s`, ...(ms % 60_000 === 0 ? [`${String(ms / 60_000)} min`] : []), ...(ms % 3_600_000 === 0 ? [`${String(ms / 3_600_000)} h`] : [])];
}

/** This function tells if a text names a size in one of its forms, with no digit before it and no letter after it. */
export function namesSize(text: string, size: number): boolean {
  return sizeForms(size).some((form) => new RegExp(`(^|[^0-9.])${form}(?![A-Za-z])`).test(text));
}

/** This function gives the gates of one record in `ARM_STEP_GATES`, its due actions, and a problem for each gate that fails. */
export function stepGatesOf(record: StepRecord, settings: StepSettings = CASE_11_SETTINGS): StepResult {
  const wanted = new Set(ARM_STEP_GATES[record.arm]);
  const accept = acceptGatesOf(record);
  const { copyOnce, problems: copyProblems } = copyOnceOf(record);
  const problems: string[] = [...accept.problems, ...copyProblems];

  const noThrow = record.loopErrors.length === 0;
  for (const thrown of record.loopErrors) problems.push(`${record.arm}: a pass threw at ${String(thrown.at)} ms: ${thrown.message}`);

  const due = dueActionsOf(record);
  const late = due.filter((action) => action.at === undefined || action.at > action.due + settings.slackMs);
  const prompt = due.length > 0 && late.length === 0;
  if (due.length === 0) problems.push(`${record.arm}: the record has no due action. A fact before the step is missing.`);
  for (const action of late) {
    const came = action.at === undefined ? "did not come in the arm" : `came at ${String(action.at)} ms, ${String(action.at - action.due)} ms late`;
    problems.push(`${record.arm}: the ${action.action} was due at ${String(action.due)} ms on the monotonic clock, and it ${came}. The slack is ${String(settings.slackMs)} ms.`);
  }

  const size = record.step?.size;
  const naming = size === undefined ? [] : record.system.filter((event) => event.reports.some((report) => namesSize(report.text, size)));
  const named = size === undefined ? 0 : record.system.flatMap((event) => event.reports).filter((report) => namesSize(report.text, size)).length;
  const stepSeen = size !== undefined && naming.length === 1 && named === 1;
  if (wanted.has("stepSeen") && !stepSeen) {
    problems.push(
      `${record.arm}: the step of ${String(size ?? 0)} ms gave ${String(naming.length)} system events and ${String(named)} reports that name its size (${sizeForms(size ?? 0).join(", ")}), not 1 and 1.`,
    );
  }

  const oneCopy = record.ledger.counts.sends === 1;
  if (wanted.has("oneCopy") && !oneCopy) problems.push(`${record.arm}: the API got ${String(record.ledger.counts.sends)} sends, not 1.`);
  const failures = record.passes.flatMap((pass) => pass.failures);
  const overdue = record.passes.reduce((sum, pass) => sum + pass.overdue, 0);
  const noOverdue = failures.length === 0 && overdue === 0;
  if (wanted.has("noOverdue") && !noOverdue) problems.push(`${record.arm}: the passes have ${String(failures.length)} failed requests and ${String(overdue)} overdue sends, not 0 and 0.`);

  const all: Readonly<Record<StepGate, boolean>> = { ...accept.gates, copyOnce, noThrow, prompt, stepSeen, oneCopy, noOverdue };
  const gates: Partial<Record<StepGate, boolean>> = {};
  for (const gate of ARM_STEP_GATES[record.arm]) gates[gate] = all[gate];
  return { gates, due, problems };
}

/** This function gives the problems of the settings. With a problem, the case cannot read. */
export function stepSettingsProblems(settings: StepSettings): string[] {
  const problems: string[] = [];
  for (const [name, size] of [
    ["backMs", settings.backMs],
    ["forwardMs", settings.forwardMs],
  ] as const) {
    if (!(Number.isInteger(size / 1000) && size > settings.seenAboveMs)) problems.push(`The step ${name} (${String(size)} ms) is not whole seconds above seenAboveMs (${String(settings.seenAboveMs)} ms).`);
  }
  const live = Math.min(EXHAUSTED_AFTER, WARNING_MS);
  if (!(settings.forwardMs + DELIVERY_TIMES.pollEvery < live)) problems.push(`The step forward and one poll (${String(settings.forwardMs + DELIVERY_TIMES.pollEvery)} ms) are not shorter than the escalation and the warning (${String(live)} ms).`);
  const need = settings.backMs + CASE_11_INTERVAL + 2 * DELIVERY_TIMES.pollEvery + settings.slackMs;
  if (settings.armMs < need) problems.push(`The arm (${String(settings.armMs)} ms) is shorter than a step back, an interval of the source and two polls (${String(need)} ms).`);
  if (!(settings.tickMs >= 1 && 4 * settings.tickMs <= settings.slackMs)) problems.push(`The tick (${String(settings.tickMs)} ms) is not from 1 ms to a quarter of the slack (${String(settings.slackMs)} ms).`);
  return problems;
}

/** This function gives the problems of one record that stop the read of the case. */
export function armProblemsOf(record: StepRecord, settings: StepSettings = CASE_11_SETTINGS): string[] {
  const problems: string[] = [];
  const { arm } = record;
  if (record.error !== undefined) problems.push(`${arm}: the arm threw: ${record.error}`);
  if (!record.faulted) problems.push(arm === "back-retry" ? "back-retry: the proxy has no record of the answer 503 at frame 0 of connection 0." : `${arm}: the proxy recorded a fault.`);
  if (record.ledger.counts.sends >= settings.receipts) problems.push(`${arm}: ${String(record.ledger.counts.sends)} sends used each receipt of the scripted API.`);
  const planned = stepOf(arm, settings);
  const { step } = record;
  if (planned === undefined) {
    if (step !== undefined) problems.push(`${arm}: the arm has a step, and it has none in the plan.`);
    return problems;
  }
  if (step === undefined || step.point !== planned.point || step.size !== planned.size) {
    problems.push(`${arm}: the step of the plan (${String(planned.size)} ms at ${planned.point}) did not fall.`);
    return problems;
  }
  const { reads, sends } = requestTimes(record);
  const before = (times: readonly (number | undefined)[]): number => times.filter((time) => time !== undefined && time < step.at).length;
  if (step.point === "delivery" && before(reads) > 0) problems.push(`${arm}: a read of the receipt came before the step.`);
  if (step.point === "send-failure" && before(sends) > 0) problems.push(`${arm}: a send got to the API before the step.`);
  if (step.point === "cancel" && before(record.fetches) !== 1) problems.push(`${arm}: ${String(before(record.fetches))} fetches came before the step, not 1.`);
  return problems;
}

/** This function gives the verdict of the records of a start of the case. */
export function stepVerdictOf(records: readonly StepRecord[], settings: StepSettings = CASE_11_SETTINGS): StepVerdict {
  const problems: string[] = stepSettingsProblems(settings);
  const failed: string[] = [];
  const results = {} as Record<StepArm, StepResult>;
  for (const arm of STEP_ARMS) {
    const of = records.filter((record) => record.arm === arm);
    const record = of[0];
    if (of.length !== 1 || record === undefined) {
      problems.push(`${arm}: ${String(of.length)} records, not 1.`);
      const gates: Partial<Record<StepGate, boolean>> = {};
      for (const gate of ARM_STEP_GATES[arm]) gates[gate] = false;
      results[arm] = { gates, due: [], problems: [] };
      continue;
    }
    problems.push(...armProblemsOf(record, settings));
    const result = stepGatesOf(record, settings);
    results[arm] = result;
    // The control arm passes each gate, or the case cannot read.
    if (arm === "control") problems.push(...result.problems.map((problem) => `${problem} The control arm fails, thus the case cannot read.`));
    else failed.push(...result.problems);
  }
  const read = problems.length === 0;
  const pass = read && STEP_ARMS.every((arm) => ARM_STEP_GATES[arm].every((gate) => results[arm].gates[gate] === true));
  return { read, results, pass, problems: [...problems, ...failed] };
}
