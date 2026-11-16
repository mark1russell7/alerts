/**
 * AL-13, case 10: a hard stop of the runtime in a delivery, and a restart. The runtime sends a `life-safety` alert through the Pushover
 * channel to a scripted Pushover API. Each life of the runtime is a child process (`kill-life.ts`) on one SQLite log file.
 * In each arm except `control`, the first life sends `SIGKILL` to itself at one point of the delivery. Then a second life
 * opens the same log, with a new run id, to the end of the arm. The arms:
 *
 * - `control`: no stop. This arm is the control of the case.
 * - `attempt-unsent`: the stop comes after the log keeps the `attempt` row of the copy, before the send.
 * - `accepted-unlogged`: the API accepted the copy, and the stop comes before the log keeps its delivery.
 * - `logged-unacked`: the stop comes after the log keeps the delivery, before the first read of the receipt.
 * - `backoff`: the proxy answers the first send with HTTP 503, and the stop comes in the wait before the retry.
 *
 * The gates of each arm, from the ledger of the API and the log at the end of the arm:
 *
 * - `delivered`, `single` and `stopped`: the gates of case 4 (`acceptGatesOf`). No alert is lost, one copy of each key is
 *   live, and no copy repeats with no cancel and no acknowledgment.
 * - `copyOnce`: each copy id has one send or none.
 * - `restartOnce`: the last life sends one new copy of each key or none. Each copy of an earlier life with no delivery
 *   in the log gets a cancel. An extra page to the person after a restart is the fault that this case finds.
 *
 * Known gap: the Twilio arms come with AL-15, because `instance.ts` has no Twilio sender. No channel drops a repeated
 * key yet. The first such channel gets a field of its descriptor, and this case gets an arm for it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openRuntimeLog } from "@mark1russell7/alerts-runtime";
import { type Fault, faultPlanOf } from "@mark1russell7/rigor-chaos";
import { startFaultProxy } from "@mark1russell7/rigor-proxy";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { errorMessage } from "@mark1russell7/text";
import { type PushoverLedger, type PushoverLedgerMessage, pushoverApi, pushoverLedgerOf } from "@procedures/notify/testing";
import { type CallFailure, type LogSummary, logSummaryOf } from "./delivery-fixture.ts";
import { type AcceptGate, acceptGatesOf } from "./late-accept.ts";

/** The id of the case. */
export const CASE_10_ID = "al-13-case-10";

/** The id of the source of the case. */
export const CASE_10_SOURCE = "case-10";

/** The word at the start of the test token and the test user key. */
export const CASE_10_WORD = "caseten";

/** A point of the delivery where the first life of an arm ends. */
export type KillPoint = "attempt-unsent" | "accepted-unlogged" | "logged-unacked" | "backoff";

/** An arm of the case. */
export type KillArm = "control" | KillPoint;

/** The arms of the case, in the order of a run. */
export const KILL_ARMS: readonly KillArm[] = ["control", "attempt-unsent", "accepted-unlogged", "logged-unacked", "backoff"];

/** A gate of an arm. */
export type KillGate = AcceptGate | "copyOnce" | "restartOnce";

/** The gates of each arm. */
export const KILL_GATES: readonly KillGate[] = ["delivered", "single", "stopped", "copyOnce", "restartOnce"];

/** The settings of the case. Each time is in milliseconds. */
export interface KillSettings {
  /** The longest time of one call of a channel in the delivery step (`DeliveryOptions.callLimit`). */
  readonly callLimitMs: number;
  /** The longest time of a send in flight (`DeliveryOptions.flightLimit`). */
  readonly flightLimitMs: number;
  /** The wait before a failed call goes again (`DeliveryOptions.retry`). */
  readonly retryMs: number;
  /** The time between two reads of one receipt (`DeliveryOptions.pollEvery`). */
  readonly pollEveryMs: number;
  /** The time limit of the Pushover channel on one request (`timeoutMs` of the channel). */
  readonly channelLimitMs: number;
  /** The time of one arm, from the start of its first life. */
  readonly armMs: number;
  /** The longest wait between two passes. */
  readonly tickMs: number;
  /** The count of receipts of the scripted API. */
  readonly receipts: number;
  /** The longest time of one life. After it, the parent stops the life with `SIGKILL`, and the arm has no read. */
  readonly lifeLimitMs: number;
}

