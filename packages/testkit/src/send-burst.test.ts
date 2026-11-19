import { HEALTH_KIND, LIMIT_KIND, type PersonId, throttleStreamOf } from "@mark1russell7/alerts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ARM_BURST_GATES,
  BURST_ARMS,
  burstIdOf,
  burstResultOf,
  burstSettingsProblems,
  burstVerdictOf,
  CASE_15_ID,
  CASE_15_SETTINGS,
  CASE_15_START,
  peakOf,
  runSendBurst,
  type BurstArm,
  type BurstGate,
  type BurstRecord,
  type BurstRun,
  type BurstSend,
} from "./send-burst.ts";

const MINUTE = 60_000;
const T0 = CASE_15_START;
const S = CASE_15_SETTINGS;
const FLOODS = Array.from({ length: S.floods }, (_, index) => burstIdOf(`f${String(index)}`));
const TORNADOES = Array.from({ length: S.tornadoes }, (_, index) => burstIdOf(`t${String(index)}`));
const BURST = T0 + S.burstAtMs;

const send = (incident: string, at: number, level: BurstSend["level"] = "notice", copy: BurstSend["copy"] = "home"): BurstSend => ({ copy, at, incident, level, person: "person-1" });

// A record with no fault: the first flood and each tornado sent at the burst, and each other flood held or suppressed.
function recordOf(arm: BurstArm, change: Partial<BurstRecord> = {}): BurstRecord {
  return {
    arm,
    sends: [...TORNADOES.map((id) => send(id, BURST, "life-safety")), send(FLOODS[0]!, BURST)],
    countFrom: T0,
    holds: FLOODS.slice(1).map((incident) => ({ copy: "home", at: BURST, incident, level: "notice", episode: 0 })),
    floods: FLOODS,
    tornadoes: TORNADOES,
    flaps: arm === "flapping" ? ["flap-1", "flap-2"] : [],
    streams: {},
    quietFrom: T0 + S.armMs - S.quietMs,
    quietEvents: 0,
    passErrors: [],
    exchangeProblems: [],
    ...change,
  };
}

const goodRecords = (): BurstRecord[] =>
  BURST_ARMS.map((arm) => (arm === "flapping" ? recordOf(arm, { holds: [...recordOf(arm).holds, ...["flap-1", "flap-2"].map((incident) => ({ copy: "home" as const, at: BURST, incident, level: "notice" as const, episode: 0 }))] }) : recordOf(arm)));

describe("the plan of case 15", () => {
  it("has valid settings in CI", () => {
    expect(burstSettingsProblems(S)).toEqual([]);
  });

  it("finds each setting that cannot read", () => {
    expect(burstSettingsProblems({ ...S, floods: S.limits.notice })).toHaveLength(1);
    expect(burstSettingsProblems({ ...S, stepMs: 60_000 })).toHaveLength(1);
    expect(burstSettingsProblems({ ...S, rollbackMs: S.limits.window })).toHaveLength(1);
    expect(burstSettingsProblems({ ...S, throttle: { ...S.throttle, window: S.rollbackMs } })).toHaveLength(1);
    expect(burstSettingsProblems({ ...S, quietMs: S.armMs - 15 * MINUTE })).toHaveLength(1);
    expect(burstSettingsProblems({ ...S, waveFloods: 0 })).toHaveLength(1);
  });

  it("gives oneSend only to the arms where the copies read each other, and flapped only to flapping", () => {
    expect(BURST_ARMS.filter((arm) => ARM_BURST_GATES[arm].includes("oneSend"))).toEqual(["two-copies", "imported", "flapping"]);
    expect(BURST_ARMS.filter((arm) => ARM_BURST_GATES[arm].includes("flapped"))).toEqual(["flapping"]);
  });
});

describe("the peak of the sends in a window", () => {
  it("counts each incident one time in each window, and each person apart", () => {
    const sends = [send("a", T0), send("a", T0 + MINUTE), send("b", T0 + 30 * MINUTE), send("c", T0 + 61 * MINUTE), { ...send("d", T0), person: "person-2" }];
    expect(peakOf(sends, "notice", 60 * MINUTE)).toBe(2);
    expect(peakOf(sends, "urgent", 60 * MINUTE)).toBe(0);
    expect(peakOf([...sends, send("e", T0 + 59 * MINUTE)], "notice", 60 * MINUTE)).toBe(3);
  });
});

