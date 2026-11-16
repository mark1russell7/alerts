/**
 * The adapter of the three outage Functions. It reads the request, it calls the pure handler of
 * `outage.ts`, it applies the actions through the ports, and it gives the reply.
 *
 * - The ports hold each effect: the list, the recent calls, a new call, the move of a status callback, the clock and the log.
 * - The module `twilio-runtime.ts` makes the ports from the context of a Function on the server of Twilio.
 * - A failed action goes to the log, and the next actions continue. Each person has a separate chain.
 * - No log line and no reply holds a phone number or a token. The log line of an error has a mark in place of each number of the list.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Instant } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { twilioGatherTwiml, twilioSayTwiml } from "@procedures/notify/twilio";
import { OUTAGE_TEXTS, outageEnded, outagePress, outageStart, outageTexts, type CallScript, type OutageAction, type OutageList, type OutageNote, type OutageStep } from "./outage.ts";

/** One call that the Function starts. */
export interface PlacedCall {
  /** The phone number in E.164 form. */
  readonly to: string;
  /** The TwiML of the call. */
  readonly twiml: string;
  /** The address that gets the status of the call at its end. */
  readonly statusCallback: string;
  /** The seconds that the phone rings before the call ends with no answer. */
  readonly ringSeconds: number;
}

/** The effects of the outage Functions. A test gives fakes. */
export interface OutagePorts {
  /** This port reads the list of the outage call. */
  readonly list: () => Promise<OutageList>;
  /** This port gives the start times of the newest calls of the Twilio number: at most `count` times. */
  readonly recent: (count: number) => Promise<readonly Instant[]>;
  /** This port starts a call. */
  readonly call: (call: PlacedCall) => Promise<void>;
  /** This port moves the status callback of the live call `sid` to the address `statusCallback`. */
  readonly move: (sid: string, statusCallback: string) => Promise<void>;
  readonly now: () => Instant;
  /** This port writes one line to the log of the Function. */
  readonly log: (line: string) => void;
}

/** A request to a Function. */
export interface OutageRequest {
  /** The base address of the Functions, for example `https://outage-0000.twil.io`. */
  readonly base: string;
  /** The fields of the request: the query and the form body. */
  readonly params: Readonly<Record<string, unknown>>;
}

/** The reply of a Function. */
export interface FunctionReply {
  readonly status: number;
  readonly type: "text/xml" | "application/json";
  readonly body: string;
}

/** The value of the field `status` of the webhook that starts the calls. A webhook with no field `status` also starts them. */
export const DOWN_STATUS = "down";

/**
 * This function operates the entry: the webhook of the outside check. A request with the wrong token
 * gets 403, and no call starts. A request with a field `status` other than `down` starts no call. Then
 * the first call of each person starts. The reply gives the count of the calls, and no person.
 */
export async function entryFunction(ports: OutagePorts, request: OutageRequest, token: string): Promise<FunctionReply> {
  if (token === "") {
    ports.log("The entry has no token, so it refuses each request.");
    return json(403, { error: "forbidden" });
  }
  if (!tokenMatches(request.params["token"], token)) return json(403, { error: "forbidden" });
  const status = request.params["status"];
  if (status !== undefined && status !== DOWN_STATUS) return json(200, { calls: 0, ignored: "status" });
  const list = await readList(ports);
  if (list === undefined) return json(500, { error: "list" });
  const at = ports.now();
  const step = outageStart(list, request.base, at, await recentOf(ports, list));
  const placed = await apply(ports, list, step, undefined);
  return json(200, { calls: placed.calls });
}

/**
 * This function operates the press Function: the key of the person. A 1 moves the status callback of
 * the live call. When the move fails, the call says the text `unrecorded` in place of the text `confirmed`,
 * because the chain calls again.
 */
export async function pressFunction(ports: OutagePorts, request: OutageRequest): Promise<FunctionReply> {
  const list = await readList(ports);
  if (list === undefined) return twiml(twilioSayTwiml(OUTAGE_TEXTS.unrecorded, 1));
  const step = outagePress(list, request.base, request.params);
  const placed = await apply(ports, list, step, sidOf(request.params));
  const script: CallScript = placed.unrecorded || step.script === undefined ? sayOf(list, outageTexts(list).unrecorded) : step.script;
  return twiml(scriptTwiml(script));
}

