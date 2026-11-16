import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "@mark1russell7/algebra/clock";
import { reportId, type Observation, type ObservationId, type PlaceId, type Report, type SourceId, type SourceProcedures, type WatchedPlace } from "@mark1russell7/alerts";
import { checkIntegrity, openDatabase } from "@mark1russell7/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "./events.ts";
import { openCheckedRuntimeLog, openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openRuntime } from "./runtime.ts";

const T0 = Date.UTC(2026, 10, 16, 12);
const MINUTE = 60_000;
const API = "api" as SourceId;
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const LOG_FILE = "runtime.sqlite";
// The index on the type of the events. Its broken root page leaves the table readable with no index.
const TYPE_INDEX = "events_type";

function observation(at: number): Observation {
  return { id: `api:w1:${String(at)}` as ObservationId, source: API, fetched: at, contentType: "application/json", body: JSON.stringify({ key: "w1" }), transport: { latency: 0 } };
}

function report(seen: Observation): Report {
  return {
    id: reportId({ source: API, key: "w1", sent: T0 }),
    source: API,
    origin: "nws",
    key: "w1",
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received: seen.fetched,
    expires: T0 + 600 * MINUTE,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: seen.id,
    parameters: {},
  };
}

// A runtime on a log, with one source that gives the same warning at each fetch.
function runtimeOn(log: RuntimeLog, clock: ReturnType<typeof fakeClock>, run: string) {
  const source: SourceProcedures = {
    describe: () => ({
      id: API,
      title: "The source api",
      origins: ["nws"],
      dependsOn: ["provider:api"],
      uses: ["internet", "power"],
      kinds: ["met"],
      coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
      transport: "poll",
      interval: MINUTE,
      slowAfter: 10_000,
      auth: "none",
    }),
    fetch: async () => ({ ok: true, observations: [observation(clock.now())], complete: true }),
    map: ({ observation: seen }) => ({ reports: [report(seen)], problems: [] }),
  };
  return openRuntime({
    log,
    clock,
    sources: [source],
    watch: () => ({ places: [KANSAS], kinds: ["met"] }),
    view: { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } },
    run,
  });
}

// This function writes 0 in the first byte of the root page of the type index: the type of the page. Fault case 12 does the same.
function breakTypeIndex(path: string): void {
  const db = openDatabase(path);
  let page: number;
  let size: number;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    size = Number(db.prepare("PRAGMA page_size").get()?.["page_size"]);
    page = Number(db.prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND name = ?").get(TYPE_INDEX)?.["rootpage"]);
  } finally {
    db.close();
  }
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Uint8Array.of(0), 0, 1, (page - 1) * size);
  } finally {
    closeSync(fd);
  }
}

const ids = (log: RuntimeLog): string[] => [...log.read()].map((event) => event.id);

describe("the checked open of the log at the boot (AL-50)", () => {
  let folder: string;
  let path: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "alerts-log-"));
    path = join(folder, LOG_FILE);
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  // The first life writes a start, one fetch and its observation to a new file, and closes it.
  async function firstLife(): Promise<string[]> {
    const opened = openCheckedRuntimeLog(path, { now: () => T0 });
    expect(opened.recovered).toBeUndefined();
    try {
      await runtimeOn(opened.log, fakeClock(T0), "run-1").pass();
      return ids(opened.log);
    } finally {
      opened.log.close();
    }
  }

  it("opens a new file and a file that passes its check with no recovery", async () => {
    const first = await firstLife();
    expect(first.length).toBeGreaterThan(2);
    const again = openCheckedRuntimeLog(path, { now: () => T0 + MINUTE });
    try {
      expect(again.recovered).toBeUndefined();
      expect(ids(again.log)).toEqual(first);
    } finally {
      again.log.close();
    }
    expect(readdirSync(folder).filter((name) => name.includes(".broken-"))).toEqual([]);
  });

  it("moves a broken file into quarantine, salvages each event, and writes one recovered event", async () => {
    const first = await firstLife();
    breakTypeIndex(path);
    const check = openDatabase(path);
    try {
      expect(checkIntegrity(check, { quick: true }).ok).toBe(false);
    } finally {
      check.close();
    }
    const bytes = readFileSync(path);
    const at = T0 + 5 * MINUTE;
    const opened = openCheckedRuntimeLog(path, { now: () => at });
    try {
      const recovered = opened.recovered;
      expect(recovered).toMatchObject({ type: "recovered", time: at, fault: "corrupt", read: first.length, added: first.length, lost: 0, whole: true });
      expect(recovered?.quarantine).toBe(`${LOG_FILE}.broken-20261116T120500Z`);
      expect(recovered?.id).toBe(`recovered:${recovered?.quarantine ?? ""}`);
      expect(recovered?.problems.length).toBeGreaterThan(0);
      // The quarantine folder keeps the bytes of the broken file, and the new file has each event and the recovered event.
      expect(readFileSync(join(folder, recovered?.quarantine ?? "", LOG_FILE)).equals(bytes)).toBe(true);
      expect(ids(opened.log)).toEqual([...first, recovered?.id]);

      // The fold of the recovered event gives one system report that names the quarantine.
      const runtime = runtimeOn(opened.log, fakeClock(at), "run-2");
      expect(runtime.state().recoveries).toEqual([{ at, quarantine: recovered?.quarantine, kept: first.length, lost: 0, whole: true }]);
      await runtime.pass();
      const system = [...opened.log.read()].filter((event): event is Extract<RuntimeEvent, { type: "system" }> => event.type === "system");
      const named = system.flatMap((event) => event.reports).filter((entry) => /quarantine/i.test(`${entry.headline ?? ""} ${entry.description ?? ""} ${entry.instruction ?? ""}`));
      expect(named.map((entry) => [entry.op, entry.kind.code])).toEqual([["alert", "system.log.recovered"]]);
    } finally {
      opened.log.close();
    }

    // The new file passes its check, thus a second boot gives no second recovery.
    const second = openCheckedRuntimeLog(path, { now: () => at + MINUTE });
    try {
      expect(second.recovered).toBeUndefined();
    } finally {
      second.log.close();
    }
    expect(readdirSync(folder).filter((name) => name.includes(".broken-"))).toHaveLength(1);
  });

  it("starts a new log from a file that is not a database, and tells that the salvage did not read each part", () => {
    writeFileSync(path, "This file is not a database. ".repeat(200));
    const opened = openCheckedRuntimeLog(path, { now: () => T0 });
    try {
      expect(opened.recovered).toMatchObject({ read: 0, added: 0, lost: 0, whole: false });
      expect(ids(opened.log)).toEqual([opened.recovered?.id]);
    } finally {
      opened.log.close();
    }
  });

  it("gives a fault that is not a broken file to the caller, and moves nothing", () => {
    mkdirSync(path);
    expect(() => openCheckedRuntimeLog(path, { now: () => T0 })).toThrow();
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(folder)).toEqual([LOG_FILE]);
  });

  it("opens a log in memory with no check", () => {
    const opened = openCheckedRuntimeLog(":memory:", { now: () => T0 });
    try {
      expect(opened.recovered).toBeUndefined();
    } finally {
      opened.log.close();
    }
    const plain = openRuntimeLog(":memory:");
    plain.close();
  });
});
