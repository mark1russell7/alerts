import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeWallClock, type WallClock } from "@mark1russell7/algebra/clock";
import { reportId, type ChannelId, type ChannelQuota, type Expectation, type FetchOutcome, type Observation, type ObservationId, type PlaceId, type Report, type SourceDescriptor, type SourceId, type SourceProcedures, type Watch, type WatchedPlace } from "@mark1russell7/alerts";
import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "./events.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openRuntime, type Pass, type RuntimeOptions } from "./runtime.ts";
import { rebuild, type RuntimeState } from "./state.ts";
import type { ViewConfig } from "./view.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4]);
const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const MINUTE = 60_000;
const API = "api" as SourceId;
const WEA = "wea" as SourceId;

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };

// The second source carries each warning of the first source that has the parameter WEAHandling.
const EXPECT: Expectation = { id: "api-to-wea", from: API, to: WEA, when: { statuses: ["actual"], parameters: ["WEAHandling"] } };

const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [EXPECT], delay: { quantile: 0.9, level: 0.9 } };

let folders: string[] = [];
afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  folders = [];
});

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), "alerts-runtime-"));
  folders.push(made);
  return made;
}

function descriptor(id: SourceId, interval: number, maxQuiet?: number): SourceDescriptor {
  return {
    id,
    title: `The source ${id}`,
    origins: ["nws"],
    dependsOn: [`provider:${id}`],
    uses: ["internet", "power"],
    kinds: ["met"],
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval,
    slowAfter: 10_000,
    ...(maxQuiet === undefined ? {} : { maxQuiet }),
    auth: "none",
  };
}

function report(source: SourceId, key: string, issued: number, observation: Observation): Report {
  return {
    id: reportId({ source, key, sent: issued }),
    source,
    origin: "nws",
    key,
    references: [],
    correlation: [{ system: "vtec", id: key }],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: issued,
    received: observation.fetched,
    expires: issued + 45 * MINUTE,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: observation.id,
    parameters: source === API ? { WEAHandling: ["Imminent Threat"] } : {},
  };
}

function observation(source: SourceId, key: string, fetched: number, body: unknown): Observation {
  return { id: `${source}:${key}` as ObservationId, source, fetched, contentType: "application/json", body: JSON.stringify(body), transport: { latency: 0 } };
}

// The map of the fake sources. A body with `broken` gives a fatal problem and no report.
function map({ observation: seen }: { readonly observation: Observation }) {
  const body = JSON.parse(seen.body) as { readonly key: string; readonly issued: number; readonly broken?: boolean };
  if (body.broken === true) return { reports: [], problems: [{ path: "properties", message: "The body has no properties.", fatal: true }] };
  return { reports: [report(seen.source, body.key, body.issued, seen)], problems: [] };
}

/** One warning of a world: its time on the API, its time on WEA (absent: WEA does not carry it), and a body that the map cannot read. */
interface Warning {
  readonly key: string;
  readonly issued: number;
  readonly carried?: number;
  readonly broken: boolean;
}

function warningsOf(seed: number): Warning[] {
  const r = random(seed).fork("warnings");
  const list: Warning[] = [];
  let at = T0;
  for (let n = 0; n < 14; n++) {
    at += r.int(1, 9) * MINUTE + r.int(0, 59) * 1000;
    const carried = r.chance(0.8) ? at + r.int(10, 400) * 1000 : undefined;
    list.push({ key: `w${n}`, issued: at, ...(carried === undefined ? {} : { carried }), broken: r.chance(0.1) });
  }
  return list;
}

/**
 * This function makes a fake source of a world. Its outcome is a function of the seed and the time of the
 * fetch only. Thus a run after a restart gets the same outcome at the same time.
 */
