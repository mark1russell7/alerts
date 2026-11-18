/**
 * AL-13, case 14: faults of the stream of NWWS-OI. The source of NWWS-OI holds one XMPP session in a room. Each arm
 * puts one fault between the source and a scripted XMPP server of `@mark1russell7/rigor-testkit`, with TLS. A fault
 * proxy of `@mark1russell7/rigor-proxy` stands between them.
 *
 * - `control`: no fault.
 * - `cut` and `reset`: the proxy ends the TCP connection in the middle of a product, with a FIN or with a reset.
 * - `stall`: the proxy holds the products for longer than the stall limit of the source.
 * - `close`: the server ends the stream with the stream error `system-shutdown`.
 * - `auth`: the server refuses the first login.
 * - `refused`: the room refuses the first join.
 * - `plain`: the server of the first connection offers no TLS.
 * - `gap`: the room skips a sequence number.
 *
 * After an end, the next session joins again and asks for the history from before the end. The room of the script
 * sends the products of the first session again from its history. `NWWS_GATES` tells the gates that examine each arm.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { Cursor } from "@mark1russell7/alerts";
import { createNwwsSource, joinRefusal, openXmppSession, productStanza, selfPresence, type EndKind, type OpenSession } from "@mark1russell7/alerts-source-nwws";
import { faultPlanOf, type Fault } from "@mark1russell7/rigor-chaos";
import { startFaultProxy, type FaultRecord } from "@mark1russell7/rigor-proxy";
import { testCertificates, trustCertificate, type TestCertificates } from "@mark1russell7/rigor-testkit/tls";
import { startXmppServer, type XmppConnection, type XmppSession, type XmppStep } from "@mark1russell7/rigor-testkit/xmpp";
import { backoffDelay, type Backoff } from "@mark1russell7/service/backoff";
import { NWS_WATCH } from "./nws.ts";

/** The id of the case. */
export const CASE_14_ID = "al-13-case-14";

/** The arms of the case. */
export const NWWS_ARMS = ["control", "cut", "reset", "stall", "close", "auth", "refused", "plain", "gap"] as const;
export type NwwsArm = (typeof NWWS_ARMS)[number];

/** The arms whose fault is in the fault proxy. */
export const NWWS_PROXY_ARMS: readonly NwwsArm[] = ["cut", "reset", "stall"];

/**
 * The gates of each arm.
 *
 * - `once`: no product comes twice.
 * - `whole`: each product of the room comes, and each fetch is complete. In the arm `gap`, a fetch is not complete.
 * - `ends`: the kinds of the ends of the sessions are the kinds of the arm.
 * - `rejoin`: each new session opens after the backoff of its end, and not later than `lateMs` after it. Its join asks
 *   for the history from before the end.
 * - `tls`: no login goes over a connection with no TLS.
 * - `secret`: no reason of an end holds the user name or the password, and no record holds the password.
 */
export const NWWS_GATES = ["once", "whole", "ends", "rejoin", "tls", "secret"] as const;
export type NwwsGate = (typeof NWWS_GATES)[number];

/** The settings of the case. Each time is in milliseconds. */
export interface NwwsSettings {
  /** The products of the first session. */
  readonly products: number;
  /** The new products of the next session, after the products of the history. */
  readonly more: number;
  /** The time before each product of a script. */
  readonly gapMs: number;
  /** The characters of the text of each product. A fault in the middle of a write then falls inside its product. */
  readonly textChars: number;
  /** The sequence number of the product at whose middle a fault of the proxy falls. */
  readonly faultAt: number;
  /** The stall limit of the source. */
  readonly stallAfter: number;
  /** The backoff of the source after an end. */
  readonly backoff: Backoff;
  /** The draw of the jitter of the backoff, from 0 up to 1. */
  readonly draw: number;
  /** The longest time from the end of the backoff to the open of the next session. */
  readonly lateMs: number;
  /** The longest time of an arm. */
  readonly armMs: number;
  /** The time between two fetches. */
  readonly fetchMs: number;
}

/** The settings of the case in CI. */
export const CASE_14_SETTINGS: NwwsSettings = {
  products: 6,
  more: 2,
  gapMs: 30,
  textChars: 2000,
  faultAt: 3,
  stallAfter: 500,
  backoff: { base: 200, factor: 2, cap: 2000, jitter: { kind: "subtract", fraction: 0.5 } },
  draw: 0.5,
  lateMs: 500,
  armMs: 8000,
  fetchMs: 50,
};

