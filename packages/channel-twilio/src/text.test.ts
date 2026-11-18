import type { Level, Message, PersonId, ReportId } from "@mark1russell7/alerts";
import type { TwilioFetch, TwilioTextRead } from "@procedures/notify/twilio";
import { memoryQuotaStore, quotaGate, type Quota, type QuotaGate } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import {
  createTwilioTextChannel,
  messageTextOf,
  OUTAGE_TEXT_LIMIT,
  TEXT_CHANNEL_ID,
  textStatusOf,
  TWILIO_CALL_ADDRESS,
  TWILIO_CALL_COST_USD,
  TWILIO_TEXT_COST_USD,
  TWILIO_TEXT_LIMIT,
  twilioSetupProblems,
  twilioTextDescriptor,
  twilioTextOf,
  TWILIO_TEXT_ADDRESS,
  TWILIO_UNSUBSCRIBED,
  type TextOptIn,
  type TwilioSpendGates,
} from "./index.ts";

// Fake credentials and fake numbers: the country code +999 has no country. A test looks for the numbers in each outcome.
const ACCOUNT = `AC${"0".repeat(32)}`;
const CREDENTIALS = { accountSid: ACCOUNT, secret: "fake-secret" };
const FROM = "+99900000003";
const ADDRESS = { to: "+99900000002" };
const SID = `SM${"b".repeat(32)}`;
const AT = Date.UTC(2026, 3, 1, 18, 0);

const message = (level: Level, extra: Partial<Message> = {}): Message => ({
  key: "k".repeat(64),
  person: "person-1" as PersonId,
  level,
  title: "Tornado warning",
  body: "Take shelter now.",
  incident: "report-1" as ReportId,
  quiet: false,
  ...extra,
});

type Answer = { status: number; body: unknown } | Error;

/** A fake Twilio server: it records each request and gives the next answer. */
const server = (...answers: Answer[]) => {
  const calls: Array<{ url: string; method: string; fields: Record<string, string> }> = [];
  const fetch: TwilioFetch = async (url, init) => {
    calls.push({ url, method: init.method, fields: Object.fromEntries(new URLSearchParams(init.body ?? "")) });
    const answer = answers.shift() ?? { status: 500, body: {} };
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => JSON.stringify(answer.body), headers: { get: () => null } };
  };
  return { calls, fetch };
};

// The opt-in of each number, for the tests of the other rules.
const EVERY: TextOptIn = { has: () => true, stopped: () => undefined };

const channelOf = (fake: ReturnType<typeof server>, extra: Partial<Parameters<typeof createTwilioTextChannel>[0]> = {}) =>
  createTwilioTextChannel({ credentials: CREDENTIALS, from: FROM, fetch: fake.fetch, now: () => AT, optIn: EVERY, ...extra });

const accepted: Answer = { status: 201, body: { sid: SID, status: "queued" } };
const NUMBERS = /\+?99900000/u;

describe("the descriptor of the text channel", () => {
  it("sends to the phone of a call, breaks through nothing, and costs no more than a call", () => {
    const descriptor = twilioTextDescriptor();
    expect(descriptor).toMatchObject({ id: TEXT_CHANNEL_ID, breaksThrough: false, repeats: false, ack: "none", maxBody: TWILIO_TEXT_LIMIT, address: TWILIO_CALL_ADDRESS });
    expect(descriptor.dependsOn).toEqual(["provider:twilio", "provider:carrier"]);
    expect(descriptor.services).toEqual(["domain:api.twilio.com"]);
    expect(TWILIO_TEXT_COST_USD).toBeLessThanOrEqual(TWILIO_CALL_COST_USD);
    // The text of the outage call and the text of the channel have one limit.
    expect(OUTAGE_TEXT_LIMIT).toBe(TWILIO_TEXT_LIMIT);
  });

  it("gives the problem of a number of the texts of a bad form, and no value", () => {
    expect(twilioSetupProblems(CREDENTIALS, "+99900000001", FROM)).toEqual([]);
    expect(twilioSetupProblems(CREDENTIALS, "+99900000001", "5550100-bad")).toEqual(["The number that texts is not a phone number in E.164 form."]);
    expect(twilioSetupProblems(CREDENTIALS, "+99900000001")).toEqual([]);
  });
});