/** The settings of the case in CI, as the prediction states. */
export const CASE_10_SETTINGS: KillSettings = {
  callLimitMs: 1000,
  flightLimitMs: 3000,
  retryMs: 1500,
  pollEveryMs: 1000,
  channelLimitMs: 4000,
  armMs: 12_000,
  tickMs: 200,
  receipts: 12,
  lifeLimitMs: 30_000,
};

/** The input of one life, as the parent gives it to `kill-life.ts`. */
export interface LifeInput {
  readonly source: string;
  readonly word: string;
  /** The run id of the life. Each copy id of the life starts with it. */
  readonly run: string;
  readonly point: KillPoint | "none";
  /** The address of the fault proxy before the scripted API. */
  readonly base: string;
  /** The path of the SQLite log file of the arm. */
  readonly log: string;
  /** The path of the notes file of the life. */
  readonly notes: string;
  /** The time of the warning, in milliseconds since the epoch. Each life of an arm gets the same time. */
  readonly sent: number;
  /** The end of the arm, in milliseconds since the epoch. */
  readonly end: number;
  readonly settings: KillSettings;
}

/** One note of a life. The child writes each note as one JSON line. */
export type LifeNote =
  | { readonly kind: "start"; readonly run: string; readonly at: number }
  | { readonly kind: "failure"; readonly call: string; readonly failure: string; readonly message: string; readonly at: number }
  | { readonly kind: "kill"; readonly point: KillPoint; readonly at: number }
  | { readonly kind: "end"; readonly passes: number; readonly duplicates: number; readonly at: number }
  | { readonly kind: "error"; readonly message: string; readonly passes: number; readonly at: number };

/** The record of one life. */
export interface LifeRecord {
  readonly life: number;
  readonly run: string;
  readonly point: KillPoint | "none";
  /** The exit code of the process, or `null` after a signal. */
  readonly code: number | null;
  /** The signal that ended the process, or `null` after an exit. */
  readonly signal: string | null;
  /** True when the life passed `lifeLimitMs`, and the parent stopped it. */
  readonly timedOut: boolean;
  readonly notes: readonly LifeNote[];
}

/** The record of one arm. */
export interface KillRecord {
  readonly arm: KillArm;
  /** The seed of the arm. The run id of each life starts with it. */
  readonly seed: string;
  readonly lives: readonly LifeRecord[];
  /** True when the proxy recorded the answer of `backoff` on connection 0, or no fault for each other arm. */
  readonly faulted: boolean;
  readonly ledger: PushoverLedger;
  readonly log: LogSummary;
  readonly failures: readonly CallFailure[];
  /** The text of an error of the parent. */
  readonly error?: string;
}

/** The result of one arm. */
export interface KillResult {
  readonly gates: Readonly<Record<KillGate, boolean>>;
  /** The copy ids at the API of each life, in the order of the lives. */
  readonly copies: readonly (readonly string[])[];
  /** The copy ids at the API that got a cancel. */
  readonly cancelled: readonly string[];
  readonly problems: readonly string[];
}