const DOMAIN = "nwws.example.org";
const ROOM = `nwws@conference.${DOMAIN}`;
/** The account of the case. The password is a value of the test, and the gate `secret` looks for it. */
const ACCOUNT = { username: "case-14", password: "case-14-password-3f9a" };
const NICKNAME = "alerts-0000000e";
const ISSUE = "2026-11-17T12:00:00Z";
const HISTORY = "2026-11-17T12:00:05Z";
// The steps of a script before the first product: the join of the session and the presence of the room.
const JOIN_PRESENCE: XmppStep = { receive: "presence" };
const JOIN: readonly XmppStep[] = [JOIN_PRESENCE, { send: selfPresence("{{to}}", "{{jid}}") }];

/** The serials from `first` to `last`. */
const range = (first: number, last: number): number[] => Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);

/** This function gives the text of a product: a CAP message of a Kansas office, padded to the size of the settings. */
export function productText(serial: number, settings: NwwsSettings): string {
  const head = `XOUS53 KTOP 171200\nCAPTOP\n\n<?xml version="1.0" encoding="UTF-8"?>\n<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>${CASE_14_ID}-${String(serial)}</identifier><note>`;
  const tail = "</note></alert>";
  return `${head}${"x".repeat(Math.max(0, settings.textChars - head.length - tail.length))}${tail}`;
}

/** This function gives the serial of an observation of the case, from the identifier of its CAP message. */
export function serialOf(body: string): number | undefined {
  const match = new RegExp(`<identifier>${CASE_14_ID}-(\\d+)</identifier>`).exec(body);
  return match === null ? undefined : Number(match[1]);
}

const productStep = (serial: number, settings: NwwsSettings, history?: string): XmppStep => ({
  send: productStanza({
    room: ROOM,
    to: "{{jid}}",
    id: `case14.${String(serial)}`,
    issue: ISSUE,
    ttaaii: "XOUS53",
    cccc: "KTOP",
    awipsid: "CAPTOP",
    text: productText(serial, settings),
    ...(history === undefined ? {} : { delayed: history }),
  }),
  ...(history === undefined ? { delayMs: settings.gapMs } : {}),
});

const room = (steps: readonly XmppStep[]): XmppSession => ({ steps: [...JOIN, ...steps] });
const live = (serials: readonly number[], settings: NwwsSettings): XmppStep[] => serials.map((serial) => productStep(serial, settings));
const history = (serials: readonly number[], settings: NwwsSettings): XmppStep[] => serials.map((serial) => productStep(serial, settings, HISTORY));

/** The index of the step of a product in the script of the first session. */
export const productStepIndex = (serial: number): number => JOIN.length + serial - 1;

/** What an arm expects. */
export interface NwwsExpected {
  /** The kinds of the ends of the sessions, in order. */
  readonly ends: readonly EndKind[];
  /** The serials of the products that come. */
  readonly serials: readonly number[];
  /** True: each fetch is complete. False: a fetch tells of a loss. */
  readonly complete: boolean;
  /** True: the first connection has no login. */
  readonly noLogin: boolean;
}

/** This function gives the scripts of the server for an arm, and what the arm expects. */
export function nwwsPlanOf(arm: NwwsArm, settings: NwwsSettings): { readonly sessions: readonly XmppSession[]; readonly expected: NwwsExpected } {
  const all = range(1, settings.products);
  const whole = (ends: readonly EndKind[], serials: readonly number[] = all, noLogin = false): NwwsExpected => ({ ends, serials, complete: true, noLogin });
  const afterFirst = room(live(all, settings));
  switch (arm) {
    case "control":
      return { sessions: [afterFirst], expected: whole([]) };
    case "cut":
    case "reset":
    case "stall": {
      const next = room([...history(all, settings), ...live(range(settings.products + 1, settings.products + settings.more), settings)]);
      return { sessions: [afterFirst, next], expected: whole([arm === "stall" ? "timeout" : "network"], range(1, settings.products + settings.more)) };
    }
    case "close": {
      const first = room([...live([1, 2], settings), { close: { condition: "system-shutdown" }, delayMs: settings.gapMs }]);
      return { sessions: [first, room([...history([1, 2], settings), ...live(range(3, settings.products), settings)])], expected: whole(["network"]) };
    }
    case "auth":
      return { sessions: [{ sasl: { failure: "not-authorized" } }, afterFirst], expected: whole(["auth"]) };
    case "refused":
      return { sessions: [{ steps: [JOIN_PRESENCE, { send: joinRefusal("{{to}}", "{{jid}}", "not-allowed") }] }, afterFirst], expected: whole(["refused"]) };
    case "plain":
      return { sessions: [{ startTls: "none" }, afterFirst], expected: whole(["refused"], all, true) };
    case "gap": {
      const serials = all.filter((serial) => serial !== settings.faultAt);
      return { sessions: [room(live(serials, settings))], expected: { ends: [], serials, complete: false, noLogin: false } };
    }
  }
}

