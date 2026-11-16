import { DELIVERY_TIMES } from "@mark1russell7/alerts-runtime";
import type { PushoverLedger, PushoverLedgerMessage } from "@procedures/notify/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ARM_STEP_GATES,
  CASE_11_ID,
  CASE_11_INTERVAL,
  CASE_11_SETTINGS,
  dueActionsOf,
  namesSize,
  runClockStep,
  sizeForms,
  STEP_ARMS,
  stepGatesOf,
  stepOf,
  stepSettingsProblems,
  stepVerdictOf,
  type StepArm,
  type StepGate,
  type StepPassNote,
  type StepRecord,
  type StepRun,
  type StepSystemEvent,
} from "./clock-step.ts";

const POLL = DELIVERY_TIMES.pollEvery;
const RETRY = DELIVERY_TIMES.retry;
const BACK = CASE_11_SETTINGS.backMs;
const RECEIPT = "r".padEnd(30, "0");

const message = (position: number, readAt?: number, cancelledAt?: number): PushoverLedgerMessage => ({
  receipt: RECEIPT,
  priority: 2,
  tags: ["key", "run-1"],
  position,
  connection: 0,
  ...(readAt === undefined ? {} : { readAt }),
  ...(cancelledAt === undefined ? {} : { cancelledAt }),
});

const ledgerOf = (messages: readonly PushoverLedgerMessage[]): PushoverLedger => ({
  messages,
  counts: { sends: messages.length, reads: 1, cancels: 1, tagCancels: 0, validates: 0, limits: 0, other: 0 },
});

const note = (at: number, fields: Partial<StepPassNote> = {}): StepPassNote => ({ at, wall: at, sent: 0, acknowledged: 0, cancelled: 0, overdue: 0, failures: [], ...fields });

/** One system event with one report that names the size of the step. */
const seenOf = (size: number, at: number): StepSystemEvent[] => [{ at, reports: [{ kind: "system.health.clock", text: `The wall clock stepped by ${sizeForms(size)[0] ?? ""}.` }] }];

/**
 * A record of an arm that passes each gate. Each due action comes at its due time. `late` holds the due action of the
 * arm by that time, as AL-49 does.
 */
function recordOf(arm: StepArm, late = 0): StepRecord {
  const planned = stepOf(arm);
  const size = planned?.size ?? 0;
  const base = {
    arm,
    seed: `${CASE_11_ID}-${arm}`,
    faulted: true,
    log: { deliveries: [{ key: "key", at: 0, receipt: RECEIPT }], acknowledgments: 1, cancelled: ["key"] },
    loopErrors: [],
  };
  if (arm === "back-retry") {
    // The first send fails at 0. Its retry is due one retry later.
    const sent = RETRY + late;
    return {
      ...base,
      step: { point: "send-failure", size, at: 0, events: 4 },
      passes: [note(0, { failures: [{ call: "send", kind: "server", message: "HTTP 503", retryIn: RETRY }] }), note(sent, { sent: 1 }), note(sent + POLL, { acknowledged: 1, cancelled: 1 })],
      fetches: [0],
      requests: [sent, sent + POLL, sent + POLL],
      ledger: ledgerOf([message(0, 1, 2)]),
      system: seenOf(size, sent),
    };
  }
  // The delivery comes at 0. The read and the cancel come one poll later, and the second fetch one interval later.
  const read = POLL + (arm === "back-poll" || arm === "forward-poll" || arm === "control" ? late : 0);
  const fetched = CASE_11_INTERVAL + (arm === "back-fetch" || arm === "control" ? late : 0);
  const stepAt = arm === "back-fetch" ? read : 0;
  return {
    ...base,
    ...(planned === undefined ? {} : { step: { point: planned.point, size, at: stepAt, events: 4 } }),
    passes: [note(0, { sent: 1 }), note(read, { acknowledged: 1, cancelled: 1 }), note(fetched)],
    fetches: [0, fetched],
    requests: [0, read, read],
    ledger: ledgerOf([message(0, 1, 2)]),
    system: planned === undefined ? [] : seenOf(size, stepAt + 1),
  };
}