describe("the map of a message to a text", () => {
  it("gives the title, the why line and the body as sentences, from the number of the texts", () => {
    const text = twilioTextOf(message("urgent", { why: "Why: Place A is in the area" }), ADDRESS, AT, { from: FROM });
    expect(text).toEqual({ to: ADDRESS.to, from: FROM, body: "Tornado warning. Why: Place A is in the area. Take shelter now." });
  });

  it("cuts a long message at the end of a word, with the limit of code points and a stop", () => {
    const text = twilioTextOf(message("urgent", { body: "word ".repeat(100) }), ADDRESS, AT, { from: FROM });
    if ("refused" in text) throw new Error(text.refused);
    expect([...text.body].length).toBeLessThanOrEqual(TWILIO_TEXT_LIMIT);
    expect(text.body.endsWith("word.")).toBe(true);
    // A text of one long word has no space for the cut. The cut keeps a code point for the stop.
    const one = messageTextOf(message("urgent", { title: "x".repeat(400), body: "" }), TWILIO_TEXT_LIMIT);
    expect([...one].length).toBe(TWILIO_TEXT_LIMIT);
    expect(one.endsWith("x.")).toBe(true);
    // A cut counts code points, not UTF-16 units.
    const wide = messageTextOf(message("urgent", { title: "🌪".repeat(400), body: "" }), TWILIO_TEXT_LIMIT);
    expect([...wide].length).toBe(TWILIO_TEXT_LIMIT);
  });

  it("refuses a quiet message, an expired message, a bad address and an empty message, and no refusal holds the address", () => {
    const refusals = [
      twilioTextOf(message("urgent", { quiet: true }), ADDRESS, AT, { from: FROM }),
      twilioTextOf(message("urgent", { expires: AT }), ADDRESS, AT, { from: FROM }),
      twilioTextOf(message("urgent"), { to: "5550100-bad" }, AT, { from: FROM }),
      twilioTextOf(message("urgent"), {}, AT, { from: FROM }),
      twilioTextOf(message("urgent", { title: " ", body: "" }), ADDRESS, AT, { from: FROM }),
    ];
    expect(refusals.map((refusal) => ("kind" in refusal ? refusal.kind : undefined))).toEqual(["quiet", "expired", undefined, undefined, undefined]);
    for (const refusal of refusals.slice(2)) expect(refusal).toEqual({ refused: expect.any(String) });
    expect(refusals.map((refusal) => ("refused" in refusal ? refusal.refused : ""))).not.toContainEqual(expect.stringMatching(/5550100|\+999/u));
  });
});

