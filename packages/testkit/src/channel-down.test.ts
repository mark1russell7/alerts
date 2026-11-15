import { DELIVERY_TIMES, HEARTBEAT_EVERY, PROBE_LIMIT } from "@mark1russell7/alerts-runtime";
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
  STOP_PATH,
  stopProbeOf,
  type TimedRequest,
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

const STOP = `${STOP_PATH}${KEY}.json`;
const timed = (path: string, start: number, status?: number): TimedRequest => ({ path, start, end: start + 50, ...(status === undefined ? {} : { status }) });

/**
 * The 64 requests of an arm. An arm with an outage sends 58 sends and 2 stops in the outage, then a send, a read and
 * 2 stops after it. The first stop after the outage starts 5 s after its end.
 */
const exchangesOf = (outage: { readonly from: number; readonly to: number } | undefined): TimedRequest[] => {
  if (outage === undefined) return Array.from({ length: 64 }, (_, index) => timed(index === 0 ? "/1/messages.json" : `/1/receipts/${pushoverReceiptOf(0)}.json`, index * 10_000, 200));
  const held = Array.from({ length: 60 }, (_, index) => timed(index < 58 ? "/1/messages.json" : STOP, outage.from + index * 10_000));
  const after = [timed("/1/messages.json", outage.to + 1_000, 200), timed(`/1/receipts/${pushoverReceiptOf(0)}.json`, outage.to + 2_000, 200), timed(STOP, outage.to + 5_000, 200), timed(STOP, outage.to + 6_000, 200)];
  return [...held, ...after];
};

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
    exchanges: exchangesOf(outage),
    inFlight: 1,
    maxInFlight: 2,
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
    expect(channelSettingsProblems({ ...CASE_7_SETTINGS, armMs: OUTAGE_END + recoverLimit() })).toContainEqual(expect.stringContaining("the recovery limit"));
    expect(channelSettingsProblems({ ...CASE_7_SETTINGS, armMs: OUTAGE_END + PROBE_LIMIT })).toContainEqual(expect.stringContaining("before the first stop after the outage"));
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

describe("the request gates of case 7", () => {
  it("fails `paced` for more requests in progress than the maxInFlight of the channel, and for no maxInFlight", () => {
    const over = channelGatesOf(recordOf("control", { inFlight: 3 }));
    expect(over.gates.paced).toBe(false);
    expect(over.problems.join("\n")).toContain("3 requests were in progress at one time, more than 2");
    const { maxInFlight, ...none } = recordOf("control");
    expect(maxInFlight).toBe(2);
    expect(channelGatesOf(none).gates.paced).toBe(false);
  });

  it("gives the held stops and the time to the first stop after the outage", () => {
    expect(stopProbeOf(recordOf("reset"))).toEqual({ held: 2, after: 5_000 });
    expect(stopProbeOf(recordOf("control"))).toEqual({ held: 0 });
  });

  it("passes `probed` at PROBE_LIMIT, and fails it after PROBE_LIMIT or with no stop after the outage", () => {
    const at = (start: number) => recordOf("unavailable", { exchanges: [timed(STOP, 1_000), timed(STOP, start, 200)] });
    expect(channelGatesOf(at(OUTAGE_END + PROBE_LIMIT)).gates.probed).toBe(true);
    const late = channelGatesOf(at(OUTAGE_END + PROBE_LIMIT + 1));
    expect(late.gates.probed).toBe(false);
    expect(late.problems.join("\n")).toContain(`the first stop came ${String(PROBE_LIMIT + 1)} ms after the outage`);
    expect(channelGatesOf(recordOf("error", { exchanges: [timed(STOP, 1_000)] })).gates.probed).toBe(false);
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

  it("cannot read when a request has no time, or an arm of the probe held no stop in the outage", () => {
    expect(channelVerdictOf(allRecords({ reset: { exchanges: exchangesOf(channelOutageOf("reset")).slice(1) } })).read).toBe(false);
    const noStop = exchangesOf(channelOutageOf("error")).map((exchange) => (exchange.path === STOP && exchange.start < OUTAGE_END ? { ...exchange, path: "/1/messages.json" } : exchange));
    const verdict = channelVerdictOf(allRecords({ error: { exchanges: noStop } }));
    expect(verdict.read).toBe(false);
    expect(verdict.problems.join("\n")).toContain("error: the outage held no stop");
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