/** The verdict of the case. A case with no read does not pass. */
export interface KillVerdict {
  /**
   * True when the settings are valid and each arm completed with no error. Each life ended as its arm expects, each stop
   * fell at its point, and `control` passed each gate.
   */
  readonly read: boolean;
  readonly results: Readonly<Record<KillArm, KillResult>>;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** The records of one run of the case. */
export interface KillRun {
  readonly id: string;
  readonly settings: KillSettings;
  readonly records: readonly KillRecord[];
  readonly verdict: KillVerdict;
}

/** The script of one life. */
const LIFE_SCRIPT = fileURLToPath(new URL("./kill-life.ts", import.meta.url));

/** This function gives the fault of an arm: HTTP 503 in place of the first send for `backoff`, and no fault for each other arm. */
export function killFaultOf(arm: KillArm): Fault | undefined {
  return arm === "backoff" ? { connection: 0, direction: "up", at: { frame: 0 }, kind: "answer", status: 503 } : undefined;
}

/**
 * This function starts one life, and gives its exit. The case reads the signal that ended the child. Thus it uses
 * `spawn` of Node.js with argv and no shell, in place of a command runner.
 */
function startLife(input: LifeInput, limitMs: number): Promise<Pick<LifeRecord, "code" | "signal" | "timedOut">> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LIFE_SCRIPT, JSON.stringify(input)], { stdio: ["ignore", "ignore", "inherit"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limitMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
}

/** This function reads the notes of a life. A life that stopped before its first note has none. */
function notesOf(path: string): LifeNote[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LifeNote);
}

/** This function starts one arm: a scripted API, a proxy with the fault of the arm, and one or two lives of the runtime. */
export async function runKillArm(arm: KillArm, settings: KillSettings = CASE_10_SETTINGS): Promise<KillRecord> {
  const seed = `${CASE_10_ID}-${arm}`;
  const server = await startScriptedServer(pushoverApi({ receipts: settings.receipts, tags: "any" }));
  const fault = killFaultOf(arm);
  const proxy = await startFaultProxy({ target: { host: server.host, port: server.port }, plan: faultPlanOf(fault === undefined ? [] : [fault]), protocol: "http" });
  const folder = mkdtempSync(join(tmpdir(), `${seed}-`));
  const logPath = join(folder, "runtime.sqlite");
  const lives: LifeRecord[] = [];
  let error: string | undefined;
  const sent = Date.now();
  const end = sent + settings.armMs;
  const lifeOf = async (life: number, point: KillPoint | "none"): Promise<LifeRecord> => {
    const run = `${seed}-${String(life)}`;
    const notes = join(folder, `life-${String(life)}.jsonl`);
    const base = `http://${proxy.host}:${String(proxy.port)}`;
    const input: LifeInput = { source: CASE_10_SOURCE, word: CASE_10_WORD, run, point, base, log: logPath, notes, sent, end, settings };
    const exit = await startLife(input, settings.lifeLimitMs);
    return { life, run, point, ...exit, notes: notesOf(notes) };
  };
  try {
    const first = await lifeOf(1, arm === "control" ? "none" : arm);
    lives.push(first);
    if (arm !== "control" && first.signal === "SIGKILL" && !first.timedOut) lives.push(await lifeOf(2, "none"));
  } catch (thrown) {
    error = errorMessage(thrown);
  }
  let log: LogSummary = { deliveries: [], acknowledgments: 0, cancelled: [] };
  try {
    const file = openRuntimeLog(logPath);
    log = logSummaryOf(file);
    file.close();
  } catch (thrown) {
    error ??= `The read of the log failed: ${errorMessage(thrown)}`;
  }
  const ledger = pushoverLedgerOf([...server.requests]);
  await proxy.close();
  await server.close();
  rmSync(folder, { recursive: true, force: true });
  const faulted =
    fault === undefined
      ? proxy.records.length === 0
      : proxy.records.some((r) => r.kind === "answer" && r.connection === 0 && r.direction === "up" && r.frame === 0);
  const failures = lives.flatMap((life) => life.notes.flatMap((note): CallFailure[] => (note.kind === "failure" ? [{ call: note.call, kind: note.failure, message: note.message }] : [])));
  return { arm, seed, lives, faulted, ledger, log, failures, ...(error === undefined ? {} : { error }) };
}

/** This function starts the case: each arm, in order. It gives the records and the verdict. */
export async function runKillRestart(given: Partial<KillSettings> = {}): Promise<KillRun> {
  const settings: KillSettings = { ...CASE_10_SETTINGS, ...given };
  const records: KillRecord[] = [];
  for (const arm of KILL_ARMS) records.push(await runKillArm(arm, settings));
  return { id: CASE_10_ID, settings, records, verdict: killVerdictOf(records, settings) };
}

