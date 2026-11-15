import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "@mark1russell7/algebra/clock";
import {
  incidents,
  normalize,
  reportId,
  type FetchOutcome,
  type MergeState,
  type Observation,
  type ObservationId,
  type PlaceId,
  type Report,
  type ReportId,
  type SourceDescriptor,
  type SourceId,
  type SourceProcedures,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "./events.ts";
import { openRuntimeLog } from "./log.ts";
import { openRuntime, type RuntimeOptions } from "./runtime.ts";
import { snapshotStep, type SnapshotInput } from "./snapshot.ts";
import { rebuild } from "./state.ts";

const T0 = Date.UTC(2026, 10, 15, 18, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LIST = "list" as SourceId;

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

let folders: string[] = [];
afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  folders = [];
});

function logPath(): string {
  const made = mkdtempSync(join(tmpdir(), "alerts-snapshot-"));
  folders.push(made);
  return join(made, "log.sqlite");
}

/** One row of a fake list: an event of a key, with its own observation. */
function row(key: string, fetched: number): Observation {
  return { id: `${LIST}:${key}` as ObservationId, source: LIST, fetched, contentType: "application/json", body: JSON.stringify({ key }), transport: { latency: 0 } };
}

function report(key: string, observation: Observation, extra: Partial<Report> = {}): Report {
  return {
    id: reportId({ source: LIST, key, sent: T0 }),
    source: LIST,
    origin: "nws",
    key,
    references: [],
    correlation: [{ system: "vtec", id: `KTOP.TO.W.${key}` }],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received: observation.fetched,
    expires: T0 + DAY,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "KTOP",
    headline: "Tornado Warning",
    observation: observation.id,
    parameters: {},
    ...extra,
  };
}

const map = ({ observation }: { readonly observation: Observation }) => ({ reports: [report((JSON.parse(observation.body) as { key: string }).key, observation)], problems: [] });

function descriptor(listing: boolean): SourceDescriptor {
  return {
    id: LIST,
    title: "A fake list",
    origins: ["nws"],
    dependsOn: ["provider:list"],
    uses: ["internet", "power"],
    kinds: ["met"],
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval: MINUTE,
    slowAfter: 10_000,
    auth: "none",
    ...(listing ? { listing: "snapshot" as const } : {}),
  };
}

/** One answer of the fake list: the keys of a complete list, a part of a list, or a failure. */
type Answer = { readonly keys: readonly string[]; readonly complete?: false } | "failure";

describe("snapshotStep", () => {
  const a = report("a", row("a", T0));
  const b = report("b", row("b", T0));
  const merge: MergeState = normalize({ reports: [a, b] });
  const step = (outcome: FetchOutcome, misses: ReadonlyMap<ReportId, number> = new Map(), state: MergeState = merge): ReturnType<typeof snapshotStep> => {
    const input: SnapshotInput = { source: LIST, started: T0 + MINUTE, ended: T0 + MINUTE + 300, outcome, merge: state, misses, limit: 2 };
    return snapshotStep(input);
  };
  const listed = (...keys: string[]): FetchOutcome => ({ ok: true, complete: true, observations: keys.map((key) => row(key, T0 + MINUTE)) });

  it("counts one miss for each live report that a complete list does not have, and ends it at the limit", () => {
    const first = step(listed("a"));
    expect(first.events).toEqual([]);
    expect([...first.misses]).toEqual([[b.id, 1]]);
    const second = step(listed("a"), first.misses);
    expect(second.events).toEqual([{ id: `ended:${LIST}:${T0 + MINUTE}`, at: new Date(T0 + MINUTE + 300).toISOString(), type: "ended", time: T0 + MINUTE + 300, source: LIST, reports: [b.id] }]);
    expect(second.misses.size).toBe(0);
  });

  it("counts nothing for a failed fetch or for a part of a list, and keeps the counts", () => {
    const misses = new Map([[b.id, 1]]);
    for (const outcome of [{ ok: false, failure: { kind: "server", message: "down" } }, { ...listed("a"), complete: false }] as const) {
      const result = step(outcome, misses);
      expect(result.events).toEqual([]);
      expect(result.misses).toBe(misses);
    }
  });

  it("starts the count again for a report that is in the list again before its end", () => {
    expect(step(listed("a", "b"), new Map([[b.id, 1]])).misses.size).toBe(0);
  });

  it("ends each report of an empty complete list, and no report of a different source", () => {
    const other = { ...report("c", row("c", T0)), source: "other" as SourceId };
    const result = step(listed(), new Map([[a.id, 1], [b.id, 1]]), normalize({ reports: [a, b, other] }));
    expect(result.events.flatMap((event) => event.reports)).toEqual([a.id, b.id].sort());
  });

  it("counts no miss for a report that is cancelled, expired or ended", () => {
    const cancel = report("x", row("x", T0), { op: "cancel" });
    const expired = report("y", row("y", T0), { expires: T0 + 1000 });
    const ended = normalize({ reports: [cancel, expired, b], ends: [{ report: b.id, at: T0, ended: true }] });
    const result = step(listed(), new Map(), ended);
    expect(result.events).toEqual([]);
    expect(result.misses.size).toBe(0);
  });

  it("gives a back event for an ended report in a complete list", () => {
    const ended = normalize({ reports: [a, b], ends: [{ report: b.id, at: T0, ended: true }] });
    const result = step(listed("a", "b"), new Map(), ended);
    expect(result.events.map((event) => [event.type, event.reports])).toEqual([["back", [b.id]]]);
  });
});

