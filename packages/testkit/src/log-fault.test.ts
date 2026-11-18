import { DELIVERY_TIMES, HEARTBEAT_EVERY, heartbeatGap } from "@mark1russell7/alerts-runtime";
import type { PushoverLedger, PushoverLedgerMessage } from "@procedures/notify/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ARM_LOCK_GATES,
  BOOT_GATES,
  bootGatesOf,
  bootProblemsOf,
  type BootGate,
  type BootRecord,
  CASE_12_GAP,
  CASE_12_ID,
  CASE_12_INTERVAL,
  CASE_12_LOOP,
  CASE_12_SETTINGS,
  LOCK_ARMS,
  lockGatesOf,
  lockOf,
  lockProblemsOf,
  type LockArm,
  type LockGate,
  type LockRecord,
  logFaultSettingsProblems,
  logFaultVerdictOf,
  type LogFaultRun,
  runLogFaults,
} from "./log-fault.ts";

const TICK = CASE_12_SETTINGS.tickMs;
const LOCK = CASE_12_SETTINGS.lockMs;
const LONG = CASE_12_SETTINGS.longLockMs;
const CAP = CASE_12_LOOP.retryCap;
const POLL = DELIVERY_TIMES.pollEvery;
const RECEIPT = "r".padEnd(30, "0");
const BUSY = "database is locked";

const message = (position: number, copy = "copy-1"): PushoverLedgerMessage => ({
  receipt: RECEIPT,
  priority: 2,
  tags: ["key", copy],
  position,
  connection: 0,
  readAt: position + 1,
});

const ledgerOf = (messages: readonly PushoverLedgerMessage[]): PushoverLedger => ({
  messages,
  counts: { sends: messages.length, reads: messages.length, cancels: 0, tagCancels: 0, validates: 0, limits: 0, other: 0 },
});

/**
 * A record of an arm that passes each gate. The lock starts at 0. After the lock, the send comes at the next pass,
 * one wait before the cap, and the read of the receipt one poll later.
 */
function recordOf(arm: LockArm): LockRecord {
  const plan = lockOf(arm);
  const to = plan?.ms ?? 0;
  const next = plan === undefined ? 0 : to + CAP - 20_000;
  // In busy-delivery, the send goes in the lock at 0. The delivery row comes after the lock.
  const sent = arm === "busy-delivery" ? 0 : next;
  return {
    arm,
    seed: `${CASE_12_ID}-${arm}`,
    times: CASE_12_LOOP,
    ...(plan === undefined ? {} : { lock: { type: plan.type, from: 0, to } }),
    passes: 20,
    requests: [sent, next + POLL],
    ledger: ledgerOf([message(0)]),
    log: { deliveries: [{ key: "key", at: sent, receipt: RECEIPT }], acknowledgments: 1, cancelled: [] },
    attempts: ["copy-1"],
    deliveries: [next],
    pings: [{ at: next, kind: "success" }],
    pingErrors: [],
    loopErrors: plan === undefined ? [] : [{ at: 0, message: BUSY }],
  };
}

const goodRecords = (): LockRecord[] => LOCK_ARMS.map((arm) => recordOf(arm));

/** A record of broken-at-boot that passes each gate: the second life keeps the broken file, salvages the log and reports the loss. */
function bootOf(): BootRecord {
  const first = ["e1", "e2", "e3"];
  return {
    arm: "broken-at-boot",
    seed: `${CASE_12_ID}-broken-at-boot`,
    first: { run: "life-1", fromRequest: 0, passes: 7, loopErrors: [], ids: first, reports: [] },
    broken: { page: 3, pageSize: 4096, ok: false, problems: ["Page 3: btreeInitPage() returns error code 11"], ids: first },
    second: { run: "life-2", fromRequest: 2, passes: 7, loopErrors: [], ids: [...first, "e4"], reports: ["The log file was broken. It is in quarantine, and the runtime salvaged 3 events."] },
    ledger: ledgerOf([message(0)]),
    requests: [0, POLL],
    log: { deliveries: [{ key: "key", at: 0, receipt: RECEIPT }], acknowledgments: 1, cancelled: [] },
    files: ["runtime.sqlite", "runtime.sqlite.broken-20260401T180300Z/runtime.sqlite"],
    kept: "runtime.sqlite.broken-20260401T180300Z/runtime.sqlite",
  };
}

