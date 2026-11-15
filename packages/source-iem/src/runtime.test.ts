import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { PlaceId, Watch, WatchedPlace } from "@mark1russell7/alerts";
import { openRuntime, openRuntimeLog, type RuntimeEvent } from "@mark1russell7/alerts-runtime";
import type { Reply } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { afterEach, describe, expect, it } from "vitest";
import { createIemSource, IEM_DESCRIPTOR } from "./index.ts";

/** The real list of IEM at 2026-11-15 13:20 UTC, cut to the rows of TX and KS. */
const LIST = readFileSync(new URL("../fixtures/county-zone-20261115T1320Z.json", import.meta.url), "utf8");
const envelope = JSON.parse(LIST) as { data: Record<string, unknown>[] };
const listOf = (rows: readonly unknown[]): string => JSON.stringify({ ...envelope, data: rows });
const KANSAS_ROWS = envelope.data.filter((row) => String(row["ugc"]).startsWith("KS"));
const [GONE, ...STAYING] = KANSAS_ROWS;
const json = (body: string, status = 200): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json" }, body });

/** A place of the tests: a public zone of Kansas, not the place of a person. */
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const WATCH: Watch = { places: [KANSAS] };

let folders: string[] = [];
afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  folders = [];
});

/** This function runs the real IEM source in the runtime, one fetch for each answer, and gives the log. */
async function run(answers: readonly Reply[]): Promise<RuntimeEvent[]> {
  const clock = fakeWallClock(Date.UTC(2026, 10, 15, 13, 20, 0));
  let fetches = 0;
  const pace = { now: () => clock.now(), sleep: async () => {} };
  const source = createIemSource({
    pace: { scheduler: new HostScheduler(pace, 1), now: pace.now },
    transport: async () => answers[Math.min(fetches++, answers.length - 1)]!,
    userAgent: "alerts-tests",
    minIntervalMs: 0,
    timeoutMs: 1000,
  });
  const folder = mkdtempSync(join(tmpdir(), "alerts-iem-"));
  folders.push(folder);
  const log = openRuntimeLog(join(folder, "log.sqlite"));
  const runtime = openRuntime({ log, clock, sources: [source], watch: () => WATCH, view: { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } }, run: "run-0" });
  for (let guard = 0; fetches < answers.length && guard < 10 * answers.length; guard += 1) {
    await runtime.pass();
    await clock.advance(IEM_DESCRIPTOR.interval);
  }
  expect(fetches).toBe(answers.length);
  const events = [...log.read()];
  log.close();
  return events;
}

const endedOf = (events: readonly RuntimeEvent[]) => events.flatMap((event) => (event.type === "ended" ? event.reports : []));
const reportsOf = (events: readonly RuntimeEvent[]) => events.flatMap((event) => (event.type === "fetch" ? event.reports : []));

describe("the IEM source in the runtime", () => {
  it("is a snapshot source", () => {
    expect(IEM_DESCRIPTOR.listing).toBe("snapshot");
    expect(GONE).toBeDefined();
    expect(STAYING.length).toBeGreaterThan(0);
  });

  it("ends no report for a cut list, a changed format, an empty list or a server failure", async () => {
    const renamed = listOf(KANSAS_ROWS.map(({ ugc, ...row }) => ({ ...row, ugc_code: ugc })));
    const oneChanged = listOf(KANSAS_ROWS.map((row, index) => (index === 0 ? { ...row, eventid: String(row["eventid"]) } : row)));
    const faults = [json(LIST.slice(0, LIST.length / 2)), json(renamed), json(listOf([])), json(oneChanged), json("{}", 500), json("not JSON")];
    const events = await run([json(LIST), ...faults, ...faults]);
    expect(reportsOf(events).length).toBe(KANSAS_ROWS.length);
    expect(endedOf(events)).toEqual([]);
  });

  it("ends the report of a row after two complete lists with no row of it, and only that report", async () => {
    const events = await run([json(LIST), json(listOf(STAYING)), json(listOf(STAYING))]);
    const gone = reportsOf(events).filter((report) => report.areas.some((area) => area.type === "code" && area.code === GONE?.["ugc"]) && report.correlation[0]?.id.includes(`.${String(GONE?.["eventid"]).padStart(4, "0")}.`));
    expect(gone).toHaveLength(1);
    expect(endedOf(events)).toEqual([gone[0]!.id]);
  });
});
