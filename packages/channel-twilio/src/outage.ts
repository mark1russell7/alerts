/**
 * The outage call: the chain of calls of each person when the instance is down. The outside check of
 * the instance starts it with a webhook. The instance is down then, so a Function on the server of
 * Twilio operates the chain, and the Function has no state.
 *
 * - The state of each try is in the URLs of its callbacks: the outage, the person, the step and the version of the list.
 * - A key press of 1 is the confirmation. The press handler moves the status callback of the live call to a URL with `acked=1`.
 * - The end of each call gives the next step by `chainNext` of the core.
 * - A chain that ends with no confirmation sends one text to the person when the list has `textMessage` and the person has `text`. Thus a missed call leaves a message.
 * - A callback of another version of the list starts no try. Thus a deploy during an outage stops its chains.
 *
 * Each handler is pure. It gives the script of the call as data and the actions of the Function as data.
 * The Function renders the script with the TwiML builders of `@procedures/notify/twilio`, and applies the actions.
 */

import {
  addressProblems,
  chainNext,
  channelIdSchema,
  durationSchema,
  personIdSchema,
  schemaOf,
  type ChainState,
  type Duration,
  type Instant,
  type PersonId,
  type TryChain,
  type TryEnd,
} from "@mark1russell7/alerts";
import { localTime, monthOf } from "@mark1russell7/algebra/clock";
import { z } from "zod";
// The descriptor module, not `index.ts`: the bundle of each Function then holds no send code of the channel.
import { CHANNEL_ID, TWILIO_TEXT_LIMIT, twilioCallDescriptor } from "./descriptor.ts";

/** One person of the outage call: the phone number and the chain of tries. Each step of the chain is a call. */
export interface OutagePerson {
  readonly person: PersonId;
  /** The phone number in E.164 form. */
  readonly to: string;
  readonly chain: TryChain;
  /** True: the number is on the opt-in list of the texts, thus the person gets the text of the list. The default is false. */
  readonly text?: boolean;
}

/** The texts of the outage call. */
export interface OutageTexts {
  /** The text after the message of the outage. It asks for the key press. */
  readonly prompt: string;
  /** The text after a key press of 1. */
  readonly confirmed: string;
  /** The text at the end of a call with no key press. */
  readonly noPress: string;
  /** The text after a key press of 1 when the Function cannot record the confirmation. The chain then calls again. */
  readonly unrecorded: string;
}

/** The default texts of the outage call. */
export const OUTAGE_TEXTS: OutageTexts = {
  prompt: "Press 1 to confirm.",
  confirmed: "Confirmed. Thank you. No more calls follow for this outage.",
  noPress: "No confirmation. The next call follows.",
  unrecorded: "The system did not record the confirmation. The next call follows.",
};

/**
 * The monthly cap of the outage call: the most calls of the Twilio number in one calendar month. Each call of the number
 * counts, also a call of the instance. Thus a call of the outage call does not take the calls of the month above the cap.
 */
export interface OutageMonthCap {
  /** The most calls in one calendar month. */
  readonly maxCalls: number;
  /** The IANA time zone of the start of the month, as in the spend entry of the provider: for example `America/Chicago`. */
  readonly timeZone: string;
}

/** The highest monthly cap of calls. One read of the calls list gives at most this count of calls. */
export const OUTAGE_MONTH_MAX = 1000;

/**
 * The most code points of the text message of an outage.
 *
 * - A text of this length has at most 3 segments, also in UCS-2.
 * - One segment in the United States costs at most 1.4 cents with the carrier fee, from the price page of Twilio.
 * - Thus one text costs no more than one call, and each cap counts a text as one call.
 */
export const OUTAGE_TEXT_LIMIT: number = TWILIO_TEXT_LIMIT;

/** The list of the outage call. The deploy of the Function copies it from the private configuration. */
export interface OutageList {
  /** The version of the list, for example the content hash of the list. A callback of another version starts no try. */
  readonly version: string;
  /** The message of the outage that each call says before the prompt. */
  readonly message: string;
  /** The people, in the order of the calls of a start. */
  readonly people: readonly OutagePerson[];
  /** The count of the times that a call says the message before it ends with no key press. */
  readonly repeats: number;
  /** The seconds that a phone rings before the call ends with no answer. */
  readonly ringSeconds: number;
  /** The most calls in the time `capWindow`. A text counts as one call. A try above the cap makes no call. */
  readonly maxCalls: number;
  readonly capWindow: Duration;
  /** The monthly cap of the calls of the Twilio number. A text counts as one call. A try above the cap makes no call. */
  readonly month: OutageMonthCap;
  /**
   * The text message to a person after the chain of the person ends with no confirmation: `OUTAGE_TEXT_LIMIT` code points or fewer.
   * Without it, the outage call sends no text. The deploy sets it only when the secrets name a sender of texts.
   */
  readonly textMessage?: string;
  /** The voice of the text, for example `Polly.Joanna`. Without it, Twilio uses its default voice. */
  readonly voice?: string;
  /** The language of the text, for example `en-US`. */
  readonly language?: string;
  /** The texts of the call. Each absent text is the text of `OUTAGE_TEXTS`. */
  readonly texts?: Partial<OutageTexts>;
}