/** The fault of the proxy for an arm, at a byte point. An arm with no fault of the proxy gives `undefined`. */
export function nwwsFaultOf(arm: NwwsArm, point: number, settings: NwwsSettings): Fault | undefined {
  const at = { connection: 0, direction: "down", at: { byte: point } } as const;
  if (arm === "cut") return { ...at, kind: "cut" };
  if (arm === "reset") return { ...at, kind: "reset" };
  if (arm === "stall") return { ...at, kind: "stall", ms: settings.stallAfter * 4 };
  return undefined;
}

/** The record of one connection of the server. It holds no user name and no password. */
export interface ConnectionNote {
  readonly session: number;
  readonly secure: boolean;
  /** True: the client sent a login. */
  readonly login: boolean;
  readonly sasl: string | undefined;
  readonly steps: number;
  readonly error: string | undefined;
  /** The time `since` of the history of the join, or `undefined` with no join. */
  readonly since: string | undefined;
  /** The offset and the length of the write of each product step, by the index of its step. */
  readonly writes: Readonly<Record<string, readonly [number, number]>>;
}

/** The record of one end of a session, as the state of the source tells it. `at` is the wall time. */
export interface EndNote {
  readonly kind: EndKind;
  readonly reason: string;
  readonly at: number;
}

/** The record of one arm. */
export interface NwwsRecord {
  readonly arm: NwwsArm;
  readonly fault: Fault | undefined;
  /** True: the fault of the proxy fell inside the write of its product. True for an arm with no fault of the proxy. */
  readonly faulted: boolean;
  readonly faults: readonly FaultRecord[];
  readonly connections: readonly ConnectionNote[];
  readonly ends: readonly EndNote[];
  /** The wall time of the open of each session. */
  readonly opens: readonly number[];
  /** The serial of each product of each fetch, in order, with each repeat. */
  readonly serials: readonly number[];
  /** The value `complete` of each fetch that succeeded. */
  readonly complete: readonly boolean[];
  /** The kind of each fetch that failed. */
  readonly failures: readonly string[];
  readonly ms: number;
  /** The message of an error of the arm itself. Then the case cannot read the arm. */
  readonly error?: string;
}

const noteOf = (connection: XmppConnection): ConnectionNote => {
  const join = connection.stanzas.find((stanza) => stanza.name === "presence");
  const writes: Record<string, readonly [number, number]> = {};
  for (const write of connection.wire) if (write.step >= JOIN.length) writes[String(write.step)] = [write.offset, write.length];
  return {
    session: connection.session,
    secure: connection.secure,
    login: connection.username !== undefined,
    sasl: connection.sasl,
    steps: connection.steps,
    error: connection.error,
    since: join === undefined ? undefined : /since=["']([^"']+)["']/.exec(join.xml)?.[1],
    writes,
  };
};

