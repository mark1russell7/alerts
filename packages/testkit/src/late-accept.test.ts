import type { Message, PersonId, ReportId } from "@mark1russell7/alerts";
import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import type { ScriptedRequest } from "@mark1russell7/rigor-testkit/http";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { describe, expect, it } from "vitest";
import { ACCEPT_ARMS, type AcceptArm, type AcceptRecord, acceptGatesOf, acceptVerdictOf, CASE_4_SETTINGS, faultOf } from "./late-accept.ts";
import { ledgerOf, pushoverApi, receiptOf } from "./pushover.ts";

const KEY = "k".repeat(64);
const OTHER = "o".repeat(64);
const MESSAGE: Message = {
  key: KEY,
  person: "person-1" as PersonId,
  level: "life-safety",
  title: "Tornado warning",
  body: "Take shelter now.",
  incident: "report-1" as ReportId,
  quiet: false,
};

const WIRE = { offset: 0, head: 0, body: 0, whole: true };
const send = (connection: number, reply: number, tag = KEY): ScriptedRequest => ({
  connection,
  method: "POST",
  target: "/1/messages.json",
  fields: {},
  body: new URLSearchParams({ priority: "2", tags: tag }).toString(),
  route: 0,
  reply,
  wire: WIRE,
});
const read = (connection: number, index: number): ScriptedRequest => ({
  connection,
  method: "GET",
  target: `/1/receipts/${receiptOf(index)}.json?token=x`,
  fields: {},
  body: "",
  route: 1,
  reply: 0,
  wire: WIRE,
});
const cancel = (connection: number, index: number): ScriptedRequest => ({
  connection,
  method: "POST",
  target: `/1/receipts/${receiptOf(index)}/cancel.json`,
  fields: {},
  body: "",
  route: 2,
  reply: 0,
  wire: WIRE,
});
const tagCancel = (connection: number, tag: string): ScriptedRequest => ({
  connection,
  method: "POST",
  target: `/1/receipts/cancel_by_tag/${tag}.json`,
  fields: {},
  body: "",
  route: -1,
  reply: -1,
  wire: WIRE,
});

const recordOf = (arm: AcceptArm, requests: readonly ScriptedRequest[], extra: Partial<AcceptRecord> = {}): AcceptRecord => {
  const ledger = ledgerOf(requests);
  const last = ledger.messages.findLast((message) => message.readAt !== undefined);
  return {
    arm,
    faulted: true,
    ledger,
    log: { deliveries: last === undefined ? [] : [{ key: KEY, receipt: last.receipt }], acknowledgments: last === undefined ? 0 : 1, cancelled: [] },
    failures: [],
    duplicates: 0,
    passes: 20,
    ...extra,
  };
};

/** One send, its read and its cancel: the requests of an arm with no fault. */
const PROMPT = [send(0, 0), read(0, 0), cancel(0, 0)];
/** The send on connection 0 lost its answer. The send again got the receipt that the system reads. */
const LATE = [send(0, 0), send(1, 1), read(1, 1), cancel(1, 1)];

describe("the scripted Pushover API", () => {
  it("accepts a send, a read and a cancel of the Pushover channel, and the ledger records each", async () => {
    const server = await startScriptedServer(pushoverApi(3));
    try {
      const base = `http://${server.host}:${String(server.port)}`;
      const channel = createPushoverChannel({
        token: "a".repeat(30),
        fetch: (url, init) => {
          const target = new URL(url);
          return fetch(`${base}${target.pathname}${target.search}`, init);
        },
      });
      const sent = await channel.send({ message: MESSAGE, address: { user: "b".repeat(30) } });
      expect(sent).toMatchObject({ ok: true, receipt: { receipt: receiptOf(0) } });
      const receipt = { request: "send-0", receipt: receiptOf(0) };
      expect(await channel.status({ receipt })).toMatchObject({ state: "acknowledged" });
      await channel.cancel({ receipt });
      const tagged = await fetch(`${base}/1/receipts/cancel_by_tag/${KEY}.json`, { method: "POST", body: "token=x" });
      expect(tagged.status).toBe(200);
      const ledger = ledgerOf(server.requests);
      expect(ledger.counts).toEqual({ sends: 1, reads: 1, cancels: 1, tagCancels: 1, other: 0 });
      expect(ledger.messages).toEqual([{ receipt: receiptOf(0), tag: KEY, position: 0, connection: 0, readAt: 1, cancelledAt: 2 }]);
    } finally {
      await server.close();
    }
  });

  it("gives receipts of 30 letters and digits", () => {
    expect(receiptOf(0)).toMatch(/^[A-Za-z0-9]{30}$/);
    expect(receiptOf(11)).toMatch(/^[A-Za-z0-9]{30}$/);
    expect(receiptOf(11)).not.toBe(receiptOf(1));
  });
});

describe("faultOf", () => {
  it("stalls the answer for a late answer and a hang after the accept, and the request for a hang before it", () => {
    expect(faultOf("prompt", CASE_4_SETTINGS)).toBeUndefined();
    expect(faultOf("late-answer", CASE_4_SETTINGS)).toEqual({ connection: 0, direction: "down", at: { byte: 0 }, kind: "stall", ms: CASE_4_SETTINGS.lateMs });
    expect(faultOf("hang-after-accept", CASE_4_SETTINGS)).toMatchObject({ direction: "down", ms: CASE_4_SETTINGS.hangMs });
    expect(faultOf("hang-before-accept", CASE_4_SETTINGS)).toMatchObject({ direction: "up", ms: CASE_4_SETTINGS.hangMs });
  });
});

