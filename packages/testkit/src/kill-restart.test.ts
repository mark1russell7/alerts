import type { ScriptedRequest } from "@mark1russell7/rigor-testkit/http";
import { pushoverLedgerOf, pushoverReceiptOf } from "@procedures/notify/testing";
import { describe, expect, it } from "vitest";
import {
  CASE_10_ID,
  CASE_10_SETTINGS,
  KILL_ARMS,
  KILL_GATES,
  type KillArm,
  type KillPoint,
  type KillRecord,
  killFaultOf,
  killGatesOf,
  killVerdictOf,
  type LifeRecord,
  lifeProblemsOf,
  messagesOfLife,
} from "./kill-restart.ts";

const KEY = "k".repeat(64);
const WIRE = { offset: 0, head: 0, body: 0, whole: true };
const seedOf = (arm: KillArm): string => `${CASE_10_ID}-${arm}`;
/** The copy id of copy `n` of a life, as the delivery step makes it: the run id of the life and a count. */
const copyOf = (arm: KillArm, life: number, n = 1): string => `${seedOf(arm)}-${String(life)}-${String(n)}`;

const send = (copy: string, reply: number): ScriptedRequest => ({
  connection: 0,
  method: "POST",
  target: "/1/messages.json",
  fields: {},
  body: new URLSearchParams({ priority: "2", tags: `${KEY},${copy}` }).toString(),
  route: 0,
  reply,
  wire: WIRE,
});
const read = (index: number): ScriptedRequest => ({
  connection: 0,
  method: "GET",
  target: `/1/receipts/${pushoverReceiptOf(index)}.json?token=x`,
  fields: {},
  body: "",
  route: 1,
  reply: 0,
  wire: WIRE,
});
const cancel = (index: number): ScriptedRequest => ({
  connection: 0,
  method: "POST",
  target: `/1/receipts/${pushoverReceiptOf(index)}/cancel.json`,
  fields: {},
  body: "",
  route: 2,
  reply: 0,
  wire: WIRE,
});
const tagCancel = (tag: string): ScriptedRequest => ({
  connection: 0,
  method: "POST",
  target: `/1/receipts/cancel_by_tag/${tag}.json`,
  fields: {},
  body: "",
  route: -1,
  reply: -1,
  wire: WIRE,
});

const lifeOf = (arm: KillArm, life: number, point: KillPoint | "none"): LifeRecord => {
  const run = `${seedOf(arm)}-${String(life)}`;
  const start = { kind: "start", run, at: 0 } as const;
  if (point === "none") return { life, run, point, code: 0, signal: null, timedOut: false, notes: [start, { kind: "end", passes: 20, duplicates: 0, at: 2 }] };
  return { life, run, point, code: null, signal: "SIGKILL", timedOut: false, notes: [start, { kind: "kill", point, at: 1 }] };
};

/** This function gives the record of an arm from the requests of the API and the indexes of the receipts in the log. */
const recordOf = (arm: KillArm, requests: readonly ScriptedRequest[], logged: readonly number[], extra: Partial<KillRecord> = {}): KillRecord => ({
  arm,
  seed: seedOf(arm),
  lives: arm === "control" ? [lifeOf(arm, 1, "none")] : [lifeOf(arm, 1, arm), lifeOf(arm, 2, "none")],
  faulted: true,
  ledger: pushoverLedgerOf(requests),
  log: { deliveries: logged.map((index) => ({ key: KEY, at: 0, receipt: pushoverReceiptOf(index) })), acknowledgments: logged.length > 0 ? 1 : 0, cancelled: [] },
  failures: [],
  ...extra,
});

/** The requests of each arm with no fault of the core. */
const GOOD: Readonly<Record<KillArm, { readonly requests: readonly ScriptedRequest[]; readonly logged: readonly number[] }>> = {
  control: { requests: [send(copyOf("control", 1), 0), read(0), cancel(0)], logged: [0] },
  // The second life stops the open attempt of the first life by its copy id, and sends a new copy.
  "attempt-unsent": { requests: [tagCancel(copyOf("attempt-unsent", 1)), send(copyOf("attempt-unsent", 2), 0), read(0), cancel(0)], logged: [0] },
  "accepted-unlogged": {
    requests: [send(copyOf("accepted-unlogged", 1), 0), tagCancel(copyOf("accepted-unlogged", 1)), send(copyOf("accepted-unlogged", 2), 1), read(1), cancel(1)],
    logged: [1],
  },
  // The log keeps the delivery of the first life. The second life reads its receipt, and sends no copy.
  "logged-unacked": { requests: [send(copyOf("logged-unacked", 1), 0), read(0), cancel(0)], logged: [0] },
  // The proxy answered the first send, thus the API has no copy of the first life.
  backoff: { requests: [tagCancel(copyOf("backoff", 1)), send(copyOf("backoff", 2), 0), read(0), cancel(0)], logged: [0] },
};
const good = (arm: KillArm, extra: Partial<KillRecord> = {}): KillRecord => recordOf(arm, GOOD[arm].requests, GOOD[arm].logged, extra);
const goodRecords = (): KillRecord[] => KILL_ARMS.map((arm) => good(arm));