/** This function starts one arm and gives its record. `point` is the byte point of a fault of the proxy. */
export async function runNwwsArm(arm: NwwsArm, point: number, certificates: TestCertificates, settings: NwwsSettings = CASE_14_SETTINGS): Promise<NwwsRecord> {
  const { sessions, expected } = nwwsPlanOf(arm, settings);
  const fault = nwwsFaultOf(arm, point, settings);
  const started = performance.now();
  const server = await startXmppServer({ domain: DOMAIN, tls: certificates, accounts: [ACCOUNT], sessions });
  const proxy = await startFaultProxy({ target: { host: server.host, port: server.port }, plan: faultPlanOf(fault === undefined ? [] : [fault]) });
  const opens: number[] = [];
  const open: OpenSession = (options, handlers) => {
    opens.push(Date.now());
    return openXmppSession(options, handlers);
  };
  const source = createNwwsSource({
    account: ACCOUNT,
    open,
    random: () => settings.draw,
    nickname: () => NICKNAME,
    epoch: CASE_14_ID,
    backoff: settings.backoff,
    stallAfter: settings.stallAfter,
    service: `xmpp://${proxy.host}:${String(proxy.port)}`,
    domain: DOMAIN,
    room: ROOM,
  });
  const ends: EndNote[] = [];
  const serials: number[] = [];
  const complete: boolean[] = [];
  const failures: string[] = [];
  const noteEnd = (): void => {
    const ended = source.state().ended;
    const last = ends.at(-1);
    if (ended !== undefined && (last === undefined || last.at !== ended.at || last.reason !== ended.reason)) ends.push({ kind: ended.kind, reason: ended.reason, at: ended.at });
  };
  let error: string | undefined;
  try {
    const want = new Set(expected.serials).size;
    let cursor: Cursor | undefined;
    while (performance.now() - started < settings.armMs) {
      const outcome = await source.fetch(cursor === undefined ? { watch: NWS_WATCH } : { watch: NWS_WATCH, cursor });
      noteEnd();
      if (outcome.ok) {
        for (const observation of outcome.observations) {
          const serial = serialOf(observation.body);
          if (serial !== undefined) serials.push(serial);
        }
        complete.push(outcome.complete);
        cursor = outcome.cursor;
      } else {
        failures.push(outcome.failure.kind);
      }
      if (new Set(serials).size >= want && ends.length >= expected.ends.length) break;
      await delay(settings.fetchMs);
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    noteEnd();
    await source.close();
    await proxy.close();
    await server.close();
  }
  const connections = server.connections.map(noteOf);
  const write = connections[0]?.writes[String(productStepIndex(settings.faultAt))];
  const faulted =
    fault === undefined ||
    (write !== undefined &&
      point >= write[0] &&
      point < write[0] + write[1] &&
      proxy.records.some((record) => record.kind === fault.kind && record.connection === 0 && record.direction === "down" && record.byte === point));
  return {
    arm,
    fault,
    faulted,
    faults: proxy.records,
    connections,
    ends,
    opens,
    serials,
    complete,
    failures,
    ms: Math.round(performance.now() - started),
    ...(error === undefined ? {} : { error }),
  };
}

/** The gates and the problems of one arm. */
export interface NwwsResult {
  readonly gates: Readonly<Record<NwwsGate, boolean>>;
  readonly problems: readonly string[];
}

/** The run of the case: the settings, the byte point of the faults of the proxy, each record and the verdict. */
export interface NwwsRun {
  readonly id: string;
  readonly settings: NwwsSettings;
  /** The middle of the write of the product `faultAt` in the arm `control`, or `undefined` when the arm has no such write. */
  readonly point: number | undefined;
  readonly records: readonly NwwsRecord[];
  readonly verdict: NwwsVerdict;
}

/** The verdict of the case. */
export interface NwwsVerdict {
  readonly read: boolean;
  readonly pass: boolean;
  readonly problems: readonly string[];
  readonly results: Readonly<Partial<Record<NwwsArm, NwwsResult>>>;
}

const sameSet = (a: readonly number[], b: readonly number[]): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
};