/** The copy id of a message: its second tag. */
const copyOf = (message: PushoverLedgerMessage): string | undefined => message.tags[1];

/** The delivery key of a message: its first tag. */
const keyOf = (message: PushoverLedgerMessage): string => message.tags[0] ?? "(no tag)";

/** This function gives the messages of one life: each message whose copy id starts with the run id of the life. */
export function messagesOfLife(record: Pick<KillRecord, "ledger">, life: Pick<LifeRecord, "run">): PushoverLedgerMessage[] {
  return record.ledger.messages.filter((message) => copyOf(message)?.startsWith(`${life.run}-`) === true);
}

/** This function gives the gates of one record, and a problem for each gate that fails. */
export function killGatesOf(record: KillRecord): KillResult {
  const accept = acceptGatesOf(record);
  const problems: string[] = [...accept.problems];
  const { messages } = record.ledger;
  const counts = new Map<string, number>();
  for (const message of messages) {
    const copy = copyOf(message);
    if (copy === undefined) problems.push(`${record.arm}: the message ${message.receipt} has no copy id.`);
    else counts.set(copy, (counts.get(copy) ?? 0) + 1);
  }
  const twice = [...counts].filter(([, count]) => count > 1);
  for (const [copy, count] of twice) problems.push(`${record.arm}: the copy ${copy} has ${String(count)} sends, not 1.`);
  const copyOnce = twice.length === 0 && messages.every((message) => copyOf(message) !== undefined);

  const logged = new Set(record.log.deliveries.flatMap((delivery) => (delivery.receipt === undefined ? [] : [delivery.receipt])));
  const last = record.lives.at(-1);
  let restartOnce = last !== undefined;
  if (last === undefined) problems.push(`${record.arm}: the arm has no life.`);
  else {
    const newest = messagesOfLife(record, last);
    for (const key of new Set(newest.map(keyOf))) {
      const count = newest.filter((message) => keyOf(message) === key).length;
      if (count > 1) {
        restartOnce = false;
        problems.push(`${record.arm}: life ${String(last.life)} sent ${String(count)} copies of the key ${key.slice(0, 12)}, not 1 or none.`);
      }
    }
    for (const life of record.lives.slice(0, -1)) {
      for (const message of messagesOfLife(record, life)) {
        if (logged.has(message.receipt) || message.cancelledAt !== undefined) continue;
        restartOnce = false;
        problems.push(`${record.arm}: the copy ${copyOf(message) ?? ""} of life ${String(life.life)} has no delivery in the log and no cancel. The person gets an extra page.`);
      }
    }
  }
  const copies = record.lives.map((life) => messagesOfLife(record, life).flatMap((message) => copyOf(message) ?? []));
  const cancelled = messages.flatMap((message) => (message.cancelledAt === undefined ? [] : (copyOf(message) ?? [])));
  return { gates: { ...accept.gates, copyOnce, restartOnce }, copies, cancelled, problems };
}