describe("the gates of case 15", () => {
  it("passes each gate of each arm for a record with no fault", () => {
    for (const record of goodRecords()) {
      const result = burstResultOf(record);
      expect(result.problems, record.arm).toEqual([]);
      for (const gate of ARM_BURST_GATES[record.arm]) expect(result.gates[gate], `${record.arm} ${gate}`).toBe(true);
    }
  });

  it("fails capped for one send past the limit, and counts only the sends from countFrom", () => {
    const record = recordOf("one-copy");
    const over = { ...record, sends: [...record.sends, ...FLOODS.slice(1, S.limits.notice + 1).map((id) => send(id, BURST + MINUTE))] };
    expect(burstResultOf(over).gates.capped).toBe(false);
    expect(burstResultOf(over).peak.notice).toBe(S.limits.notice + 1);
    expect(burstResultOf({ ...over, countFrom: BURST + 1 }).gates.capped).toBe(true);
  });

  it("fails held for a flood with no send, no hold and no suppression, and for a send after a hold of its copy", () => {
    const record = recordOf("one-copy");
    expect(burstResultOf({ ...record, holds: record.holds.slice(1) }).gates.held).toBe(false);
    const late = { ...record, sends: [...record.sends, send(FLOODS[S.floods - 1]!, BURST + MINUTE)] };
    expect(burstResultOf(late).gates.held).toBe(false);
    // A send of the other copy after a hold is not a send after its own hold.
    const other = { ...record, sends: [...record.sends, send(FLOODS[S.floods - 1]!, BURST + MINUTE, "notice", "cloud")] };
    expect(burstResultOf(other).gates.held).toBe(true);
  });

  it("fails throttled for a second notice of a copy in one window of the throttle", () => {
    const record = recordOf("two-copies");
    expect(burstResultOf({ ...record, sends: [...record.sends, send(FLOODS[1]!, BURST + MINUTE)] }).gates.throttled).toBe(false);
    // A notice of the other copy, or a notice at the end of the window, is not a second notice of the copy in the window.
    expect(burstResultOf({ ...record, sends: [...record.sends, send(FLOODS[1]!, BURST + MINUTE, "notice", "cloud")] }).gates.throttled).toBe(true);
    expect(burstResultOf({ ...record, sends: [...record.sends, send(FLOODS[1]!, BURST + S.throttle.window)] }).gates.throttled).toBe(true);
    // The streams come from the rule of the throttle. A health line is in the stream of the system lines. The held notice
    // of the send limit (AL-81) has addresses, thus it is a private stream. With a flood notice, they are not second notices.
    const health = (id: string): [string, string] => [id, throttleStreamOf({ kind: { code: `${HEALTH_KIND}.failing` } }, id, S.throttle.streams)];
    const held: [string, string] = ["held-1", throttleStreamOf({ kind: { code: `${LIMIT_KIND}.held` }, addresses: ["person-1" as PersonId] }, "held-1", S.throttle.streams)];
    const streams = Object.fromEntries([health("health-1"), health("health-2"), held]);
    expect(burstResultOf({ ...record, streams, sends: [...record.sends, send("health-1", BURST + MINUTE), send("held-1", BURST + 2 * MINUTE)] }).gates.throttled).toBe(true);
    // Two health lines in one window are two notices of the stream of the system lines.
    expect(burstResultOf({ ...record, streams, sends: [...record.sends, send("health-1", BURST + MINUTE), send("health-2", BURST + 2 * MINUTE)] }).gates.throttled).toBe(false);
  });

  it("fails lifeSafety when a tornado warning has no send", () => {
    const record = recordOf("one-copy");
    expect(burstResultOf({ ...record, sends: record.sends.filter((one) => one.incident !== TORNADOES[0]) }).gates.lifeSafety).toBe(false);
  });

  it("fails settles for a send or an escalation in the quiet tail", () => {
    const record = recordOf("one-copy");
    expect(burstResultOf({ ...record, quietEvents: 1 }).gates.settles).toBe(false);
    expect(burstResultOf({ ...record, sends: [...record.sends, send(TORNADOES[0]!, record.quietFrom, "life-safety")] }).gates.settles).toBe(false);
  });

  it("fails noThrow for a pass that threw, and for a problem of a read", () => {
    expect(burstResultOf(recordOf("one-copy", { passErrors: ["home at 0 ms: The log is closed."] })).gates.noThrow).toBe(false);
    expect(burstResultOf(recordOf("two-copies", { exchangeProblems: ["The page is not valid."] })).gates.noThrow).toBe(false);
  });

  it("fails oneSend when each copy sends one incident", () => {
    const record = recordOf("two-copies");
    expect(burstResultOf({ ...record, sends: [...record.sends, send(FLOODS[0]!, BURST + MINUTE, "notice", "cloud")] }).gates.oneSend).toBe(false);
  });

  it("fails flapped with no flap incident, and for a flap with no send, no hold and no suppression", () => {
    const [flapping] = goodRecords().filter((record) => record.arm === "flapping");
    expect(burstResultOf({ ...flapping!, flaps: ["flap-1"] }).gates.flapped).toBe(true);
    expect(burstResultOf({ ...flapping!, flaps: [] }).gates.flapped).toBe(false);
    expect(burstResultOf({ ...flapping!, flaps: ["flap-1", "flap-2", "flap-3"] }).gates.flapped).toBe(false);
  });
});