/**
 * This schema checks the JSON of a list: the fields and their types. The Function reads the list with it.
 * Then `outageListProblems` checks the rules of the values.
 */
export const outageListSchema: z.ZodType<OutageList, OutageList> = schemaOf<OutageList>()(
  z.strictObject({
    version: z.string(),
    message: z.string(),
    people: z
      .array(
        z
          .strictObject({ person: personIdSchema, to: z.string(), chain: z.strictObject({ steps: z.array(channelIdSchema).readonly() }).readonly(), text: z.boolean().exactOptional() })
          .readonly(),
      )
      .readonly(),
    repeats: z.number(),
    ringSeconds: z.number(),
    maxCalls: z.number(),
    capWindow: durationSchema,
    month: z.strictObject({ maxCalls: z.number(), timeZone: z.string() }).readonly(),
    textMessage: z.string().exactOptional(),
    voice: z.string().exactOptional(),
    language: z.string().exactOptional(),
    texts: z
      .strictObject({
        prompt: z.string().exactOptional(),
        confirmed: z.string().exactOptional(),
        noPress: z.string().exactOptional(),
        unrecorded: z.string().exactOptional(),
      })
      .readonly()
      .exactOptional(),
  }).readonly(),
);

/** The most rounds of a key press that is not 1. After them, the call ends with no confirmation. */
export const MAX_PRESS_ROUNDS = 3;

/** The paths of the three Functions. The entry is public and checks its own token. The press and end Functions are protected: Twilio signs each request to them. */
export const OUTAGE_PATHS = { entry: "/outage", press: "/press", ended: "/ended" } as const;

/** The state of one try in the URLs of its callbacks. */
export interface OutageCursor {
  /** The time of the start of the outage chains. It is the id of the outage. */
  readonly outage: Instant;
  /** The index of the person in the list. */
  readonly person: number;
  /** The step of the chain of the person. */
  readonly step: number;
  /** The round of the key press in the call. */
  readonly round: number;
}

/** The voice of a script. */
export interface ScriptVoice {
  readonly voice?: string;
  readonly language?: string;
}

/**
 * The script of a call, as data.
 * - `gather`: the call says `text` `repeats` times and waits for one key. A key goes to `action`. With no key, the call says `after` and ends.
 * - `say`: the call says `text` and ends.
 */
export type CallScript =
  | ({ readonly kind: "gather"; readonly text: string; readonly action: string; readonly repeats: number; readonly after: string } & ScriptVoice)
  | ({ readonly kind: "say"; readonly text: string } & ScriptVoice);

/**
 * An action of the Function.
 * - `call`: the Function starts a call to `to` with the script, and sets the status callback of the call.
 * - `ack`: the Function moves the status callback of the live call to `statusCallback`, before it replies.
 * - `text`: the Function sends the text message `body` to `to`.
 */
export type OutageAction =
  | { readonly kind: "call"; readonly person: PersonId; readonly to: string; readonly script: CallScript; readonly statusCallback: string; readonly ringSeconds: number }
  | { readonly kind: "ack"; readonly person: PersonId; readonly statusCallback: string }
  | { readonly kind: "text"; readonly person: PersonId; readonly to: string; readonly body: string };

/**
 * A note of a handler for the log of the Function.
 * - `capped`: a cap stopped a try of the person. The cap `window` is the cap of `capWindow`, and the cap `month` is the monthly cap.
 * - `text-capped`: a cap stopped the text to the person after the chain.
 * - `acked` and `exhausted`: the chain of the person ended.
 * - `stale`: the callback has no valid cursor, or the cursor has another version of the list.
 * - `open`: the status is not the end of a call, so no step follows.
 */