describe("killFaultOf", () => {
  it("gives HTTP 503 in place of the first send only for backoff", () => {
    expect(killFaultOf("backoff")).toEqual({ connection: 0, direction: "up", at: { frame: 0 }, kind: "answer", status: 503 });
    for (const arm of KILL_ARMS.filter((one) => one !== "backoff")) expect(killFaultOf(arm)).toBeUndefined();
  });
});

describe("messagesOfLife", () => {
  it("gives the messages whose copy id starts with the run id of the life", () => {
    const record = good("accepted-unlogged");
    const [first, second] = record.lives;
    expect(messagesOfLife(record, first ?? { run: "" }).map((m) => m.tags[1])).toEqual([copyOf("accepted-unlogged", 1)]);
    expect(messagesOfLife(record, second ?? { run: "" }).map((m) => m.tags[1])).toEqual([copyOf("accepted-unlogged", 2)]);
  });
});

describe("killGatesOf", () => {
  it("passes each gate of each arm with no fault of the core", () => {
    for (const arm of KILL_ARMS) {
      const result = killGatesOf(good(arm));
      expect(result.problems, arm).toEqual([]);
      for (const gate of KILL_GATES) expect(result.gates[gate], `${arm} ${gate}`).toBe(true);
    }
  });

  it("fails restartOnce, single and stopped when the copy of the first life has no cancel", () => {
    const arm = "accepted-unlogged";
    const result = killGatesOf(recordOf(arm, [send(copyOf(arm, 1), 0), send(copyOf(arm, 2), 1), read(1), cancel(1)], [1]));
    expect(result.gates).toMatchObject({ restartOnce: false, single: false, stopped: false, copyOnce: true });
    expect(result.problems.some((problem) => problem.includes("extra page"))).toBe(true);
  });

  it("fails restartOnce when the last life sends two copies of one key", () => {
    const arm = "attempt-unsent";
    const requests = [tagCancel(copyOf(arm, 1)), send(copyOf(arm, 2, 1), 0), send(copyOf(arm, 2, 2), 1), read(1), cancel(1), cancel(0)];
    const result = killGatesOf(recordOf(arm, requests, [1]));
    expect(result.gates).toMatchObject({ restartOnce: false, copyOnce: true, single: false });
    expect(result.copies).toEqual([[], [copyOf(arm, 2, 1), copyOf(arm, 2, 2)]]);
  });

  it("fails copyOnce when one copy id has two sends", () => {
    const result = killGatesOf(recordOf("control", [send(copyOf("control", 1), 0), send(copyOf("control", 1), 1), read(1), cancel(1), cancel(0)], [1]));
    expect(result.gates.copyOnce).toBe(false);
    expect(result.problems.some((problem) => problem.includes("2 sends"))).toBe(true);
  });

  it("gives the cancelled copies", () => {
    expect(killGatesOf(good("accepted-unlogged")).cancelled).toEqual([copyOf("accepted-unlogged", 1), copyOf("accepted-unlogged", 2)]);
  });
});