/** This function gives a problem for each life that did not end as its arm expects, and for a stop that missed its point. */
export function lifeProblemsOf(record: KillRecord): string[] {
  const problems: string[] = [];
  const { arm, lives } = record;
  for (const life of lives) {
    if (life.timedOut) problems.push(`${arm}: life ${String(life.life)} passed its time limit, and the parent killed it.`);
    const failed = life.notes.find((note) => note.kind === "error");
    if (failed?.kind === "error") problems.push(`${arm}: life ${String(life.life)} threw: ${failed.message}`);
  }
  const ended = (life: LifeRecord | undefined): boolean => life !== undefined && life.code === 0 && life.notes.some((note) => note.kind === "end");
  if (arm === "control") {
    if (lives.length !== 1 || !ended(lives[0])) problems.push(`control: ${String(lives.length)} lives, and the first did not end with the code 0 and an end note.`);
    if (!record.faulted) problems.push("control: the proxy recorded a fault.");
    return problems;
  }
  const [first, second] = lives;
  const killedAt = first?.notes.find((note) => note.kind === "kill");
  if (first === undefined || first.signal !== "SIGKILL" || killedAt?.kind !== "kill" || killedAt.point !== arm) {
    problems.push(`${arm}: the first life did not end by SIGKILL at the point ${arm}.`);
  }
  if (lives.length !== 2 || !ended(second)) problems.push(`${arm}: ${String(lives.length)} lives, and the second did not end with the code 0 and an end note.`);
  if (first === undefined) return problems;
  const early = messagesOfLife(record, first);
  const logged = new Set(record.log.deliveries.flatMap((delivery) => (delivery.receipt === undefined ? [] : [delivery.receipt])));
  if ((arm === "attempt-unsent" || arm === "backoff") && early.length > 0) problems.push(`${arm}: the API has ${String(early.length)} copies of the first life, not none.`);
  if (arm === "accepted-unlogged" && (early.length !== 1 || early.some((message) => logged.has(message.receipt)))) {
    problems.push(`${arm}: the API has ${String(early.length)} copies of the first life, not 1 with no delivery in the log.`);
  }
  if (arm === "logged-unacked" && (early.length !== 1 || !early.every((message) => logged.has(message.receipt)))) {
    problems.push(`${arm}: the API has ${String(early.length)} copies of the first life, not 1 with a delivery in the log.`);
  }
  if (arm === "backoff" && !record.faulted) problems.push("backoff: the proxy has no record of the answer 503 at frame 0 of connection 0.");
  if (arm !== "backoff" && !record.faulted) problems.push(`${arm}: the proxy recorded a fault.`);
  return problems;
}

/** This function gives the verdict of the records of a run. */
export function killVerdictOf(records: readonly KillRecord[], settings: KillSettings = CASE_10_SETTINGS): KillVerdict {
  const problems: string[] = [];
  // The second life needs the start of a process, a stop of the old copy, a send, a retry and two reads.
  const need = Math.max(settings.flightLimitMs, settings.channelLimitMs) + settings.retryMs + 2 * settings.pollEveryMs + 2000;
  if (settings.armMs < need) problems.push(`The arm (${String(settings.armMs)} ms) is shorter than the time that the second life needs (${String(need)} ms).`);
  if (settings.lifeLimitMs <= settings.armMs) problems.push(`The limit of a life (${String(settings.lifeLimitMs)} ms) is not longer than the arm (${String(settings.armMs)} ms).`);
  const results = {} as Record<KillArm, KillResult>;
  const failed: string[] = [];
  for (const arm of KILL_ARMS) {
    const of = records.filter((record) => record.arm === arm);
    const record = of[0];
    if (of.length !== 1 || record === undefined) {
      problems.push(`${arm}: ${String(of.length)} records, not 1.`);
      results[arm] = { gates: { delivered: false, single: false, stopped: false, copyOnce: false, restartOnce: false }, copies: [], cancelled: [], problems: [] };
      continue;
    }
    if (record.error !== undefined) problems.push(`${arm}: the arm failed: ${record.error}`);
    if (record.ledger.counts.sends >= settings.receipts) problems.push(`${arm}: ${String(record.ledger.counts.sends)} sends used each receipt of the scripted API.`);
    problems.push(...lifeProblemsOf(record));
    const result = killGatesOf(record);
    results[arm] = result;
    // The control arm passes each gate, or the case cannot read.
    if (arm === "control") problems.push(...result.problems.map((problem) => `${problem} The control arm fails, thus the case cannot read.`));
    else failed.push(...result.problems);
  }
  const read = problems.length === 0;
  const pass = read && KILL_ARMS.every((arm) => KILL_GATES.every((gate) => results[arm].gates[gate]));
  return { read, results, pass, problems: [...problems, ...failed] };
}