/** The record of broken-at-boot with the fault AL-50: no file is kept, each write of the second life throws, and no report names the loss. */
function al50Of(): BootRecord {
  const good = bootOf();
  const { kept: _kept, ...rest } = good;
  const second = good.second ?? rest.first;
  return {
    ...rest,
    files: ["runtime.sqlite"],
    second: { ...second, ids: good.first.ids, reports: [], loopErrors: [{ at: 180_000, message: "database disk image is malformed" }] },
  };
}

const gatesOf = (record: LockRecord): Readonly<Partial<Record<LockGate, boolean>>> => lockGatesOf(record).gates;
const allTrue = (gates: readonly string[]): Record<string, boolean> => Object.fromEntries(gates.map((gate) => [gate, true]));

describe("the times of case 12", () => {
  it("are the times of an instance with the IPAWS source", () => {
    expect(CASE_12_INTERVAL).toBe(60_000);
    expect(CASE_12_LOOP).toEqual({ passLimit: CASE_12_INTERVAL + 2 * DELIVERY_TIMES.callLimit, retryBase: DELIVERY_TIMES.retry, retryCap: CASE_12_INTERVAL });
    expect(CASE_12_GAP).toBe(heartbeatGap(CASE_12_LOOP));
  });

  it("has a long lock that is longer than the gap of the heartbeat, and a short lock that is not", () => {
    expect(CASE_12_SETTINGS.longLockMs).toBeGreaterThan(CASE_12_GAP);
    expect(CASE_12_SETTINGS.lockMs).toBeLessThan(CASE_12_GAP);
  });

  it("has valid settings", () => {
    expect(logFaultSettingsProblems(CASE_12_SETTINGS)).toEqual([]);
  });

  it("finds each problem of the settings", () => {
    expect(logFaultSettingsProblems({ ...CASE_12_SETTINGS, lockMs: CASE_12_LOOP.retryBase })[0]).toMatch(/not longer than the first wait/);
    expect(logFaultSettingsProblems({ ...CASE_12_SETTINGS, longLockMs: CASE_12_GAP })[0]).toMatch(/gap of the heartbeat/);
    expect(logFaultSettingsProblems({ ...CASE_12_SETTINGS, armMs: LONG })[0]).toMatch(/The arm/);
    expect(logFaultSettingsProblems({ ...CASE_12_SETTINGS, longLockMs: 1_200_000, armMs: 2_000_000 })[0]).toMatch(/escalation/);
    expect(logFaultSettingsProblems({ ...CASE_12_SETTINGS, tickMs: CASE_12_LOOP.retryBase })[0]).toMatch(/The tick/);
    expect(logFaultSettingsProblems({ ...CASE_12_SETTINGS, busyTimeoutMs: 0 })[0]).toMatch(/busy timeout/);
    expect(logFaultSettingsProblems({ ...CASE_12_SETTINGS, bootLifeMs: POLL })[0]).toMatch(/broken-at-boot/);
  });
});

describe("lockOf", () => {
  it("gives the lock of each arm", () => {
    expect(lockOf("control")).toBeUndefined();
    expect(lockOf("busy-attempt")).toEqual({ type: "attempt", ms: LOCK });
    expect(lockOf("busy-delivery")).toEqual({ type: "delivery", ms: LOCK });
    expect(lockOf("busy-long")).toEqual({ type: "attempt", ms: LONG });
  });
});