export type OutageNote =
  | { readonly kind: "capped"; readonly person: PersonId; readonly cap: "window" | "month" }
  | { readonly kind: "text-capped"; readonly person: PersonId; readonly cap: "window" | "month" }
  | { readonly kind: "acked"; readonly person: PersonId; readonly step: number }
  | { readonly kind: "exhausted"; readonly person: PersonId }
  | { readonly kind: "stale" }
  | { readonly kind: "open"; readonly status: string };

/** The result of a handler. The Function applies the actions in order, and then replies with the script. */
export interface OutageStep {
  readonly actions: readonly OutageAction[];
  readonly script?: CallScript;
  readonly notes: readonly OutageNote[];
}

/**
 * This function gives the result of the webhook of the outside check: the first call of each person.
 * `recent` holds the times of the calls and the texts of the Twilio numbers, from the lists of Twilio. A send in
 * the time `capWindow` before `at` counts against the cap. A send in the calendar month of `at` counts against the monthly cap.
 */
export function outageStart(list: OutageList, base: string, at: Instant, recent: readonly Instant[]): OutageStep {
  let sends = callCounts(list, at, recent);
  const actions: OutageAction[] = [];
  const notes: OutageNote[] = [];
  list.people.forEach((person, index) => {
    const state = chainNext(person.chain);
    const tried = tryOf(list, base, person, { outage: at, person: index, step: 0, round: 0 }, state, sends);
    notes.push(...tried.notes);
    actions.push(...tried.actions);
    sends = { window: sends.window + tried.actions.length, month: sends.month + tried.actions.length };
  });
  return { actions, notes };
}

/**
 * This function gives the result of a key press. A 1 gives the confirmation: the `ack` action and the
 * confirmed text. Another key gives the prompt again, for at most `MAX_PRESS_ROUNDS` rounds. A press
 * with no valid cursor gives no action, because no chain knows the call. The call then says the confirmed
 * text for a 1, and the message for another key.
 */
export function outagePress(list: OutageList, base: string, params: Readonly<Record<string, unknown>>): OutageStep {
  const texts = outageTexts(list);
  const cursor = parseCursor(params, list.version);
  const person = cursor === undefined ? undefined : list.people[cursor.person];
  if (cursor === undefined || person === undefined) return { actions: [], script: say(list, params["Digits"] === "1" ? texts.confirmed : list.message), notes: [{ kind: "stale" }] };
  if (params["Digits"] === "1") {
    return { actions: [{ kind: "ack", person: person.person, statusCallback: urlOf(base, OUTAGE_PATHS.ended, cursor, list.version, true) }], script: say(list, texts.confirmed), notes: [] };
  }
  const round = cursor.round + 1;
  if (round >= MAX_PRESS_ROUNDS) return { actions: [], script: say(list, texts.noPress), notes: [] };
  return { actions: [], script: gather(list, base, { ...cursor, round }), notes: [] };
}

/**
 * This function gives the result of the status callback at the end of a call. The result is the next
 * call of the chain of the person, or no call. A `completed` call with `acked=1` is confirmed. A `completed`
 * call with no press, `busy` and `no-answer` are unconfirmed. `failed` and `canceled` are failed.
 * A chain that ends with no confirmation gives the text of the list to the person, when the caps permit it.
 */
export function outageEnded(list: OutageList, base: string, params: Readonly<Record<string, unknown>>, at: Instant, recent: readonly Instant[]): OutageStep {
  const cursor = parseCursor(params, list.version);
  const person = cursor === undefined ? undefined : list.people[cursor.person];
  if (cursor === undefined || person === undefined) return { actions: [], notes: [{ kind: "stale" }] };
  const status = typeof params["CallStatus"] === "string" ? params["CallStatus"] : "";
  const end = callEnd(status, params["acked"] === "1");
  if (end === undefined) return { actions: [], notes: [{ kind: "open", status }] };
  const state = chainNext(person.chain, cursor.step, end);
  return tryOf(list, base, person, { ...cursor, round: 0 }, state, callCounts(list, at, recent));
}