describe("the verdict of case 15", () => {
  it("reads and passes when each arm passes each gate", () => {
    const verdict = burstVerdictOf(goodRecords());
    expect(verdict.problems).toEqual([]);
    expect([verdict.read, verdict.pass]).toEqual([true, true]);
  });

  it("reads and fails when an arm with two copies sends past the limit", () => {
    const past = FLOODS.slice(1, S.limits.notice + 1).map((id) => send(id, BURST, "notice", "cloud"));
    const records = goodRecords().map((record) => (record.arm === "split" ? { ...record, sends: [...record.sends, ...past] } : record));
    const verdict = burstVerdictOf(records);
    expect([verdict.read, verdict.pass]).toEqual([true, false]);
    expect(verdict.results.split.gates.capped).toBe(false);
  });

  it("cannot read when one-copy fails a gate, an arm stopped, or a record is missing", () => {
    const control = goodRecords().map((record) => (record.arm === "one-copy" ? { ...record, quietEvents: 1 } : record));
    expect(burstVerdictOf(control).read).toBe(false);
    const stopped = goodRecords().map((record) => (record.arm === "rollback" ? { ...record, error: "The log did not open." } : record));
    expect(burstVerdictOf(stopped).read).toBe(false);
    const missing = burstVerdictOf(goodRecords().filter((record) => record.arm !== "imported"));
    expect(missing.read).toBe(false);
    expect(missing.results.imported.gates.capped).toBe(false);
  });
});

// The real case: one or two runtimes on a fake wall clock, with the exchange through JSON. It takes no real time other
// than the work of each pass.
describe("runSendBurst", () => {
  let run: BurstRun | undefined;
  const gateOf = (arm: BurstArm, gate: BurstGate): boolean | undefined => run?.verdict.results[arm].gates[gate];

  beforeAll(async () => {
    run = await runSendBurst();
    // The log shows the record when a gate fails. The workflow Faults keeps the full record in `fault-records/case-15.json`.
    const summary = run.records.map((record) => ({
      arm: record.arm,
      sends: record.sends.length,
      counted: record.sends.filter((one) => one.at >= record.countFrom).length,
      holds: record.holds.length,
      flaps: record.flaps.length,
      peak: run?.verdict.results[record.arm].peak,
      gates: run?.verdict.results[record.arm].gates,
    }));
    console.log(`${CASE_15_ID} ${JSON.stringify({ read: run.verdict.read, pass: run.verdict.pass, problems: run.verdict.problems, arms: summary })}`);
  }, 600_000);

  it("reads: each arm completed, and one-copy passed each gate", () => {
    expect(run?.verdict.read, run?.verdict.problems.join("\n")).toBe(true);
  });

  for (const arm of BURST_ARMS) {
    it(`${arm}: passes each gate`, () => {
      for (const gate of ARM_BURST_GATES[arm]) expect(gateOf(arm, gate), `${gate}: ${run?.verdict.problems.join(" ") ?? ""}`).toBe(true);
    });
  }
});