describe("lockGatesOf", () => {
  for (const arm of LOCK_ARMS) {
    it(`passes each gate of ${arm} on a good record`, () => {
      expect(lockGatesOf(recordOf(arm))).toEqual({ gates: allTrue(ARM_LOCK_GATES[arm]), problems: [] });
    });
  }

  it("fails noThrow in control when a pass threw", () => {
    const result = lockGatesOf({ ...recordOf("control"), loopErrors: [{ at: 0, message: BUSY }] });
    expect(result.gates.noThrow).toBe(false);
    expect(result.problems).toEqual([`control: a pass threw at 0 ms: ${BUSY}`]);
  });

  it("fails noSendLocked when a send goes in the lock", () => {
    const record = recordOf("busy-attempt");
    expect(gatesOf({ ...record, requests: [LOCK, LOCK + POLL] }).noSendLocked).toBe(false);
    expect(gatesOf({ ...record, requests: [LOCK + TICK, LOCK + POLL] }).noSendLocked).toBe(true);
  });

  it("fails noPingLocked when a ping goes in the lock", () => {
    const record = recordOf("busy-delivery");
    expect(gatesOf({ ...record, pings: [{ at: LOCK / 2, kind: "success" }, ...record.pings] }).noPingLocked).toBe(false);
  });

  it("holds the send after the lock to one cap and one tick", () => {
    const record = recordOf("busy-attempt");
    expect(gatesOf({ ...record, requests: [LOCK + CAP + TICK, LOCK + CAP + POLL] }).promptAfter).toBe(true);
    const late = lockGatesOf({ ...record, requests: [LOCK + CAP + TICK + 1, LOCK + CAP + POLL] });
    expect(late.gates.promptAfter).toBe(false);
    expect(late.problems).toEqual([`busy-attempt: the first send after the lock was due by ${String(LOCK + CAP + TICK)} ms, and it came at ${String(LOCK + CAP + TICK + 1)} ms.`]);
  });

  it("reads the delivery row, not the send, for promptAfter in busy-delivery", () => {
    const record = recordOf("busy-delivery");
    expect(gatesOf({ ...record, deliveries: [] }).promptAfter).toBe(false);
    expect(gatesOf({ ...record, deliveries: [LOCK + CAP + TICK + 1] }).promptAfter).toBe(false);
  });

  it("holds the first success ping after the long lock to one heartbeat interval and one tick", () => {
    const record = recordOf("busy-long");
    expect(gatesOf({ ...record, pings: [{ at: LONG + HEARTBEAT_EVERY + TICK, kind: "success" }] }).pingAfter).toBe(true);
    expect(gatesOf({ ...record, pings: [{ at: LONG + 1000, kind: "fail" }, { at: LONG + HEARTBEAT_EVERY + TICK + 1, kind: "success" }] }).pingAfter).toBe(false);
  });

  it("fails copyOnce and oneCopy on a second send of the copy, and attempted on a send with no attempt row", () => {
    const record = recordOf("busy-attempt");
    const twice = lockGatesOf({ ...record, requests: [...record.requests, LOCK + CAP], ledger: ledgerOf([message(0), message(2)]) });
    expect(twice.gates.copyOnce).toBe(false);
    expect(twice.gates.oneCopy).toBe(false);
    expect(gatesOf({ ...record, attempts: ["copy-2"] }).attempted).toBe(false);
  });

  it("fails each gate of the lock when the lock has no end", () => {
    const record = recordOf("busy-long");
    const { lock } = record;
    if (lock === undefined) throw new Error("The record has no lock.");
    const gates = gatesOf({ ...record, lock: { type: lock.type, from: lock.from } });
    expect([gates.noSendLocked, gates.noPingLocked, gates.promptAfter, gates.pingAfter]).toEqual([false, false, false, false]);
  });
});

describe("lockProblemsOf", () => {
  it("finds no problem in a good record", () => {
    for (const record of goodRecords()) expect(lockProblemsOf(record), record.arm).toEqual([]);
  });

  it("cannot read a lock that did not fall, did not end, or gave no busy error", () => {
    const record = recordOf("busy-attempt");
    const { lock: _lock, ...unlocked } = record;
    expect(lockProblemsOf(unlocked)).toEqual(["busy-attempt: the lock of the plan (at the first attempt row) did not fall."]);
    expect(lockProblemsOf({ ...record, lock: { type: "attempt", from: 0 } })).toEqual(["busy-attempt: the lock from 0 ms did not end in the arm."]);
    expect(lockProblemsOf({ ...record, loopErrors: [] })).toEqual([`busy-attempt: no pass threw in the lock from 0 ms to ${String(LOCK)} ms.`]);
    expect(lockProblemsOf({ ...record, loopErrors: [{ at: 0, message: "disk I/O error" }] })[0]).toMatch(/does not name a lock/);
  });

  it("cannot read with no ping, an error of a ping, other loop times or a lock in control", () => {
    const record = recordOf("control");
    expect(lockProblemsOf({ ...record, pings: [] })).toEqual(["control: the heartbeat gave no ping."]);
    expect(lockProblemsOf({ ...record, pingErrors: ["The success ping of the heartbeat got the status 500."] })).toHaveLength(1);
    expect(lockProblemsOf({ ...record, times: { ...CASE_12_LOOP, retryCap: 3_600_000 } })[0]).toMatch(/loop times/);
    expect(lockProblemsOf({ ...record, lock: { type: "attempt", from: 0, to: LOCK } })).toEqual(["control: the arm has a lock, and it has none in the plan."]);
  });
});

