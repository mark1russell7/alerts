import { describe, expect, it } from "vitest";
import {
  CASE_14_ID,
  CASE_14_SETTINGS,
  nwwsFaultOf,
  NWWS_ARMS,
  type NwwsRecord,
  nwwsResultOf,
  nwwsVerdictOf,
  nwwsPlanOf,
  productStepIndex,
  productText,
  NWWS_PROXY_ARMS,
  runNwwsStream,
  serialOf,
} from "./nwws-stream.ts";

const S = CASE_14_SETTINGS;
const END_AT = Date.parse("2026-11-17T12:00:10Z");

/** This function gives a record of an arm that passes each gate, with the changes of a test. */
const recordOf = (arm: NwwsRecord["arm"], change: Partial<NwwsRecord> = {}): NwwsRecord => {
  const { expected } = nwwsPlanOf(arm, S);
  const ends = expected.ends.map((kind) => ({ kind, reason: `an end of the kind ${kind}`, at: END_AT }));
  const connection = { session: 0, secure: true, login: true, sasl: "success", steps: 8, error: undefined, since: "2026-11-17T11:45:00.000Z", writes: {} };
  return {
    arm,
    fault: undefined,
    faulted: true,
    faults: [],
    connections: [expected.noLogin ? { ...connection, secure: false, login: false, sasl: undefined } : connection, ...ends.map((_, index) => ({ ...connection, session: index + 1, since: "2026-11-17T11:58:00.000Z" }))],
    ends,
    opens: [END_AT - 1000, ...ends.map(() => END_AT + 150)],
    serials: expected.serials,
    complete: expected.complete ? [true, true] : [true, false],
    failures: [],
    ms: 900,
    ...change,
  };
};

describe("the plan of the case", () => {
  it("gives each arm its scripts and what it expects", () => {
    expect(nwwsPlanOf("control", S).expected).toEqual({ ends: [], serials: [1, 2, 3, 4, 5, 6], complete: true, noLogin: false });
    expect(nwwsPlanOf("cut", S).expected.serials).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(nwwsPlanOf("stall", S).expected.ends).toEqual(["timeout"]);
    expect(nwwsPlanOf("plain", S)).toMatchObject({ sessions: [{ startTls: "none" }, {}], expected: { ends: ["refused"], noLogin: true } });
    expect(nwwsPlanOf("gap", S).expected).toMatchObject({ serials: [1, 2, 4, 5, 6], complete: false });
    for (const arm of NWWS_ARMS) expect(nwwsPlanOf(arm, S).sessions.length, arm).toBe(nwwsPlanOf(arm, S).expected.ends.length + 1);
  });

  it("puts a fault of the proxy only in the arms cut, reset and stall, at the byte point of connection 0", () => {
    for (const arm of NWWS_ARMS) expect(nwwsFaultOf(arm, 900, S) !== undefined, arm).toBe(NWWS_PROXY_ARMS.includes(arm));
    expect(nwwsFaultOf("stall", 900, S)).toEqual({ connection: 0, direction: "down", at: { byte: 900 }, kind: "stall", ms: 2000 });
    expect(productStepIndex(3)).toBe(4);
  });

  it("gives a product text of the size of the settings, with the serial in the identifier of its CAP message", () => {
    const text = productText(12, S);
    expect(text).toHaveLength(S.textChars);
    expect(serialOf(text)).toBe(12);
    expect(serialOf(`<identifier>${CASE_14_ID}-x</identifier>`)).toBeUndefined();
  });
});