describe("a snapshot source in the runtime", () => {
  /** This function runs the answers, one fetch for each minute, and restarts the runtime before the answer at `restartAt`. */
  async function run(answers: readonly Answer[], listing: boolean, restartAt?: number) {
    const clock = fakeClock(T0);
    let fetches = 0;
    const source: SourceProcedures = {
      describe: () => descriptor(listing),
      async fetch() {
        const answer = answers[Math.min(fetches++, answers.length - 1)]!;
        if (answer === "failure") return { ok: false, failure: { kind: "server", message: "The fake list failed." } };
        return { ok: true, complete: answer.complete ?? true, observations: answer.keys.map((key) => row(key, clock.now())) };
      },
      map,
    };
    const path = logPath();
    let log = openRuntimeLog(path);
    const open = (name: string) => openRuntime({ log, clock, sources: [source], watch: { places: [KANSAS], kinds: ["met"] }, view: VIEW, run: name });
    let runtime = open("run-0");
    const live: Record<string, boolean>[] = [];
    while (fetches < answers.length) {
      if (fetches === restartAt) {
        log.close();
        log = openRuntimeLog(path);
        runtime = open("run-1");
        restartAt = undefined;
      }
      const before = fetches;
      const pass = await runtime.pass();
      if (fetches > before) live.push(Object.fromEntries(pass.view.incidents.map((incident) => [incident.reports.length === 1 ? keyOf(incident.anchor) : "many", incident.live])));
      await clock.advance(MINUTE);
    }
    const events = [...log.read()];
    const state = runtime.state();
    expect(rebuild(events, runtime.config)).toEqual(state);
    log.close();
    return { events, live, state };
  }
  const ids = { a: report("a", row("a", T0)).id, b: report("b", row("b", T0)).id };
  const keyOf = (id: ReportId): string => (id === ids.a ? "a" : id === ids.b ? "b" : id);
  const ends = (events: readonly RuntimeEvent[]) => events.flatMap((event) => (event.type === "ended" || event.type === "back" ? [[event.type, event.reports.map(keyOf)]] : []));

  const ANSWERS: readonly Answer[] = [
    { keys: ["a", "b"] },
    { keys: ["a"] }, // b: one miss
    { keys: ["a"], complete: false }, // a part of a list: no count
    "failure", // no count
    { keys: ["a"] }, // b: two misses, thus the end
    { keys: ["a", "b"] }, // b is back
    { keys: [] }, // a and b: one miss
  ];

  it("ends a report after two complete lists with no row of it, and makes it live when it is back", async () => {
    const { events, live } = await run(ANSWERS, true);
    expect(ends(events)).toEqual([
      ["ended", ["b"]],
      ["back", ["b"]],
    ]);
    expect(live.map((row) => row["b"])).toEqual([true, true, true, true, false, true, true]);
    expect(live.every((row) => row["a"] === true)).toBe(true);
  });

  it("ends nothing for a source that is not a snapshot", async () => {
    const { events, state } = await run([...ANSWERS, { keys: [] }, { keys: [] }], false);
    expect(ends(events)).toEqual([]);
    expect(state.merge.ends).toEqual([]);
  });

  it("starts the counts at 0 after a restart, thus the end comes later and not sooner", async () => {
    const answers: readonly Answer[] = [{ keys: ["a", "b"] }, { keys: ["a"] }, { keys: ["a"] }, { keys: ["a"] }];
    expect(ends((await run(answers, true)).events)).toEqual([["ended", ["b"]]]);
    // The restart comes after the first miss. The end needs two more misses.
    const restarted = await run(answers, true, 2);
    const ended = restarted.events.filter((event) => event.type === "ended");
    expect(ended.map((event) => event.time)).toEqual([T0 + 3 * MINUTE]);
    expect(ends(restarted.events)).toEqual([["ended", ["b"]]]);
  });

  it("ends each report of a list that is empty and complete two times", async () => {
    const { events, live } = await run([{ keys: ["a", "b"] }, { keys: [] }, { keys: [] }], true);
    expect(ends(events)).toEqual([["ended", [ids.a, ids.b].sort().map(keyOf)]]);
    expect([live.at(-1)?.["a"], live.at(-1)?.["b"]]).toEqual([false, false]);
  });

  it("keeps the incidents of a report with a mark after the time of a view", async () => {
    const { state } = await run([{ keys: ["a", "b"] }, { keys: ["a"] }, { keys: ["a"] }], true);
    const [mark] = state.merge.ends;
    expect(mark).toMatchObject({ report: ids.b, ended: true });
    const liveOfB = (at: number) => incidents(state.merge, at).find((incident) => incident.reports.includes(ids.b))?.live;
    expect(liveOfB(mark!.at - 1)).toBe(true);
    expect(liveOfB(mark!.at)).toBe(false);
  });
});
