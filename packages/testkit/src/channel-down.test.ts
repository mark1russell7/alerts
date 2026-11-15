import { DELIVERY_TIMES, HEARTBEAT_EVERY } from "@mark1russell7/alerts-runtime";
import type { ScriptedRequest } from "@mark1russell7/rigor-testkit/http";
import { pushoverLedgerOf, pushoverReceiptOf } from "@procedures/notify/testing";
import { describe, expect, it } from "vitest";
import {
  CASE_7_SETTINGS,
  CHANNEL_ARMS,
  CHANNEL_GATES,
  type ChannelArm,
  type ChannelRecord,
  channelFaultOf,
  channelGatesOf,
  channelOutageOf,
  channelPlanOf,
  channelSettingsProblems,
  channelVerdictOf,
  recoverLimit,
} from "./channel-down.ts";

const KEY = "k".repeat(64);
const WIRE = { offset: 0, head: 0, body: 0, whole: true };
const SEND: ScriptedRequest = {
  connection: 0,
  method: "POST",
  target: "/1/messages.json",
  fields: {},
  body: new URLSearchParams({ priority: "2", tags: KEY }).toString(),
  route: 0,
  reply: 0,
  wire: WIRE,
};
const READ: ScriptedRequest = { connection: 0, method: "GET", target: `/1/receipts/${pushoverReceiptOf(0)}.json?token=x`, fields: {}, body: "", route: 1, reply: 0, wire: WIRE };

const OUTAGE_END = CASE_7_SETTINGS.outageMs;
const END = CASE_7_SETTINGS.armMs;

/** The record of an arm that recovers and pings as the gates ask. The changes of a test go in `extra`. */
const recordOf = (arm: ChannelArm, extra: Partial<ChannelRecord> = {}): ChannelRecord => {
  const outage = channelOutageOf(arm);
  const deliveredAt = (outage?.to ?? 0) + 2_000;
  return {
    arm,
    ...(outage === undefined ? {} : { outage }),
    ledger: pushoverLedgerOf([SEND, READ]),
    log: { deliveries: [{ key: KEY, at: deliveredAt, receipt: pushoverReceiptOf(0) }], acknowledgments: 1, cancelled: [] },
    failures: outage === undefined ? [] : [{ at: 0, call: "send", kind: "server", message: "Pushover gave HTTP 500." }],
    pings:
      outage === undefined
        ? [
            { at: 0, kind: "success" },
            { at: HEARTBEAT_EVERY, kind: "success" },
          ]
        : [
            { at: 0, kind: "fail" },
            { at: deliveredAt, kind: "success" },
          ],
    pingErrors: [],
    requests: { sent: 64, inWindow: outage === undefined ? 0 : 60, reached: outage === undefined ? 64 : 4 },
    faults: outage === undefined ? 0 : 60,
    passes: 200,
    lastPassAt: END - 1_000,
    ...extra,
  };
};

const allRecords = (change: Partial<Record<ChannelArm, Partial<ChannelRecord>>> = {}): ChannelRecord[] => CHANNEL_ARMS.map((arm) => recordOf(arm, change[arm]));

describe("the plan of case 7", () => {
  it("gives no fault to the control arm, and one fault of the window from 0 to the end of the outage to each other arm", () => {
    expect(channelFaultOf("control")).toBeUndefined();
    expect(channelPlanOf("control").windows ?? []).toEqual([]);
    expect(channelFaultOf("reset")).toEqual({ window: { from: 0, to: OUTAGE_END }, direction: "up", at: { byte: 0 }, kind: "reset" });
    expect(channelFaultOf("error")).toMatchObject({ kind: "answer", status: 500, at: { frame: 0 } });
    expect(channelFaultOf("unavailable")).toMatchObject({ kind: "answer", status: 503 });
    expect(channelFaultOf("limited")).toMatchObject({ kind: "answer", status: 429 });
  });

  it("has valid settings in CI, and a short arm or a short outage is a problem", () => {
    expect(channelSettingsProblems(CASE_7_SETTINGS)).toEqual([]);
    expect(channelSettingsProblems({ ...CASE_7_SETTINGS, outageMs: HEARTBEAT_EVERY })).toHaveLength(1);
    expect(channelSettingsProblems({ ...CASE_7_SETTINGS, armMs: OUTAGE_END + recoverLimit() })).toHaveLength(1);
  });

  it("takes the retry of the recovery limit from the delivery times of an instance", () => {
    expect(recoverLimit()).toBe(2 * DELIVERY_TIMES.retry + CASE_7_SETTINGS.tickMs);
  });
});