/** This function operates the end Function: the status callback at the end of each call. It starts the next call of the chain. */
export async function endedFunction(ports: OutagePorts, request: OutageRequest): Promise<FunctionReply> {
  const list = await readList(ports);
  if (list === undefined) return json(500, { error: "list" });
  const step = outageEnded(list, request.base, request.params, ports.now(), await recentOf(ports, list));
  const placed = await apply(ports, list, step, undefined);
  return json(200, { calls: placed.calls });
}

/** This function gives the TwiML of a script, with the builders of `@procedures/notify/twilio`. */
export function scriptTwiml(script: CallScript): string {
  const voice = { voice: script.voice, language: script.language };
  if (script.kind === "say") return twilioSayTwiml(script.text, 1, voice);
  return twilioGatherTwiml(script.text, { ...voice, action: script.action, method: "POST", digits: 1, repeats: script.repeats, after: script.after });
}

/**
 * This function compares the token of a request with the token of the entry in constant time. It
 * compares the SHA-256 digests, so the time does not show the length of the token either.
 */
export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || expected === "") return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** This function gives the log line of a note. It names the kind and the person, and no number. */
export function noteLine(note: OutageNote): string {
  switch (note.kind) {
    case "capped":
      return `The cap stopped a call of the person ${note.person}.`;
    case "acked":
      return `The person ${note.person} confirmed at step ${note.step}.`;
    case "exhausted":
      return `The chain of the person ${note.person} ended with no confirmation.`;
    case "stale":
      return "The request has no valid cursor of this list, so no call starts.";
    case "open":
      return `The status ${note.status} is not the end of a call, so no step follows.`;
  }
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

async function readList(ports: OutagePorts): Promise<OutageList | undefined> {
  try {
    return await ports.list();
  } catch (error) {
    ports.log(`The read of the list failed: ${errorMessage(error)}`);
    return undefined;
  }
}

// A failed read counts no call. Thus an outage of the Twilio API does not stop the calls of an outage.
async function recentOf(ports: OutagePorts, list: OutageList): Promise<readonly Instant[]> {
  try {
    return await ports.recent(list.maxCalls);
  } catch (error) {
    ports.log(`The read of the recent calls failed, so the cap counts no call: ${errorMessage(error)}`);
    return [];
  }
}

function sidOf(params: Readonly<Record<string, unknown>>): string | undefined {
  const sid = params["CallSid"];
  return typeof sid === "string" && sid !== "" ? sid : undefined;
}

interface Applied {
  readonly calls: number;
  /** True when an `ack` action did not move the status callback. */
  readonly unrecorded: boolean;
}

async function apply(ports: OutagePorts, list: OutageList, step: OutageStep, sid: string | undefined): Promise<Applied> {
  for (const note of step.notes) ports.log(noteLine(note));
  const numbers = list.people.flatMap((person) => [person.to, person.to.replace(/^\+/u, "")]);
  let calls = 0;
  let unrecorded = false;
  for (const action of step.actions) {
    const done = await applyOne(ports, action, sid, numbers);
    if (action.kind === "call" && done) calls += 1;
    if (action.kind === "ack" && !done) unrecorded = true;
  }
  return { calls, unrecorded };
}

async function applyOne(ports: OutagePorts, action: OutageAction, sid: string | undefined, numbers: readonly string[]): Promise<boolean> {
  try {
    if (action.kind === "call") {
      await ports.call({ to: action.to, twiml: scriptTwiml(action.script), statusCallback: action.statusCallback, ringSeconds: action.ringSeconds });
      ports.log(`A call to the person ${action.person} started.`);
      return true;
    }
    if (sid === undefined) {
      ports.log(`The press of the person ${action.person} has no call SID, so the confirmation is not recorded.`);
      return false;
    }
    await ports.move(sid, action.statusCallback);
    ports.log(`The confirmation of the person ${action.person} is recorded.`);
    return true;
  } catch (error) {
    ports.log(`The ${action.kind} action of the person ${action.person} failed: ${redactSecrets(errorMessage(error), numbers, { mark: "[number]" })}`);
    return false;
  }
}

function sayOf(list: OutageList, text: string): CallScript {
  return { kind: "say", text, ...(list.voice === undefined ? {} : { voice: list.voice }), ...(list.language === undefined ? {} : { language: list.language }) };
}

function json(status: number, body: Readonly<Record<string, unknown>>): FunctionReply {
  return { status, type: "application/json", body: JSON.stringify(body) };
}

function twiml(body: string): FunctionReply {
  return { status: 200, type: "text/xml", body };
}
