import { SNAPSHOT_MISSES } from "@mark1russell7/alerts-runtime";
import { readAnswer } from "@mark1russell7/alerts-source-iem";
import { checkFaultPlan, faultPlanOf } from "@mark1russell7/rigor-chaos";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import {
  CASE_6_ORIGIN,
  CASE_6_SETTINGS,
  listOf,
  OLD_LISTS,
  oldAnswersOf,
  R2_FROM,
  R3_UNTIL,
  ROW_NAMES,
  type RowName,
  rowOf,
  STALE_ARMS,
  type StaleArm,
  type StaleFetch,
  type StaleRecord,
  staleGatesOf,
  staleSettingsProblems,
  staleTransport,
  staleVerdictOf,
  trueRows,
} from "./stale-list.ts";

/**
 * This function gives the fetches of an arm in a model of the snapshot step: the list of each fetch is the true list, or
 * the old list of the arm. A report ends at its miss number `SNAPSHOT_MISSES`, and a listed report that ended comes back.
 */
function modelFetches(arm: StaleArm, fetches = CASE_6_SETTINGS.fetches): StaleFetch[] {
  const misses = new Map<RowName, number>();
  const ended = new Set<RowName>();
  const known = new Set<RowName>();
  return Array.from({ length: fetches }, (_, fetch) => {
    const list = OLD_LISTS[arm].get(fetch) ?? fetch;
    const rows = trueRows(list);
    const ends: RowName[] = [];
    const back: RowName[] = [];
    for (const row of rows) {
      known.add(row);
      misses.delete(row);
      if (ended.delete(row)) back.push(row);
    }
    for (const row of known) {
      if (rows.includes(row) || ended.has(row)) continue;
      const count = (misses.get(row) ?? 0) + 1;
      if (count >= SNAPSHOT_MISSES) {
        misses.delete(row);
        ended.add(row);
        ends.push(row);
      } else misses.set(row, count);
    }
    return { fetch, at: fetch * 120_000, old: OLD_LISTS[arm].has(fetch), ok: true, complete: true, rows, ended: ends, back };
  });
}

/** This function gives the record of an arm whose fetches follow the model, with the counts of a run with no problem. */
function modelRecord(arm: StaleArm, fetches: StaleFetch[] = modelFetches(arm)): StaleRecord {
  const olds = OLD_LISTS[arm].size;
  return {
    arm,
    fetches,
    requests: { direct: CASE_6_SETTINGS.fetches - olds, old: olds },
    faults: olds,
    served: CASE_6_SETTINGS.fetches - olds,
    leaked: 0,
    reported: [...ROW_NAMES],
    unknown: 0,
  };
}

describe("the lists of the case", () => {
  it("gives r2 from its first fetch and r3 until its last fetch", () => {
    expect(trueRows(0)).toEqual(["r1", "r3"]);
    expect(trueRows(R2_FROM)).toEqual(["r1", "r2", "r3"]);
    expect(trueRows(R3_UNTIL)).toEqual(["r1", "r2"]);
  });

  it("gives each list as a complete answer of the IEM source, with one observation for each row", () => {
    for (const fetch of [0, R2_FROM, R3_UNTIL]) {
      const reply: Reply = { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: listOf(fetch) };
      const read = readAnswer(reply, `${CASE_6_ORIGIN}/list`, 0, 1, new Set(["TX", "KS"]));
      expect(read?.complete).toBe(true);
      expect(read?.observations.map((observation) => rowOf(observation))).toEqual(trueRows(fetch));
    }
  });

  it("gives no row for a body that is not a row of the case", () => {
    expect(rowOf({ body: "{" })).toBeUndefined();
    expect(rowOf({ body: JSON.stringify({ ugc: "TXZ001" }) })).toBeUndefined();
  });

  it("has valid settings: no row expires in an arm, and the last old list has time to settle", () => {
    expect(staleSettingsProblems(CASE_6_SETTINGS)).toEqual([]);
    expect(staleSettingsProblems({ ...CASE_6_SETTINGS, fetches: 9 })).toHaveLength(1);
    expect(staleSettingsProblems({ ...CASE_6_SETTINGS, start: Date.parse("2026-11-15T16:50:00Z") })).toEqual(["The row r1 expires in the arm."]);
  });
});