const goodRecords = (): StepRecord[] => STEP_ARMS.map((arm) => recordOf(arm));

describe("the plan of case 11", () => {
  it("steps the wall clock back in three arms, forward in one, and not in control", () => {
    expect(STEP_ARMS.map((arm) => stepOf(arm))).toEqual([
      undefined,
      { point: "delivery", size: -BACK },
      { point: "delivery", size: CASE_11_SETTINGS.forwardMs },
      { point: "send-failure", size: -BACK },
      { point: "cancel", size: -BACK },
    ]);
  });

  it("gives stepSeen only to an arm with a step, and oneCopy and noOverdue only to an arm with no fault of the API", () => {
    for (const arm of STEP_ARMS) {
      expect(ARM_STEP_GATES[arm].includes("stepSeen")).toBe(stepOf(arm) !== undefined);
      expect(ARM_STEP_GATES[arm].includes("oneCopy")).toBe(arm === "control" || arm === "forward-poll");
    }
  });

  it("has valid settings in CI", () => {
    expect(stepSettingsProblems(CASE_11_SETTINGS)).toEqual([]);
  });

  it("finds each setting that cannot read", () => {
    expect(stepSettingsProblems({ ...CASE_11_SETTINGS, backMs: 1500 })).toHaveLength(1);
    expect(stepSettingsProblems({ ...CASE_11_SETTINGS, forwardMs: 30 * 60_000 })).toHaveLength(1);
    expect(stepSettingsProblems({ ...CASE_11_SETTINGS, armMs: BACK })).toHaveLength(1);
    expect(stepSettingsProblems({ ...CASE_11_SETTINGS, tickMs: 1000 })).toHaveLength(1);
  });
});

describe("the size of a step in a report", () => {
  it("has the forms of seconds, minutes and hours", () => {
    expect(sizeForms(-BACK)).toEqual(["3600 s", "60 min", "1 h"]);
    expect(sizeForms(600_000)).toEqual(["600 s", "10 min"]);
    expect(sizeForms(90_000)).toEqual(["90 s"]);
  });

  it("matches a whole number with its unit only", () => {
    expect(namesSize("The wall clock went back 1 h.", -BACK)).toBe(true);
    expect(namesSize("A step of 3600 s.", -BACK)).toBe(true);
    expect(namesSize("A step of 13600 s.", -BACK)).toBe(false);
    expect(namesSize("A step of 3600 sec.", -BACK)).toBe(false);
    expect(namesSize("No fetch passed in 600 s.", 600_000)).toBe(true);
    expect(namesSize("No fetch passed in 1600 s.", 600_000)).toBe(false);
  });
});

describe("the due actions of case 11", () => {
  it("gives the read and the fetch of control, and the action of each step arm", () => {
    expect(dueActionsOf(recordOf("control"))).toEqual([
      { action: "read", due: POLL, at: POLL },
      { action: "fetch", due: CASE_11_INTERVAL, at: CASE_11_INTERVAL },
    ]);
    expect(dueActionsOf(recordOf("back-poll"))).toEqual([{ action: "read", due: POLL, at: POLL }]);
    expect(dueActionsOf(recordOf("back-retry"))).toEqual([{ action: "send", due: RETRY, at: RETRY }]);
    expect(dueActionsOf(recordOf("back-fetch"))).toEqual([{ action: "fetch", due: CASE_11_INTERVAL, at: CASE_11_INTERVAL }]);
  });

  it("gives the time of a late action, and no time of an action that did not come", () => {
    expect(dueActionsOf(recordOf("back-fetch", BACK))).toEqual([{ action: "fetch", due: CASE_11_INTERVAL, at: CASE_11_INTERVAL + BACK }]);
    const missing = { ...recordOf("back-fetch"), fetches: [0] };
    expect(dueActionsOf(missing)).toEqual([{ action: "fetch", due: CASE_11_INTERVAL }]);
  });
});