describe("the gates of case 7", () => {
  it("passes each gate of an arm that recovers, with a fail ping in the outage and a success ping last", () => {
    for (const arm of CHANNEL_ARMS) expect(channelGatesOf(recordOf(arm)).gates).toEqual(Object.fromEntries(CHANNEL_GATES.map((gate) => [gate, true])));
  });

  it("fails `told` when the heartbeat gives only success pings in the outage", () => {
    const record = recordOf("error", { pings: [{ at: 0, kind: "success" }, { at: HEARTBEAT_EVERY, kind: "success" }, { at: OUTAGE_END + 2_000, kind: "success" }] });
    const { gates, problems } = channelGatesOf(record);
    expect(gates.told).toBe(false);
    expect(gates.cleared).toBe(true);
    expect(problems.join("\n")).toContain("no fail ping in the outage");
  });

  it("fails `told` for a fail ping after the end of the outage", () => {
    const record = recordOf("reset", { pings: [{ at: OUTAGE_END, kind: "fail" }, { at: OUTAGE_END + 5_000, kind: "success" }] });
    expect(channelGatesOf(record).gates.told).toBe(false);
  });

  it("fails `told` of the control arm for a fail ping with no outage", () => {
    const record = recordOf("control", { pings: [{ at: 0, kind: "fail" }, { at: 5_000, kind: "success" }] });
    expect(channelGatesOf(record).gates.told).toBe(false);
  });

  it("fails `cleared` when the last ping is a fail ping", () => {
    const record = recordOf("limited", { pings: [{ at: 0, kind: "fail" }] });
    expect(channelGatesOf(record).gates.cleared).toBe(false);
  });

  it("fails `recovered` for a first delivery after the recovery limit, and for no delivery", () => {
    const late = OUTAGE_END + recoverLimit() + 1;
    expect(channelGatesOf(recordOf("unavailable", { log: { deliveries: [{ key: KEY, at: late, receipt: pushoverReceiptOf(0) }], acknowledgments: 1, cancelled: [] } })).gates.recovered).toBe(false);
    const none = channelGatesOf(recordOf("unavailable", { log: { deliveries: [], acknowledgments: 0, cancelled: [] } }));
    expect(none.gates.recovered).toBe(false);
    expect(none.gates.delivered).toBe(false);
  });
});

describe("the verdict of case 7", () => {
  it("reads and passes when each arm passes each gate", () => {
    const verdict = channelVerdictOf(allRecords());
    expect(verdict.problems).toEqual([]);
    expect(verdict).toMatchObject({ read: true, pass: true });
  });

  it("reads and fails when one gate of one arm fails", () => {
    const verdict = channelVerdictOf(allRecords({ reset: { pings: [{ at: 0, kind: "success" }, { at: OUTAGE_END + 2_000, kind: "success" }] } }));
    expect(verdict.read).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.gates.reset?.told).toBe(false);
  });

  it("cannot read when a request is lost between the proxy and the server", () => {
    const verdict = channelVerdictOf(allRecords({ error: { requests: { sent: 64, inWindow: 60, reached: 3 } } }));
    expect(verdict.read).toBe(false);
    expect(verdict.pass).toBe(false);
  });

  it("cannot read when an arm with an outage has no fault, or a delivery before the end of the outage", () => {
    expect(channelVerdictOf(allRecords({ limited: { faults: 0, requests: { sent: 4, inWindow: 0, reached: 4 } } })).read).toBe(false);
    const early = { log: { deliveries: [{ key: KEY, at: OUTAGE_END - 1, receipt: pushoverReceiptOf(0) }], acknowledgments: 1, cancelled: [] } };
    expect(channelVerdictOf(allRecords({ unavailable: early })).read).toBe(false);
  });

  it("cannot read when the heartbeat gave no ping, a ping failed, a pass threw or an arm is missing", () => {
    expect(channelVerdictOf(allRecords({ control: { pings: [] } })).read).toBe(false);
    expect(channelVerdictOf(allRecords({ control: { pingErrors: ["The success ping of the heartbeat failed."] } })).read).toBe(false);
    expect(channelVerdictOf(allRecords({ error: { error: "boom" } })).read).toBe(false);
    expect(channelVerdictOf(allRecords().filter((record) => record.arm !== "limited")).read).toBe(false);
  });
});