describe("the send of a text", () => {
  it("posts the text to the Messages resource of the account, and gives the SID as the receipt", async () => {
    const fake = server(accepted);
    const outcome = await channelOf(fake).send({ message: message("urgent"), address: ADDRESS });
    expect(outcome).toEqual({ ok: true, receipt: { text: SID }, accepted: AT });
    expect(fake.calls).toEqual([
      {
        url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages.json`,
        method: "POST",
        fields: { To: ADDRESS.to, From: FROM, Body: "Tornado warning. Take shelter now." },
      },
    ]);
  });

  it("refuses a quiet message and a bad account SID with no request", async () => {
    const fake = server(accepted);
    expect(await channelOf(fake).send({ message: message("urgent", { quiet: true }), address: ADDRESS })).toMatchObject({ ok: false, kind: "quiet" });
    expect(await channelOf(fake).send({ message: message("urgent", { expires: AT }), address: ADDRESS })).toMatchObject({ ok: false, kind: "expired" });
    const bad = channelOf(fake, { credentials: { accountSid: "AC-bad", secret: "fake-secret" } });
    expect(await bad.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: false, kind: "auth" });
    expect(fake.calls).toEqual([]);
  });

  it("gives a refusal of Twilio with a mark in place of each number, and no number", async () => {
    const quoted = `The 'To' number ${ADDRESS.to} is not valid. The number ${FROM.slice(1)} is not a sender.`;
    const fake = server({ status: 400, body: { code: 21211, message: quoted } });
    const outcome = await channelOf(fake).send({ message: message("urgent"), address: ADDRESS });
    if (outcome.ok) throw new Error("The send did not fail.");
    expect(outcome.kind).toBe("refused");
    expect(outcome.message).toContain("[number]");
    expect(outcome.message).toContain("Twilio error 21211");
    expect(outcome.message).not.toMatch(NUMBERS);
  });

  it("sends no text to a number with no opt-in: the kind is consent, Twilio gets no request, and the cap takes no units", async () => {
    const QUOTA: Quota = { name: "Twilio spend", limit: 20, reserve: 0, window: { kind: "calendar", unit: "month", timeZone: "UTC" } };
    const store = memoryQuotaStore();
    const gate = quotaGate(QUOTA, { key: "twilio:account", store, now: () => AT });
    const asked: Array<[string, number]> = [];
    const optIn: TextOptIn = { has: (number, at) => (asked.push([number, at]), false), stopped: () => undefined };
    const fake = server(accepted);
    const outcome = await channelOf(fake, { optIn, spend: { gate, lifeSafety: gate, units: 4 } }).send({ message: message("life-safety"), address: ADDRESS });
    expect(outcome).toEqual({ ok: false, kind: "consent", message: "The number is not on the opt-in list, or it replied STOP. The channel sent no text." });
    expect(asked).toEqual([[ADDRESS.to, AT]]);
    expect(fake.calls).toEqual([]);
    expect(gate.state().used).toBe(0);
  });

  it("records the STOP of a number that Twilio refuses as unsubscribed, gives consent, and gives the units back", async () => {
    const QUOTA: Quota = { name: "Twilio spend", limit: 20, reserve: 0, window: { kind: "calendar", unit: "month", timeZone: "UTC" } };
    const gate = quotaGate(QUOTA, { key: "twilio:account", store: memoryQuotaStore(), now: () => AT });
    const stops: Array<[string, number]> = [];
    const optIn: TextOptIn = { has: () => true, stopped: (number, at) => void stops.push([number, at]) };
    const fake = server({ status: 400, body: { code: TWILIO_UNSUBSCRIBED, message: `Attempt to send to unsubscribed recipient ${ADDRESS.to}` } }, { status: 400, body: { code: 21211, message: "Invalid To" } });
    const channel = channelOf(fake, { optIn, spend: { gate, lifeSafety: gate, units: 4 } });
    const outcome = await channel.send({ message: message("urgent"), address: ADDRESS });
    expect(outcome).toEqual({ ok: false, kind: "consent", message: "The number replied STOP, and Twilio refuses each text to it (Twilio error 21610)." });
    expect(stops).toEqual([[ADDRESS.to, AT]]);
    expect(gate.state().used).toBe(0);
    // Another refusal of Twilio is not a STOP.
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: false, kind: "refused" });
    expect(stops).toHaveLength(1);
    // The address of a text needs the opt-in. The address of a call does not.
    expect(twilioTextDescriptor().address).toEqual(TWILIO_TEXT_ADDRESS);
    expect(TWILIO_TEXT_ADDRESS.map((field) => field.optIn)).toEqual([true]);
    expect(TWILIO_CALL_ADDRESS.map((field) => field.optIn)).toEqual([undefined]);
  });

  it("takes the units of a text from the gate of its level, and gives them back when Twilio sends no text", async () => {
    const QUOTA: Quota = { name: "Twilio spend", limit: 20, reserve: 8, window: { kind: "calendar", unit: "month", timeZone: "UTC" } };
    const store = memoryQuotaStore();
    const spend: TwilioSpendGates = {
      gate: quotaGate(QUOTA, { key: "twilio:account", store, now: () => AT }),
      lifeSafety: quotaGate({ ...QUOTA, reserve: 0 }, { key: "twilio:account", store, now: () => AT }),
      units: 4,
    };
    const used = (gate: QuotaGate): number => gate.state().used;
    const fake = server(accepted, { status: 401, body: { code: 20003, message: "Authenticate" } }, accepted, accepted, accepted, accepted);
    const channel = channelOf(fake, { spend });
    const send = (level: Level) => channel.send({ message: message(level), address: ADDRESS });
    expect(await send("urgent")).toMatchObject({ ok: true });
    // Twilio did not authorize the text, so it sent nothing. The units go back.
    expect(await send("urgent")).toMatchObject({ ok: false, kind: "auth" });
    expect(used(spend.gate)).toBe(4);
    expect(await send("urgent")).toMatchObject({ ok: true });
    expect(await send("urgent")).toMatchObject({ ok: true });
    // The last 8 units are the reserve: only life-safety takes them.
    expect(await send("urgent")).toMatchObject({ ok: false, kind: "reserved" });
    expect(await send("life-safety")).toMatchObject({ ok: true });
    expect(await send("life-safety")).toMatchObject({ ok: true });
    expect(await send("life-safety")).toMatchObject({ ok: false, kind: "rate-limited" });
    expect(used(spend.lifeSafety)).toBe(20);
    // A refused take makes no request.
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(6);
  });

  it("does not take a whole count of units of 0 or less", () => {
    const store = memoryQuotaStore();
    const QUOTA: Quota = { name: "Twilio spend", limit: 20, reserve: 0, window: { kind: "calendar", unit: "month", timeZone: "UTC" } };
    const gate = quotaGate(QUOTA, { key: "twilio:account", store, now: () => AT });
    expect(() => channelOf(server(), { spend: { gate, lifeSafety: gate, units: 0 } })).toThrow("whole count above 0");
  });
});

describe("the status of a text", () => {
  const read = (status: string, extra: Partial<TwilioTextRead> = {}): TwilioTextRead => ({
    ok: true,
    sid: SID,
    status,
    state: status === "delivered" || status === "read" ? "delivered" : status === "failed" || status === "undelivered" || status === "canceled" ? "failed" : "pending",
    ...extra,
  });

  it("gives delivered, failed and accepted from the state of the read", () => {
    expect(textStatusOf(read("delivered", { updatedAt: AT + 5 }), AT + 10)).toEqual({ state: "delivered", at: AT + 5, reason: "The carrier delivered the text." });
    expect(textStatusOf(read("undelivered", { errorCode: 30003 }), AT)).toEqual({ state: "failed", at: AT, reason: "The text did not reach the phone (undelivered, Twilio error 30003)." });
    expect(textStatusOf(read("sent"), AT)).toEqual({ state: "accepted", at: AT });
  });

  it("reads the text of the receipt, and keeps accepted for a receipt with no SID or a failed read", async () => {
    const fake = server({ status: 200, body: { sid: SID, status: "delivered", date_updated: "Wed, 01 Apr 2026 18:00:05 +0000" } }, new Error("socket hang up"));
    const channel = channelOf(fake);
    expect(await channel.status({ receipt: { text: SID } })).toEqual({ state: "delivered", at: AT + 5_000, reason: "The carrier delivered the text." });
    expect(fake.calls[0]).toMatchObject({ url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages/${SID}.json`, method: "GET" });
    expect(await channel.status({ receipt: { text: SID } })).toMatchObject({ state: "accepted", reason: expect.stringContaining("The text was not read") });
    expect(await channel.status({ receipt: {} })).toEqual({ state: "accepted", at: AT, reason: "The receipt has no message SID." });
    expect(await channel.status({ receipt: { text: "SM-bad" } })).toMatchObject({ state: "accepted", reason: expect.stringContaining("The receipt is not valid") });
    expect(fake.calls).toHaveLength(2);
  });

  it("cancels nothing, and makes no request", async () => {
    const fake = server();
    await channelOf(fake).cancel({ receipt: { text: SID } });
    expect(fake.calls).toEqual([]);
  });
});

describe("the probe of the text channel", () => {
  it("reads the balance of the account and sends no text", async () => {
    const fake = server({ status: 200, body: { balance: "12.5", currency: "USD", account_sid: CREDENTIALS.accountSid } });
    expect(await channelOf(fake).probe?.()).toEqual({ ok: true, at: AT });
    expect(fake.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(fake.calls[0]?.url).toMatch(/\/Balance\.json$/u);
  });
});