describe("lifeProblemsOf", () => {
  it("gives no problem for the lives of each arm with no fault of the core", () => {
    for (const arm of KILL_ARMS) expect(lifeProblemsOf(good(arm)), arm).toEqual([]);
  });

  it("gives a problem when the first life did not end by SIGKILL at its point", () => {
    const arm = "logged-unacked";
    const ended = lifeOf(arm, 1, "none");
    expect(lifeProblemsOf(good(arm, { lives: [{ ...ended, point: arm }, lifeOf(arm, 2, "none")] })).join(" ")).toContain("did not end by SIGKILL");
    const elsewhere = { ...lifeOf(arm, 1, arm), notes: [{ kind: "kill", point: "backoff", at: 1 } as const] };
    expect(lifeProblemsOf(good(arm, { lives: [elsewhere, lifeOf(arm, 2, "none")] })).join(" ")).toContain("did not end by SIGKILL");
  });

  it("gives a problem when a kill arm has no second life, or a life threw or passed its limit", () => {
    const arm = "backoff";
    expect(lifeProblemsOf(good(arm, { lives: [lifeOf(arm, 1, arm)] })).join(" ")).toContain("1 lives");
    const threw: LifeRecord = { ...lifeOf(arm, 2, "none"), code: 1, notes: [{ kind: "error", message: "boom", passes: 1, at: 1 }] };
    expect(lifeProblemsOf(good(arm, { lives: [lifeOf(arm, 1, arm), threw] })).join(" ")).toContain("threw: boom");
    const slow: LifeRecord = { ...lifeOf(arm, 2, "none"), timedOut: true };
    expect(lifeProblemsOf(good(arm, { lives: [lifeOf(arm, 1, arm), slow] })).join(" ")).toContain("time limit");
  });

  it("gives a problem when the API and the log do not show the kill point", () => {
    const unsent = "attempt-unsent";
    expect(lifeProblemsOf(recordOf(unsent, [send(copyOf(unsent, 1), 0), read(0), cancel(0)], [0])).join(" ")).toContain("not none");
    const unlogged = "accepted-unlogged";
    expect(lifeProblemsOf(recordOf(unlogged, [send(copyOf(unlogged, 1), 0), read(0), cancel(0)], [0])).join(" ")).toContain("not 1 with no delivery");
    const unacked = "logged-unacked";
    expect(lifeProblemsOf(recordOf(unacked, [send(copyOf(unacked, 1), 0), read(0), cancel(0)], [])).join(" ")).toContain("not 1 with a delivery");
    expect(lifeProblemsOf(good("backoff", { faulted: false })).join(" ")).toContain("answer 503");
  });

  it("gives a problem when control has two lives or a fault of the proxy", () => {
    expect(lifeProblemsOf(good("control", { lives: [lifeOf("control", 1, "none"), lifeOf("control", 2, "none")] })).join(" ")).toContain("2 lives");
    expect(lifeProblemsOf(good("control", { faulted: false })).join(" ")).toContain("recorded a fault");
  });
});

describe("killVerdictOf", () => {
  it("reads and passes the records of each arm with no fault of the core", () => {
    const verdict = killVerdictOf(goodRecords());
    expect(verdict.problems).toEqual([]);
    expect(verdict).toMatchObject({ read: true, pass: true });
  });

  it("cannot read with a missing arm, an error of an arm or a fault of the control arm", () => {
    expect(killVerdictOf(goodRecords().filter((record) => record.arm !== "backoff"))).toMatchObject({ read: false, pass: false });
    expect(killVerdictOf(goodRecords().map((record) => (record.arm === "logged-unacked" ? { ...record, error: "The proxy did not start." } : record)))).toMatchObject({ read: false, pass: false });
    const control = recordOf("control", [send(copyOf("control", 1), 0)], []);
    const verdict = killVerdictOf(goodRecords().map((record) => (record.arm === "control" ? control : record)));
    expect(verdict).toMatchObject({ read: false, pass: false });
    expect(verdict.problems.some((problem) => problem.includes("cannot read"))).toBe(true);
  });

  it("reads and fails when a kill arm fails a gate", () => {
    const arm = "accepted-unlogged";
    const failed = recordOf(arm, [send(copyOf(arm, 1), 0), send(copyOf(arm, 2), 1), read(1), cancel(1)], [1]);
    const verdict = killVerdictOf(goodRecords().map((record) => (record.arm === arm ? failed : record)));
    expect(verdict).toMatchObject({ read: true, pass: false });
    expect(verdict.results[arm].gates.restartOnce).toBe(false);
  });

  it("cannot read with an arm too short for the second life, or a life limit not longer than the arm", () => {
    expect(killVerdictOf(goodRecords(), { ...CASE_10_SETTINGS, armMs: 5000 }).read).toBe(false);
    expect(killVerdictOf(goodRecords(), { ...CASE_10_SETTINGS, lifeLimitMs: CASE_10_SETTINGS.armMs }).read).toBe(false);
  });

  it("cannot read when the sends used each receipt of the API", () => {
    expect(killVerdictOf(goodRecords(), { ...CASE_10_SETTINGS, receipts: 1 }).read).toBe(false);
  });
});