describe("acceptGatesOf", () => {
  it("passes each gate for one send that the person acknowledged", () => {
    expect(acceptGatesOf(recordOf("prompt", PROMPT))).toEqual({ gates: { delivered: true, single: true, stopped: true }, problems: [] });
  });

  it("fails single and stopped for a lost receipt: the first message repeats after the acknowledgment", () => {
    const result = acceptGatesOf(recordOf("late-answer", LATE));
    expect(result.gates).toEqual({ delivered: true, single: false, stopped: false });
    expect(result.problems.join("\n")).toContain(receiptOf(0));
  });

  it("passes when a cancel by tag reaches the first message before the acknowledgment", () => {
    const fixed = [send(0, 0), tagCancel(1, KEY), send(1, 1), read(1, 1), cancel(1, 1)];
    expect(acceptGatesOf(recordOf("late-answer", fixed)).gates).toEqual({ delivered: true, single: true, stopped: true });
  });

  it("does not count a cancel by tag before the send, or a cancel of another tag", () => {
    const early = [tagCancel(0, KEY), send(0, 0), send(1, 1), read(1, 1)];
    expect(acceptGatesOf(recordOf("late-answer", early)).gates.stopped).toBe(false);
    const other = [send(0, 0), tagCancel(1, OTHER), send(1, 1), read(1, 1)];
    expect(acceptGatesOf(recordOf("late-answer", other)).gates.single).toBe(false);
  });

  it("fails delivered with no accepted message, and when the log names a receipt that the API did not give", () => {
    expect(acceptGatesOf(recordOf("hang-before-accept", [])).gates.delivered).toBe(false);
    const record = recordOf("prompt", PROMPT, { log: { deliveries: [{ key: KEY, receipt: receiptOf(5) }], acknowledgments: 1, cancelled: [] } });
    expect(acceptGatesOf(record).gates.delivered).toBe(false);
  });
});

describe("acceptVerdictOf", () => {
  const good = (arm: AcceptArm): AcceptRecord => recordOf(arm, PROMPT);
  const records = (change: (arm: AcceptArm) => AcceptRecord = good) => ACCEPT_ARMS.map(change);

  it("reads and passes when each arm passes each gate", () => {
    expect(acceptVerdictOf(records())).toMatchObject({ read: true, pass: true, problems: [] });
  });

  it("reads and fails when an arm with a fault loses a receipt", () => {
    const verdict = acceptVerdictOf(records((arm) => (arm === "late-answer" ? recordOf(arm, LATE) : good(arm))));
    expect(verdict.read).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.gates["late-answer"]).toEqual({ delivered: true, single: false, stopped: false });
  });

  it("cannot read when the control arm fails", () => {
    const verdict = acceptVerdictOf(records((arm) => (arm === "prompt" ? recordOf(arm, LATE) : good(arm))));
    expect(verdict).toMatchObject({ read: false, pass: false });
    expect(verdict.problems.join("\n")).toContain("The control arm fails");
  });

  it("cannot read when a fault did not fall at its point, a pass threw, or the sends used each receipt", () => {
    expect(acceptVerdictOf(records((arm) => (arm === "hang-after-accept" ? { ...good(arm), faulted: false } : good(arm)))).read).toBe(false);
    expect(acceptVerdictOf(records((arm) => (arm === "late-answer" ? { ...good(arm), error: "boom" } : good(arm)))).read).toBe(false);
    const many = Array.from({ length: CASE_4_SETTINGS.receipts }, (_, index) => send(index, index));
    expect(acceptVerdictOf(records((arm) => (arm === "prompt" ? recordOf(arm, [...many, read(0, 11)]) : good(arm)))).read).toBe(false);
  });

  it("cannot read when the first accepted send of an arm with a stall of the answer is not on connection 0", () => {
    const moved = [send(1, 0), read(1, 0), cancel(1, 0)];
    expect(acceptVerdictOf(records((arm) => (arm === "late-answer" ? recordOf(arm, moved) : good(arm)))).read).toBe(false);
  });

  it("cannot read with a missing arm or with settings that do not separate the limits", () => {
    expect(acceptVerdictOf(records().slice(1)).read).toBe(false);
    expect(acceptVerdictOf(records(), { ...CASE_4_SETTINGS, lateMs: 500 }).read).toBe(false);
    expect(acceptVerdictOf(records(), { ...CASE_4_SETTINGS, flightLimitMs: 2000 }).read).toBe(false);
    // 7000 ms of flight, a retry and two reads need 10500 ms, and the arm has 10000 ms.
    expect(acceptVerdictOf(records(), { ...CASE_4_SETTINGS, flightLimitMs: 7000 }).read).toBe(false);
    expect(acceptVerdictOf(records(), { ...CASE_4_SETTINGS, hangMs: 5000 }).read).toBe(false);
    expect(acceptVerdictOf(records(), { ...CASE_4_SETTINGS, armMs: 5000, hangMs: 15_000 }).read).toBe(false);
  });
});