function worldSource(id: SourceId, interval: number, seed: number, warnings: readonly Warning[], clock: WallClock, maxQuiet?: number): SourceProcedures {
  const timeOf = (warning: Warning) => (id === API ? warning.issued : warning.carried);
  return {
    describe: () => descriptor(id, interval, maxQuiet),
    async fetch({ cursor }): Promise<FetchOutcome> {
      const at = clock.now();
      const r = random(`${seed}:${id}:${at}`);
      if (r.chance(0.15)) return { ok: false, failure: { kind: "server", message: "The fake server failed." } };
      // Each fetch gives the warnings of the last 30 minutes, thus most of its observations repeat.
      const observations = warnings
        .filter((warning) => {
          const time = timeOf(warning);
          return time !== undefined && time <= at && time > at - 30 * MINUTE;
        })
        .map((warning) => observation(id, warning.key, at, { key: warning.key, issued: warning.issued, broken: warning.broken }));
      return { ok: true, observations, complete: true, cursor: { seen: String(at), before: cursor?.["seen"] ?? "" } };
    },
    map,
  };
}

// The events of the work of a run. The start of each run is not work.
const isWork = (event: RuntimeEvent): boolean => event.type !== "started";

/** The process stops at an event of the log: the write of the event does not end. */
class Crash extends Error {}

// A log that stops the process before the event at the position `at`. After the stop, each write throws, as in a process that is gone.
function crashing(inner: RuntimeLog, at: number): RuntimeLog {
  let accepted = 0;
  let gone = false;
  return {
    read: () => inner.read(),
    has: (id) => inner.has(id),
    close: () => inner.close(),
    appendAll(events, accept) {
      if (gone) throw new Crash("The process is gone.");
      return inner.appendAll(events, (event) => {
        if (accepted === at) {
          gone = true;
          throw new Crash(`The process stopped at the event ${event.id}.`);
        }
        accepted += 1;
        accept(event);
      });
    },
  };
}

interface WorldRun {
  readonly state: RuntimeState;
  readonly config: ViewConfig;
  readonly events: readonly RuntimeEvent[];
  readonly passes: readonly Pass[];
  readonly restarts: number;
}

/** This function runs a world for two hours. With `cutAt`, the process stops at that event, and a new runtime opens the file again. */
async function runWorld(seed: number, path: string, cutAt?: number): Promise<WorldRun> {
  const warnings = warningsOf(seed);
  const clock = fakeWallClock(T0);
  const sources = [worldSource(API, MINUTE, seed, warnings, clock), worldSource(WEA, 2 * MINUTE, seed, warnings, clock, 20 * MINUTE)];
  const options = (log: RuntimeLog, run: string): RuntimeOptions => ({ log, clock, sources, watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run });
  const end = T0 + 120 * MINUTE;
  let log = openRuntimeLog(path);
  let runtime = openRuntime(options(cutAt === undefined ? log : crashing(log, cutAt), "run-0"));
  let restarts = 0;
  const passes: Pass[] = [];
  while (clock.now() < end) {
    let pass: Pass;
    try {
      pass = await runtime.pass();
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      // The restart is at the same time: the clock does not move while the process is down.
      log.close();
      log = openRuntimeLog(path);
      restarts += 1;
      runtime = openRuntime(options(log, `run-${restarts}`));
      continue;
    }
    passes.push(pass);
    await clock.advance(Math.max(1, Math.min(pass.wakeAt ?? end, end) - clock.now()));
  }
  const events = [...log.read()];
  log.close();
  return { state: runtime.state(), config: runtime.config, events, passes, restarts };
}

describe("a restart of the runtime", () => {
  it("rebuilds from the log the state of a run with no cut, for a cut at a random event", async () => {
    let systemReports = 0;
    let failures = 0;
    let fatal = 0;
    let carried = 0;
    for (const seed of SEEDS) {
      const label = `seed ${seed} (SEED=${seed} repeats it)`;
      const place = folder();
      const whole = await runWorld(seed, join(place, "whole.sqlite"));
      // The fold of each event equals the rebuild of the whole log.
      expect(rebuild(whole.events, whole.config), label).toEqual(whole.state);

      const cutAt = random(seed).fork("cut").int(1, whole.events.length - 1);
      const cut = await runWorld(seed, join(place, "cut.sqlite"), cutAt);
      expect(cut.restarts, label).toBe(1);
      expect(cut.state, `${label}, cut at the event ${cutAt}`).toEqual(whole.state);
      expect(rebuild(cut.events, cut.config), label).toEqual(cut.state);
      // A restart adds its start to the log, and nothing else: each fetch and each system step is the same.
      expect(cut.events.filter(isWork), label).toEqual(whole.events.filter(isWork));

      systemReports += whole.state.lines.count;
      failures += whole.events.filter((event) => event.type === "fetch" && event.record.failure !== undefined).length;
      fatal += whole.events.filter((event) => event.type === "fetch" && event.record.fatal > 0).length;
      carried += whole.state.merge.reports.filter((entry) => entry.source === WEA).length;
    }
    // The worlds hold each part of the fold: failed fetches, fatal problems, carriages and system reports.
    expect(failures).toBeGreaterThan(0);
    expect(fatal).toBeGreaterThan(0);
    expect(carried).toBeGreaterThan(0);
    expect(systemReports).toBeGreaterThan(0);
  }, 120_000);
});