describe("oldAnswersOf", () => {
  it("gives a valid plan with one answer for each old list, in the order of the fetches", () => {
    for (const arm of STALE_ARMS) {
      const faults = oldAnswersOf(arm);
      expect(faults).toHaveLength(OLD_LISTS[arm].size);
      expect(checkFaultPlan(faultPlanOf(faults))).toEqual([]);
    }
    expect(oldAnswersOf("stale-twice").map((fault) => (fault.kind === "answer" ? [fault.connection, fault.body] : []))).toEqual([
      [0, listOf(0)],
      [1, listOf(0)],
    ]);
  });
});

describe("staleTransport", () => {
  it("sends the request of each old fetch to the proxy, and refuses another origin", async () => {
    const urls: string[] = [];
    const inner: Transport = (exchange: Exchange) => {
      urls.push(exchange.url);
      return Promise.resolve({ status: 200, statusText: "OK", headers: {}, body: "" });
    };
    const counts = { direct: 0, old: 0 };
    const transport = staleTransport({ inner, direct: "http://server", old: "http://proxy", olds: new Set([1]), counts });
    for (let fetch = 0; fetch < 3; fetch += 1) await transport({ method: "GET", url: `${CASE_6_ORIGIN}/list?x=1`, headers: {}, body: null }, undefined);
    await expect(transport({ method: "GET", url: "http://other.test/list", headers: {}, body: null }, undefined)).rejects.toThrow(TypeError);
    expect(urls).toEqual(["http://server/list?x=1", "http://proxy/list?x=1", "http://server/list?x=1"]);
    expect(counts).toEqual({ direct: 2, old: 1 });
  });
});

describe("staleGatesOf", () => {
  it("passes each gate of the arms whose old lists hold no end and no return in the model", () => {
    for (const arm of ["control", "repeat", "stale-once"] as const) {
      expect(staleGatesOf(modelRecord(arm)).gates).toEqual({ noFalseEnd: true, noFalseBack: true, settles: true });
    }
  });

  it("finds the end of a live report after two old lists in a row", () => {
    const result = staleGatesOf(modelRecord("stale-twice"));
    expect(result.falseEnds).toEqual([{ fetch: 5, row: "r2" }]);
    expect(result.gates).toEqual({ noFalseEnd: false, noFalseBack: true, settles: true });
  });

  it("finds the return of an ended report in an old list", () => {
    const result = staleGatesOf(modelRecord("stale-after-end"));
    expect(result.falseBacks).toEqual([{ fetch: 7, row: "r3" }]);
    expect(result.gates).toEqual({ noFalseEnd: true, noFalseBack: false, settles: true });
  });

  it("does not settle when a row that left the list did not end", () => {
    const fetches = modelFetches("control").map((fetch) => ({ ...fetch, ended: [] }));
    expect(staleGatesOf({ fetches }).gates.settles).toBe(false);
    expect(staleGatesOf({ fetches: [] }).gates.settles).toBe(false);
  });
});

describe("staleVerdictOf", () => {
  const records = STALE_ARMS.map((arm) => modelRecord(arm));

  it("reads a run of the model, and fails it on the two arms with a false event", () => {
    const verdict = staleVerdictOf(records);
    expect(verdict.problems).toEqual([]);
    expect(verdict.read).toBe(true);
    expect(verdict.pass).toBe(false);
  });

  it("passes a run whose old lists count nothing", () => {
    const fixed = STALE_ARMS.map((arm) => modelRecord(arm, modelFetches("control").map((fetch) => ({ ...fetch, old: OLD_LISTS[arm].has(fetch.fetch) }))));
    expect(staleVerdictOf(fixed)).toMatchObject({ read: true, pass: true });
  });

  it("gives no read when a fault did not fall, a request got past the proxy, or a true list is not complete", () => {
    const broken = records.map((record) =>
      record.arm === "stale-once"
        ? { ...record, faults: 0, leaked: 1 }
        : record.arm === "repeat"
          ? { ...record, fetches: record.fetches.map((fetch) => (fetch.fetch === 0 ? { ...fetch, complete: false } : fetch)) }
          : record,
    );
    const verdict = staleVerdictOf(broken);
    expect(verdict.read).toBe(false);
    expect(verdict.pass).toBe(false);
    expect(verdict.problems).toHaveLength(3);
  });

  it("gives no read when the control does not end r3 at its fetch", () => {
    const late = records.map((record) => (record.arm === "control" ? modelRecord("control", modelFetches("control").slice(0, 5).concat(modelFetches("stale-once").slice(5))) : record));
    expect(staleVerdictOf(late).read).toBe(false);
  });
});