/** This function maps the final status of a Twilio call and the flag of a key press to the end of the try. A status that is not final gives `undefined`. */
export function callEnd(status: string, acked: boolean): TryEnd | undefined {
  switch (status) {
    case "completed":
      return acked ? "acked" : "unconfirmed";
    case "busy":
    case "no-answer":
      return "unconfirmed";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * This function checks a list of the outage call. It finds these problems:
 *
 * - an empty version or message, or a text that a call cannot say
 * - a bad phone number, or a step on another channel
 * - two entries of one person
 * - an empty SMS message, an SMS message above `OUTAGE_TEXT_LIMIT` code points, or a control character in it
 * - a bad count, or a cap below the calls and the texts of one outage
 * - a monthly cap with a time zone that is not an IANA time zone.
 *
 * Each problem names ids and fields, and no number.
 */
export function outageListProblems(list: OutageList): string[] {
  const problems: string[] = [];
  const descriptor = twilioCallDescriptor();
  if (list.version.trim() === "") problems.push("The list has no version.");
  const texts = outageTexts(list);
  for (const [field, text] of [["message", list.message], ["prompt", texts.prompt], ["confirmed", texts.confirmed], ["noPress", texts.noPress], ["unrecorded", texts.unrecorded]] as const) {
    if (text.trim() === "") problems.push(`The text ${field} is empty.`);
    if (UNSPEAKABLE.test(text)) problems.push(`The text ${field} has a control character, and TwiML cannot hold it.`);
  }
  if (`${list.message} ${texts.prompt}`.length > descriptor.maxBody) problems.push(`The message and the prompt have more than ${descriptor.maxBody} characters.`);
  if (list.textMessage !== undefined) {
    if (list.textMessage.trim() === "") problems.push("The SMS message is empty.");
    if ([...list.textMessage].length > OUTAGE_TEXT_LIMIT) problems.push(`The SMS message has more than ${OUTAGE_TEXT_LIMIT} code points, so one text can cost more than one call.`);
    if (UNSPEAKABLE.test(list.textMessage)) problems.push("The SMS message has a control character.");
  }
  const seen = new Set<string>();
  for (const person of list.people) {
    if (seen.has(person.person)) problems.push(`The list has the person ${person.person} two times.`);
    seen.add(person.person);
    for (const problem of addressProblems({ to: person.to }, descriptor)) problems.push(`The person ${person.person}: ${problem}`);
    if (person.chain.steps.length === 0) problems.push(`The chain of the person ${person.person} has no step, so no call reaches the person.`);
    person.chain.steps.forEach((channel, index) => {
      if (channel !== CHANNEL_ID) problems.push(`Step ${index} of the person ${person.person} uses the channel ${channel}. The outage call makes only calls on ${CHANNEL_ID}.`);
    });
  }
  if (list.people.length === 0) problems.push("The list has no person, so no outage call reaches a person.");
  if (!isCount(list.repeats, 1, 5)) problems.push("The repeats are not a whole number from 1 to 5.");
  if (!isCount(list.ringSeconds, 5, 600)) problems.push("The ring seconds are not a whole number from 5 to 600.");
  if (!isCount(list.maxCalls, 1, 1000)) problems.push("The cap of calls is not a whole number from 1 to 1000.");
  if (!(list.capWindow > 0)) problems.push("The time of the cap is not more than 0.");
  const perOutage = outageSends(list);
  const sends = list.textMessage === undefined ? "calls" : "calls and texts";
  if (list.maxCalls < perOutage) problems.push(`The cap of ${list.maxCalls} calls is below the ${perOutage} ${sends} of one outage, so the cap stops tries of one outage.`);
  // The monthly cap comes from the private cap of the spend. Thus its problems name no count.
  if (!isCount(list.month.maxCalls, 1, OUTAGE_MONTH_MAX)) problems.push(`The monthly cap of calls is not a whole number from 1 to ${OUTAGE_MONTH_MAX}.`);
  else if (list.month.maxCalls < perOutage) problems.push(`The monthly cap of calls is below the ${sends} of one outage, so the cap stops tries of one outage.`);
  if (localTime(0, list.month.timeZone) === undefined) problems.push("The time zone of the monthly cap is not an IANA time zone.");
  return problems;
}

/** This function gives the most sends of one outage: each step of each chain. With an SMS message, each person also gets one text. */
export function outageSends(list: Pick<OutageList, "people" | "textMessage">): number {
  const calls = list.people.reduce((sum, person) => sum + person.chain.steps.length, 0);
  return list.textMessage === undefined ? calls : calls + list.people.filter((person) => person.text === true).length;
}

/** This function gives the query of a cursor, with the version of the list. */
export function cursorQuery(cursor: OutageCursor, version: string, acked = false): URLSearchParams {
  const query = new URLSearchParams({ outage: String(cursor.outage), person: String(cursor.person), step: String(cursor.step), round: String(cursor.round), list: version });
  if (acked) query.set("acked", "1");
  return query;
}

/**
 * This function reads a cursor from the parameters of a request. Each field must be a whole number in
 * decimal with no sign, and the version must be the version of the list. Else it gives `undefined`.
 */
export function parseCursor(params: Readonly<Record<string, unknown>>, version: string): OutageCursor | undefined {
  if (params["list"] !== version) return undefined;
  const outage = wholeOf(params["outage"]);
  const person = wholeOf(params["person"]);
  const step = wholeOf(params["step"]);
  const round = wholeOf(params["round"]);
  if (outage === undefined || person === undefined || step === undefined || round === undefined) return undefined;
  return { outage, person, step, round };
}

// A control character other than tab, line feed and carriage return is not valid in XML 1.0.
const UNSPEAKABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

const WHOLE = /^(?:0|[1-9][0-9]{0,15})$/;

function wholeOf(value: unknown): number | undefined {
  if (typeof value !== "string" || !WHOLE.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function isCount(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** This function gives the texts of a list: each text of the list, and the default text for each absent text. */
export function outageTexts(list: OutageList): OutageTexts {
  return { ...OUTAGE_TEXTS, ...list.texts };
}

function voiceOf(list: OutageList): ScriptVoice {
  return { ...(list.voice === undefined ? {} : { voice: list.voice }), ...(list.language === undefined ? {} : { language: list.language }) };
}

function say(list: OutageList, text: string): CallScript {
  return { kind: "say", text, ...voiceOf(list) };
}

function gather(list: OutageList, base: string, cursor: OutageCursor): CallScript {
  const texts = outageTexts(list);
  return { kind: "gather", text: `${list.message} ${texts.prompt}`, action: urlOf(base, OUTAGE_PATHS.press, cursor, list.version), repeats: list.repeats, after: texts.noPress, ...voiceOf(list) };
}

function urlOf(base: string, path: string, cursor: OutageCursor, version: string, acked = false): string {
  const url = new URL(path, base);
  url.search = cursorQuery(cursor, version, acked).toString();
  return url.toString();
}

const DAY = 24 * 60 * 60_000;

/** The counts of the recent sends for the two caps: the calls and the texts. */
interface CallCounts {
  readonly window: number;
  readonly month: number;
}

// A send in the time `capWindow` before `at` counts for the cap of the window. A send from the start of the month counts for the monthly cap.
// A name that is not a time zone gives the start 31 days before `at`. Thus the cap then counts more calls, not fewer.
function callCounts(list: OutageList, at: Instant, recent: readonly Instant[]): CallCounts {
  const from = monthOf(at, list.month.timeZone)?.start ?? at - 31 * DAY;
  return {
    window: recent.filter((time) => time > at - list.capWindow && time <= at).length,
    month: recent.filter((time) => time >= from && time <= at).length,
  };
}

// The cap that a new send breaks, or `undefined` when both caps permit it.
function capOf(list: OutageList, sends: CallCounts): "window" | "month" | undefined {
  if (sends.window >= list.maxCalls) return "window";
  if (sends.month >= list.month.maxCalls) return "month";
  return undefined;
}

// The try of the state: a call when the chain tries and the caps permit it. A chain with no confirmation at its end gives the text.
function tryOf(list: OutageList, base: string, person: OutagePerson, cursor: OutageCursor, state: ChainState, sends: CallCounts): OutageStep {
  if (state.kind === "acked") return { actions: [], notes: [{ kind: "acked", person: person.person, step: state.step }] };
  if (state.kind === "exhausted") return textOf(list, person, sends);
  const cap = capOf(list, sends);
  if (cap !== undefined) return { actions: [], notes: [{ kind: "capped", person: person.person, cap }] };
  const at = { ...cursor, step: state.step };
  return {
    actions: [{ kind: "call", person: person.person, to: person.to, script: gather(list, base, at), statusCallback: urlOf(base, OUTAGE_PATHS.ended, at, list.version), ringSeconds: list.ringSeconds }],
    notes: [],
  };
}

// The end of a chain with no confirmation: the note, and the text of the list when the caps permit it.
function textOf(list: OutageList, person: OutagePerson, sends: CallCounts): OutageStep {
  const exhausted: OutageNote = { kind: "exhausted", person: person.person };
  if (list.textMessage === undefined || person.text !== true) return { actions: [], notes: [exhausted] };
  const cap = capOf(list, sends);
  if (cap !== undefined) return { actions: [], notes: [exhausted, { kind: "text-capped", person: person.person, cap }] };
  return { actions: [{ kind: "text", person: person.person, to: person.to, body: list.textMessage }], notes: [exhausted] };
}