describe("bootGatesOf", () => {
  it("passes each gate on a good record", () => {
    expect(bootGatesOf(bootOf())).toEqual({ gates: allTrue(BOOT_GATES), problems: [] });
  });

  it("fails bootOk, kept and lossReported with the fault AL-50, and keeps salvaged and noPageAgain", () => {
    const { gates } = bootGatesOf(al50Of());
    const want: Record<BootGate, boolean> = { bootOk: false, kept: false, salvaged: true, noPageAgain: true, lossReported: false };
    expect(gates).toEqual(want);
  });

  it("fails noPageAgain on a send of the second life, salvaged on a lost event, and lossReported on two reports", () => {
    const good = bootOf();
    const second = good.second;
    if (second === undefined) throw new Error("The record has no second life.");
    expect(bootGatesOf({ ...good, ledger: ledgerOf([message(0), message(2, "copy-2")]) }).gates.noPageAgain).toBe(false);
    expect(bootGatesOf({ ...good, second: { ...second, ids: ["e1", "e2"] } }).gates.salvaged).toBe(false);
    expect(bootGatesOf({ ...good, second: { ...second, reports: [...second.reports, "The quarantine holds 1 file."] } }).gates.lossReported).toBe(false);
  });
});

describe("bootProblemsOf", () => {
  it("finds no problem in a good record or in the record of AL-50", () => {
    expect(bootProblemsOf(bootOf())).toEqual([]);
    expect(bootProblemsOf(al50Of())).toEqual([]);
  });

  it("cannot read a break that did not fall, a file with no problem, or a first life with two sends", () => {
    const good = bootOf();
    const { broken, ...unbroken } = good;
    if (broken === undefined) throw new Error("The record has no break.");
    expect(bootProblemsOf(unbroken)).toEqual(["broken-at-boot: the break of the file did not fall."]);
    expect(bootProblemsOf({ ...good, broken: { ...broken, ok: true } })[0]).toMatch(/found no problem/);
    expect(bootProblemsOf({ ...good, broken: { ...broken, ids: ["e1"] } })[0]).toMatch(/changed the table/);
    expect(bootProblemsOf({ ...good, ledger: ledgerOf([message(0), message(1, "copy-2")]) })[0]).toMatch(/sent 2 copies/);
  });
});

describe("logFaultVerdictOf", () => {
  it("reads and passes on good records", () => {
    const verdict = logFaultVerdictOf(goodRecords(), bootOf());
    expect(verdict.problems).toEqual([]);
    expect(verdict.read).toBe(true);
    expect(verdict.pass).toBe(true);
  });

  it("reads and does not pass with the fault AL-50", () => {
    const verdict = logFaultVerdictOf(goodRecords(), al50Of());
    expect(verdict.read).toBe(true);
    expect(verdict.pass).toBe(false);
  });

  it("cannot read when control fails a gate or a record is missing", () => {
    const failed = goodRecords().map((record) => (record.arm === "control" ? { ...record, attempts: [] } : record));
    expect(logFaultVerdictOf(failed, bootOf()).read).toBe(false);
    const missing = logFaultVerdictOf(
      goodRecords().filter((record) => record.arm !== "busy-long"),
      bootOf(),
    );
    expect(missing.read).toBe(false);
    expect(missing.results["busy-long"].gates.pingAfter).toBe(false);
  });
});

// The real case: the runtime, its loop, its heartbeat, the Pushover channel and the scripted API, on a fake clock, with
// the log in a SQLite file. It takes no real time other than the work of each pass and each busy timeout.
describe("runLogFaults", () => {
  let run: LogFaultRun | undefined;
  const gateOf = (arm: LockArm, gate: LockGate): boolean | undefined => run?.verdict.results[arm].gates[gate];
  const bootGate = (gate: BootGate): boolean | undefined => run?.verdict.boot.gates[gate];

  beforeAll(async () => {
    run = await runLogFaults();
    // The record goes to the log of CI. The prediction wirelab-al13-case12 reads it.
    console.log(`${CASE_12_ID} ${JSON.stringify(run)}`);
  }, 600_000);

  it("reads: each arm completed, each fault fell, and control passed each gate", () => {
    expect(run?.verdict.read, run?.verdict.problems.join("\n")).toBe(true);
  });

  for (const arm of LOCK_ARMS) {
    it(`passes each gate of ${arm}`, () => {
      for (const gate of ARM_LOCK_GATES[arm]) expect(gateOf(arm, gate), gate).toBe(true);
    });
  }

  it("reads broken-at-boot: the first life delivered once, and the break fell", () => {
    expect(run === undefined ? ["The case did not start."] : bootProblemsOf(run.boot)).toEqual([]);
  });

  // The fix of AL-50 (alerts #157): the open of main.ts keeps the broken file in quarantine, salvages the log and reports
  // the loss. The prediction wirelab-al13-case12-boot states each gate.
  it("broken-at-boot: each gate", () => {
    for (const gate of BOOT_GATES) expect(bootGate(gate), gate).toBe(true);
  });
});
