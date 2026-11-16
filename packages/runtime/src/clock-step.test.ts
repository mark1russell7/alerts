import { fakeClock, frameClock, type Cancel, type FakeClock, type WallClock } from "@mark1russell7/algebra/clock";
import { CLOCK_STEP_ABOVE, reportId, type Observation, type ObservationId, type PlaceId, type Report, type SourceId, type SourceProcedures, type WatchedPlace } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "./events.ts";
import { openRuntimeLog } from "./log.ts";
import { openRuntime } from "./runtime.ts";
import { rebuild } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const API = "api" as SourceId;

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };

/** A wall clock on a monotonic clock. A step changes the wall clock only. The timers wait monotonic time. */
function steppingWall(monotonic: FakeClock): WallClock & { step(size: number): void } {
  let offset = 0;
  return {
    time: "wall",
    now: () => monotonic.now() + offset,
    after: (ms: number, run: () => void): Cancel => monotonic.after(ms, run),
    step(size) {
      offset += size;
    },
  };
}

describe("a step of the wall clock in the runtime (AL-49)", () => {
  function observation(at: number): Observation {
    return { id: "api:w1" as ObservationId, source: API, fetched: at, contentType: "application/json", body: JSON.stringify({ key: "w1" }), transport: { latency: 0 } };
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
      expires: T0 + 10 * HOUR,
      areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
      about: [],
      sender: "w-nws.webmaster@noaa.gov",
      headline: "Tornado Warning",
      observation: seen.id,
      parameters: {},
    };
  }

  // A runtime on a frame clock, with one source that gives the same warning at each fetch.
  function open() {
    const monotonic = fakeClock(T0);
    const wall = steppingWall(monotonic);
    const clock = frameClock(wall, monotonic, { driftLimit: CLOCK_STEP_ABOVE });
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
    const log = openRuntimeLog(":memory:");
    const runtime = openRuntime({
      log,
      clock,
      sources: [source],
      watch: () => ({ places: [KANSAS], kinds: ["met"] }),
      view: { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } },
      run: "run-0",
    });
    const events = (): RuntimeEvent[] => [...log.read()];
    return { monotonic, wall, runtime, log, events };
  }

  it("writes one clock event for a step back, moves each own instant, and the rebuild equals the fold", async () => {
    const t = open();
    try {
      expect((await t.runtime.pass()).stepped).toBeUndefined();
      t.wall.step(-HOUR);
      await t.monotonic.advance(MINUTE);
      const pass = await t.runtime.pass();
      expect(pass.stepped).toBe(-HOUR);
      expect(pass.at).toBe(T0 + MINUTE - HOUR);
      expect(pass.conflicts).toEqual([]);
      expect(t.events().filter((event) => event.type === "clock")).toMatchObject([{ id: "clock:1", time: T0 + MINUTE - HOUR, size: -HOUR }]);
      const state = t.runtime.state();
      expect(state.steps).toEqual([{ at: T0 + MINUTE - HOUR, size: -HOUR }]);
      // The time of the receipt is an own instant, and it moves. The time of the source does not move.
      expect(state.merge.reports.find((entry) => entry.source === API)).toMatchObject({ received: T0 - HOUR, sent: T0 });
      expect(state.fetched[API]).toBe(T0 + MINUTE - HOUR);
      expect(state.merge.reports.filter((entry) => entry.kind.code === "system.clock.step").map((entry) => entry.headline)).toEqual(["The wall clock stepped back by 1 h."]);
      expect(rebuild(t.events(), t.runtime.config)).toEqual(state);
      // The next pass has no step, and the next fetch comes after one interval on the monotonic clock.
      expect(pass.wakeAt).toBe(T0 + 2 * MINUTE - HOUR);
      await t.monotonic.advance(MINUTE);
      const next = await t.runtime.pass();
      expect(next.stepped).toBeUndefined();
      expect(next.fetched).toEqual([API]);
      expect(t.events().filter((event) => event.type === "clock")).toHaveLength(1);
    } finally {
      t.log.close();
    }
  });

  it("tags the ids from a time after a step, thus a time of the new frame that repeats a time of the log is a new event", async () => {
    const t = open();
    try {
      await t.runtime.pass();
      // The step back of one interval gives the second fetch the time of the first fetch.
      t.wall.step(-MINUTE);
      await t.monotonic.advance(MINUTE);
      const pass = await t.runtime.pass();
      expect(pass.at).toBe(T0);
      expect(pass.conflicts).toEqual([]);
      expect(t.events().filter((event) => event.type === "fetch").map((event) => event.id)).toEqual([`fetch:api:${T0}`, `fetch:api:${T0}~1`]);
      expect(rebuild(t.events(), t.runtime.config)).toEqual(t.runtime.state());
    } finally {
      t.log.close();
    }
  });

  it("writes no clock event for a drift of 2 s or less, and moves the own instants forward for a step forward", async () => {
    const t = open();
    try {
      await t.runtime.pass();
      t.wall.step(CLOCK_STEP_ABOVE);
      await t.monotonic.advance(MINUTE);
      const drift = await t.runtime.pass();
      expect(drift.stepped).toBeUndefined();
      // The mark takes the wall time, thus the pass has the time of the wall clock with the drift.
      expect(drift.at).toBe(T0 + MINUTE + CLOCK_STEP_ABOVE);
      t.wall.step(HOUR);
      await t.monotonic.advance(MINUTE);
      const forward = await t.runtime.pass();
      expect(forward.stepped).toBe(HOUR);
      expect(t.runtime.state().merge.reports.find((entry) => entry.source === API)?.received).toBe(T0 + HOUR);
      expect(t.events().filter((event) => event.type === "clock")).toMatchObject([{ id: "clock:1", size: HOUR }]);
      expect(rebuild(t.events(), t.runtime.config)).toEqual(t.runtime.state());
    } finally {
      t.log.close();
    }
  });
});