describe("the gates of case 11", () => {
  it("passes each gate of each arm for a record with no fault", () => {
    for (const arm of STEP_ARMS) {
      const result = stepGatesOf(recordOf(arm));
      expect(result.problems).toEqual([]);
      expect(Object.keys(result.gates).sort()).toEqual([...ARM_STEP_GATES[arm]].sort());
      for (const gate of ARM_STEP_GATES[arm]) expect(result.gates[gate], `${arm} ${gate}`).toBe(true);
    }
  });

  it("fails prompt for an action that comes one step late, and only prompt", () => {
    for (const arm of ["back-poll", "back-retry", "back-fetch"] as const) {
      const result = stepGatesOf(recordOf(arm, BACK));
      expect(result.gates.prompt, arm).toBe(false);
      expect(result.problems.join(" "), arm).toContain(`${String(BACK)} ms late`);
      for (const gate of ARM_STEP_GATES[arm].filter((g) => g !== "prompt")) expect(result.gates[gate], `${arm} ${gate}`).toBe(true);
    }
  });

  it("passes prompt for an action within the slack", () => {
    expect(stepGatesOf(recordOf("back-poll", CASE_11_SETTINGS.slackMs)).gates.prompt).toBe(true);
    expect(stepGatesOf(recordOf("back-poll", CASE_11_SETTINGS.slackMs + 1)).gates.prompt).toBe(false);
  });

  it("fails stepSeen with no report of the step, and with two reports", () => {
    const record = recordOf("back-poll");
    expect(stepGatesOf({ ...record, system: [] }).gates.stepSeen).toBe(false);
    const twice = [...record.system, ...seenOf(-BACK, 5000)];
    expect(stepGatesOf({ ...record, system: twice }).gates.stepSeen).toBe(false);
    const other = [{ at: 1, reports: [{ kind: "system.health.clock", text: "The wall clock stepped." }] }];
    expect(stepGatesOf({ ...record, system: other }).gates.stepSeen).toBe(false);
  });

  it("fails copyOnce for two sends of one copy, and oneCopy and noOverdue in forward-poll", () => {
    const record = recordOf("forward-poll");
    const twice = stepGatesOf({ ...record, ledger: ledgerOf([message(0, 2, 3), message(1, 2, 3)]) });
    expect([twice.gates.copyOnce, twice.gates.oneCopy]).toEqual([false, false]);
    const overdue = stepGatesOf({ ...record, passes: [...record.passes, note(200_000, { overdue: 1 })] });
    expect(overdue.gates.noOverdue).toBe(false);
  });

  it("fails noThrow for a pass that threw", () => {
    const result = stepGatesOf({ ...recordOf("back-poll"), loopErrors: [{ at: POLL, message: "The fold went back." }] });
    expect(result.gates.noThrow).toBe(false);
    expect(result.problems).toContain(`back-poll: a pass threw at ${String(POLL)} ms: The fold went back.`);
  });
});