describe("nwwsResultOf", () => {
  it("passes each gate of each arm for a record of what the arm expects", () => {
    for (const arm of NWWS_ARMS) expect(nwwsResultOf(recordOf(arm), S), arm).toEqual({ gates: { once: true, whole: true, ends: true, rejoin: true, tls: true, secret: true }, problems: [] });
  });

  it("fails once and whole for a repeat, a lost product or a silent loss", () => {
    expect(nwwsResultOf(recordOf("cut", { serials: [1, 2, 3, 3, 4, 5, 6, 7, 8] }), S).gates).toMatchObject({ once: false, whole: true });
    expect(nwwsResultOf(recordOf("cut", { serials: [1, 2, 4, 5, 6, 7, 8] }), S).gates.whole).toBe(false);
    expect(nwwsResultOf(recordOf("gap", { complete: [true, true] }), S).problems).toEqual(["the loss is silent: each fetch was complete"]);
    expect(nwwsResultOf(recordOf("control", { complete: [true, false] }), S).gates.whole).toBe(false);
  });

  it("fails ends and rejoin for another kind, an early or late session, or a history after the end", () => {
    const want = 150;
    expect(nwwsResultOf(recordOf("stall", { ends: [{ kind: "network", reason: "r", at: END_AT }] }), S).gates.ends).toBe(false);
    expect(nwwsResultOf(recordOf("auth", { opens: [END_AT - 1000, END_AT + want - 20] }), S).gates.rejoin).toBe(false);
    expect(nwwsResultOf(recordOf("auth", { opens: [END_AT - 1000, END_AT + want + S.lateMs + 1] }), S).gates.rejoin).toBe(false);
    expect(nwwsResultOf(recordOf("auth", { opens: [END_AT - 1000] }), S).problems).toEqual(["1 sessions opened after 1 ends"]);
    const late = recordOf("cut");
    const connections = [late.connections[0]!, { ...late.connections[1]!, since: "2026-11-17T12:00:11.000Z" }];
    expect(nwwsResultOf({ ...late, connections }, S).gates.rejoin).toBe(false);
  });

  it("fails tls for a login with no TLS, and secret for a reason with the password", () => {
    const plain = recordOf("plain");
    const login = [{ ...plain.connections[0]!, login: true }, plain.connections[1]!];
    expect(nwwsResultOf({ ...plain, connections: login }, S).gates.tls).toBe(false);
    const ends = [{ kind: "auth" as const, reason: "no login for case-14-password-3f9a", at: END_AT }];
    expect(nwwsResultOf(recordOf("auth", { ends }), S).gates.secret).toBe(false);
  });
});

describe("nwwsVerdictOf", () => {
  it("passes when each arm passes, and has no read with no point, an error of an arm, or a fault off its point", () => {
    const records = NWWS_ARMS.map((arm) => recordOf(arm));
    expect(nwwsVerdictOf(900, records, S)).toMatchObject({ read: true, pass: true, problems: [] });
    expect(nwwsVerdictOf(undefined, records, S)).toMatchObject({ read: false, pass: false });
    expect(nwwsVerdictOf(900, [...records.slice(0, 1), recordOf("cut", { faulted: false })], S, ["control", "cut"])).toMatchObject({ read: false, pass: false });
    expect(nwwsVerdictOf(900, [recordOf("control", { error: "the server stopped" })], S, ["control"]).read).toBe(false);
    expect(nwwsVerdictOf(900, records.slice(1), S).problems).toContain("the arm control has no record");
    const failed = nwwsVerdictOf(900, [recordOf("control", { serials: [1, 1, 2, 3, 4, 5, 6] })], S, ["control"]);
    expect(failed).toMatchObject({ read: true, pass: false });
  });
});

describe("runNwwsStream", () => {
  // This run has no gate of time: the gate rejoin examines the times of CI in the fault suite.
  it("streams the products over TLS, and the source recovers from a cut and refuses a server with no TLS", { timeout: 30_000 }, async () => {
    const run = await runNwwsStream(S, ["control", "cut", "plain"]);
    expect(run.point).toBeGreaterThan(0);
    expect(run.records.map((record) => [record.arm, record.faulted, record.error])).toEqual([
      ["control", true, undefined],
      ["cut", true, undefined],
      ["plain", true, undefined],
    ]);
    for (const record of run.records) {
      const { gates, problems } = nwwsResultOf(record, S);
      expect({ ...gates, rejoin: true }, `${record.arm}: ${problems.join("; ")}`).toEqual({ once: true, whole: true, ends: true, rejoin: true, tls: true, secret: true });
    }
    expect(run.records[1]?.faults.map((fault) => [fault.kind, fault.byte])).toEqual([["cut", run.point]]);
  });
});