describe("one pass of the runtime", () => {
  // A source with a fetch of the test.
  function scripted(id: SourceId, fetch: SourceProcedures["fetch"]): SourceProcedures {
    return { describe: () => descriptor(id, MINUTE), fetch, map };
  }

  function open(sources: readonly SourceProcedures[], extra: Partial<RuntimeOptions> = {}) {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    try {
      const runtime = openRuntime({ log, clock, sources, watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0", ...extra });
      return { clock, log, runtime };
    } catch (error) {
      log.close();
      throw error;
    }
  }

  it("keeps each open line of a quota when the read of the quotas throws, and ends the lines when the quotas have no stage", async () => {
    let read = (): readonly ChannelQuota[] => [{ channel: "pushover" as ChannelId, limit: 100, reserve: 10, used: 95 }];
    // With no source, the pass also opens a line of the coverage. The test reads only the lines of the quota.
    const quotaReports = (pass: Pass) => pass.view.step.reports.filter((report) => report.kind.code.startsWith("system.quota.")).map((report) => [report.op, report.kind.code]);
    const { runtime, log } = open([], { quotas: () => read() });
    expect(quotaReports(await runtime.pass())).toEqual([
      ["alert", "system.quota.low"],
      ["alert", "system.quota.reserve"],
    ]);
    read = () => {
      throw new Error("The disk is full.");
    };
    expect(quotaReports(await runtime.pass())).toEqual([]);
    expect(Object.keys(runtime.state().lines.open).filter((name) => name.startsWith("quota/"))).toEqual(["quota/pushover/low", "quota/pushover/reserve"]);
    read = () => [];
    expect(quotaReports(await runtime.pass())).toEqual([
      ["cancel", "system.quota.low"],
      ["cancel", "system.quota.reserve"],
    ]);
    log.close();
  });

  it("records a timeout when a fetch takes longer than its limit, and ends the pass", async () => {
    const { clock, runtime, log } = open([scripted(API, () => new Promise<FetchOutcome>(() => undefined))], { fetchLimit: () => 5_000 });
    const running = runtime.pass();
    await clock.advance(5_000);
    const pass = await running;
    expect(pass.fetched).toEqual([API]);
    expect(runtime.state().health[API]?.lastFailure?.failure.kind).toBe("timeout");
    log.close();
  });

  it("records a fetch that throws as a failure, and fetches the other sources", async () => {
    const good = scripted(WEA, async () => ({ ok: true, observations: [observation(WEA, "w1", T0, { key: "w1", issued: T0 })], complete: true }));
    const { runtime, log } = open([scripted(API, () => Promise.reject(new Error("The adapter has a defect."))), good]);
    const pass = await runtime.pass();
    expect(pass.fetched).toEqual([API, WEA]);
    expect(runtime.state().health[API]?.lastFailure?.failure).toEqual({ kind: "network", message: "The fetch threw: The adapter has a defect." });
    expect(runtime.state().merge.reports.map((entry) => entry.key)).toEqual(["w1"]);
    log.close();
  });

  it("keeps one event for an observation that repeats, and counts it as new one time", async () => {
    const seen = observation(API, "w1", T0, { key: "w1", issued: T0 });
    const { clock, runtime, log } = open([scripted(API, async () => ({ ok: true, observations: [seen, seen], complete: true }))]);
    await runtime.pass();
    await clock.advance(MINUTE);
    await runtime.pass();
    const fetches = [...log.read()].flatMap((event) => (event.type === "fetch" ? [event.record.fresh] : []));
    expect(fetches).toEqual([1, 0]);
    expect([...log.read()].filter((event) => event.type === "observation")).toHaveLength(1);
    log.close();
  });

  it("records a map that throws as a fatal problem", async () => {
    const seen = observation(API, "w1", T0, { key: "w1", issued: T0 });
    const source: SourceProcedures = {
      describe: () => descriptor(API, MINUTE),
      fetch: async () => ({ ok: true, observations: [seen], complete: true }),
      map: () => {
        throw new Error("The map has a defect.");
      },
    };
    const { runtime, log } = open([source]);
    await runtime.pass();
    const event = [...log.read()].find((entry) => entry.type === "fetch");
    expect(event?.type === "fetch" ? [event.record.fatal, event.problems] : undefined).toEqual([1, [{ path: "", message: "The map threw: The map has a defect.", fatal: true }]]);
    log.close();
  });

  it("counts the lossy problems of a fetch, and not the notes", async () => {
    const seen = [observation(API, "w1", T0, { key: "w1", issued: T0 }), observation(API, "w2", T0, { key: "w2", issued: T0 })];
    const source: SourceProcedures = {
      describe: () => descriptor(API, MINUTE),
      fetch: async () => ({ ok: true, observations: seen, complete: true }),
      map: ({ observation: one }) => ({
        ...map({ observation: one }),
        problems: [
          { path: "properties.severity", message: "an unknown value", fatal: false, lossy: true },
          { path: "properties.colour", message: "an unknown field", fatal: false },
        ],
      }),
    };
    const { runtime, log } = open([source]);
    await runtime.pass();
    const event = [...log.read()].find((entry) => entry.type === "fetch");
    expect(event?.type === "fetch" ? [event.record.fatal, event.record.lossy, event.problems.length] : undefined).toEqual([0, 2, 4]);
    log.close();
  });

  it("keeps the state of the log when a write fails, and does the work again in the next pass", async () => {
    const clock = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    let fail = true;
    const flaky: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        if (fail && events.some((event) => event.type === "fetch")) {
          fail = false;
          throw new Error("The disk is full.");
        }
        return inner.appendAll(events, accept);
      },
    };
    const seen = observation(API, "w1", T0, { key: "w1", issued: T0 });
    const source = scripted(API, async () => ({ ok: true, observations: [seen], complete: true }));
    const runtime = openRuntime({ log: flaky, clock, sources: [source], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run: "run-0" });
    await expect(runtime.pass()).rejects.toThrow("The disk is full.");
    expect(runtime.state()).toEqual(rebuild(inner.read(), runtime.config));
    const pass = await runtime.pass();
    expect(pass.fetched).toEqual([API]);
    expect(runtime.state().merge.reports.map((entry) => entry.key)).toEqual(["w1"]);
    inner.close();
  });

  it("gives each source the watch of that source", async () => {
    const got: [SourceId, Watch][] = [];
    const record = (id: SourceId) => scripted(id, async (input) => (got.push([id, input.watch]), { ok: true, observations: [], complete: true }));
    // Only the second source gets the position: a public point in Wichita KS.
    const watches: Record<string, Watch> = { [API]: { places: [KANSAS] }, [WEA]: { places: [{ ...KANSAS, at: [-97.34, 37.69] }], kinds: ["met"] } };
    const { runtime, log } = open([record(API), record(WEA)], { watch: (source) => watches[source.id] ?? { places: [] } });
    await runtime.pass();
    expect(got).toEqual([
      [API, watches[API]],
      [WEA, watches[WEA]],
    ]);
    log.close();
  });

  it("gives each pass to the hook, with the time of the next pass", async () => {
    const got: Pass[] = [];
    const { runtime, log } = open([scripted(API, async () => ({ ok: true, observations: [], complete: true }))], { onPass: (pass) => void got.push(pass) });
    const pass = await runtime.pass();
    expect(got).toEqual([pass]);
    expect(pass.wakeAt).toBe(T0 + MINUTE);
    log.close();
  });

  it("refuses two sources with the same id", () => {
    const source = scripted(API, async () => ({ ok: true, observations: [], complete: true }));
    expect(() => open([source, source])).toThrow("Two sources have the id api.");
  });
});