describe("the verdict of case 11", () => {
  it("reads and passes when each arm passes each gate", () => {
    const verdict = stepVerdictOf(goodRecords());
    expect(verdict.problems).toEqual([]);
    expect([verdict.read, verdict.pass]).toEqual([true, true]);
  });

  it("reads and fails when a back arm holds its action by the step", () => {
    const records = goodRecords().map((record) => (record.arm === "back-poll" ? recordOf("back-poll", BACK) : record));
    const verdict = stepVerdictOf(records);
    expect([verdict.read, verdict.pass]).toEqual([true, false]);
    expect(verdict.results["back-poll"].gates.prompt).toBe(false);
  });

  it("cannot read when control fails a gate", () => {
    const records = goodRecords().map((record) => (record.arm === "control" ? recordOf("control", BACK) : record));
    expect(stepVerdictOf(records).read).toBe(false);
  });

  it("cannot read when a step did not fall at its point", () => {
    const early = goodRecords().map((record) => (record.arm === "back-fetch" ? { ...record, step: { point: "cancel" as const, size: -BACK, at: CASE_11_INTERVAL + 1, events: 4 } } : record));
    expect(stepVerdictOf(early).problems).toContain("back-fetch: 2 fetches came before the step, not 1.");
    // The record of control has no step. As the record of back-poll, its step did not fall.
    const none = goodRecords().map((record) => (record.arm === "back-poll" ? { ...recordOf("control"), arm: "back-poll" as const } : record));
    expect(stepVerdictOf(none).problems).toContain(`back-poll: the step of the plan (${String(-BACK)} ms at delivery) did not fall.`);
  });

  it("cannot read with no answer 503 in back-retry, an arm that threw, or a record that is missing", () => {
    const unfaulted = goodRecords().map((record) => (record.arm === "back-retry" ? { ...record, faulted: false } : record));
    expect(stepVerdictOf(unfaulted).read).toBe(false);
    const threw = goodRecords().map((record) => (record.arm === "forward-poll" ? { ...record, error: "The proxy did not start." } : record));
    expect(stepVerdictOf(threw).read).toBe(false);
    const missing = stepVerdictOf(goodRecords().filter((record) => record.arm !== "back-poll"));
    expect(missing.read).toBe(false);
    expect(missing.results["back-poll"].gates.prompt).toBe(false);
  });
});

// The real case: the runtime, its loop, the Pushover channel, the proxy and the scripted API, on fake clocks. It takes
// no real time other than the work of each pass on the loopback interface.
describe("runClockStep", () => {
  let run: StepRun | undefined;
  const gateOf = (arm: StepArm, gate: StepGate): boolean | undefined => run?.verdict.results[arm].gates[gate];

  beforeAll(async () => {
    run = await runClockStep();
    // The record goes to the log of CI. The predictions wirelab-al13-case11 and wirelab-al13-case11-frame read it.
    console.log(`${CASE_11_ID} ${JSON.stringify(run)}`);
  }, 600_000);

  it("reads: each arm completed, each step fell at its point, and control passed each gate", () => {
    expect(run?.verdict.read, run?.verdict.problems.join("\n")).toBe(true);
  });

  it("passes each gate of control", () => {
    for (const gate of ARM_STEP_GATES.control) expect(gateOf("control", gate), gate).toBe(true);
  });

  it("passes each gate of forward-poll other than stepSeen", () => {
    for (const gate of ARM_STEP_GATES["forward-poll"].filter((g) => g !== "stepSeen")) expect(gateOf("forward-poll", gate), gate).toBe(true);
  });

  it("passes each gate of each arm", () => {
    expect(run?.verdict.pass, run?.verdict.problems.join("\n")).toBe(true);
  });

  for (const arm of ["back-poll", "back-retry", "back-fetch"] as const) {
    it(`${arm}: delivers once and stops, with no pass that throws`, () => {
      for (const gate of ["delivered", "single", "stopped", "copyOnce", "noThrow"] as const) expect(gateOf(arm, gate), gate).toBe(true);
    });

    // AL-49: the runtime moves its own times by the step, thus each due action comes on time. The prediction
    // wirelab-al13-case11-frame states this pass.
    it(`${arm}: prompt (AL-49)`, () => {
      expect(gateOf(arm, "prompt")).toBe(true);
    });
  }

  for (const arm of ["back-poll", "forward-poll", "back-retry", "back-fetch"] as const) {
    // AL-49: the log has one system report of the step, with its size. The prediction wirelab-al13-case11-frame
    // states this pass.
    it(`${arm}: stepSeen (AL-49)`, () => {
      expect(gateOf(arm, "stepSeen")).toBe(true);
    });
  }
});