/** This function gives the gates of one record. */
export function nwwsResultOf(record: NwwsRecord, settings: NwwsSettings = CASE_14_SETTINGS): NwwsResult {
  const { expected } = nwwsPlanOf(record.arm, settings);
  const problems: string[] = [];
  const once = new Set(record.serials).size === record.serials.length;
  if (!once) problems.push(`a product came twice: ${record.serials.join(", ")}`);
  const sameProducts = sameSet(record.serials, expected.serials);
  const whole = sameProducts && (expected.complete ? record.complete.every(Boolean) : record.complete.includes(false));
  if (!sameProducts) problems.push(`the products are ${[...new Set(record.serials)].join(", ") || "none"}, not ${expected.serials.join(", ")}`);
  else if (!whole) problems.push(expected.complete ? "a fetch was not complete with each product" : "the loss is silent: each fetch was complete");
  const kinds = record.ends.map((end) => end.kind);
  const ends = kinds.length === expected.ends.length && kinds.every((kind, index) => kind === expected.ends[index]);
  if (!ends) problems.push(`the ends are ${kinds.join(", ") || "none"}, not ${expected.ends.join(", ") || "none"}`);
  const rejoinProblems: string[] = [];
  if (record.opens.length !== record.ends.length + 1) rejoinProblems.push(`${String(record.opens.length)} sessions opened after ${String(record.ends.length)} ends`);
  record.ends.forEach((end, index) => {
    const next = record.opens[index + 1];
    if (next === undefined) return;
    const want = backoffDelay(settings.backoff, index + 1, () => settings.draw);
    const waited = next - end.at;
    if (waited < want - 5 || waited > want + settings.lateMs) rejoinProblems.push(`the session ${String(index + 1)} opened ${String(waited)} ms after the end, not in ${String(want)} to ${String(want + settings.lateMs)} ms`);
    const since = record.connections[index + 1]?.since;
    if (since !== undefined && Date.parse(since) > end.at) rejoinProblems.push(`the join of the session ${String(index + 1)} asks for the history since ${since}, after the end`);
  });
  problems.push(...rejoinProblems);
  const tls = record.connections.every((connection) => !connection.login || connection.secure) && (!expected.noLogin || record.connections[0]?.login === false);
  if (!tls) problems.push("a login went over a connection with no TLS");
  const secret =
    record.ends.every((end) => !end.reason.includes(ACCOUNT.password) && !end.reason.includes(ACCOUNT.username)) && !JSON.stringify(record).includes(ACCOUNT.password);
  if (!secret) problems.push("a reason or a record holds the account");
  return { gates: { once, whole, ends, rejoin: rejoinProblems.length === 0, tls, secret }, problems };
}

/**
 * This function gives the verdict of the records of the arms. The case cannot read with no point or with no record of
 * an arm. It also cannot read with an error of an arm, or with a fault off its point.
 */
export function nwwsVerdictOf(point: number | undefined, records: readonly NwwsRecord[], settings: NwwsSettings = CASE_14_SETTINGS, arms: readonly NwwsArm[] = NWWS_ARMS): NwwsVerdict {
  const problems: string[] = [];
  if (point === undefined && arms.some((arm) => NWWS_PROXY_ARMS.includes(arm))) problems.push(`the arm control has no write of the product ${String(settings.faultAt)}, so the faults of the proxy have no point`);
  for (const arm of arms) if (!records.some((record) => record.arm === arm)) problems.push(`the arm ${arm} has no record`);
  for (const record of records) {
    if (record.error !== undefined) problems.push(`${record.arm}: the arm stopped: ${record.error}`);
    if (!record.faulted) problems.push(`${record.arm}: the fault did not fall inside the product ${String(settings.faultAt)}`);
  }
  const read = problems.length === 0;
  const results: Partial<Record<NwwsArm, NwwsResult>> = {};
  for (const record of records) {
    const result = nwwsResultOf(record, settings);
    results[record.arm] = result;
    problems.push(...result.problems.map((problem) => `${record.arm}: ${problem}`));
  }
  return { read, pass: read && problems.length === 0, problems, results };
}

/** This function starts the case: the arm `control` gives the point of the faults, and then each other arm. */
export async function runNwwsStream(settings: NwwsSettings = CASE_14_SETTINGS, arms: readonly NwwsArm[] = NWWS_ARMS): Promise<NwwsRun> {
  const certificates = testCertificates({ names: [DOMAIN] });
  const untrust = trustCertificate(certificates.ca);
  const records: NwwsRecord[] = [];
  let point: number | undefined;
  try {
    const control = await runNwwsArm("control", 0, certificates, settings);
    records.push(control);
    const write = control.connections[0]?.writes[String(productStepIndex(settings.faultAt))];
    point = write === undefined ? undefined : write[0] + Math.floor(write[1] / 2);
    for (const arm of arms) {
      if (arm === "control") continue;
      if (point === undefined && NWWS_PROXY_ARMS.includes(arm)) continue;
      records.push(await runNwwsArm(arm, point ?? 0, certificates, settings));
    }
  } finally {
    untrust();
  }
  return { id: CASE_14_ID, settings, point, records, verdict: nwwsVerdictOf(point, records, settings, ["control", ...arms.filter((arm) => arm !== "control")]) };
}
