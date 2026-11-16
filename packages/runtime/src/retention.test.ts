import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { reportId, TOMBSTONE_LIFE, type ChannelId, type Delivery, type Observation, type ObservationId, type PersonId, type PlaceId, type Report, type ReportId, type SourceId, type SourceProcedures, type WatchedPlace } from "@mark1russell7/alerts";
import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { envelope, type RuntimeEvent } from "./events.ts";
import { importOf, sharedItem } from "./exchange.ts";
import { openRuntimeLog } from "./log.ts";
import { retention, RETIRE_EVERY } from "./retention.ts";
import { openRuntime } from "./runtime.ts";
import { EMPTY_RUNTIME, fold, rebuild, type FoldContext, type RuntimeState } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const API = "api" as SourceId;
const PUSHOVER = "pushover" as ChannelId;
const PERSON = "person-1" as PersonId;
const CONTEXT: FoldContext = { sources: [] };
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

/** One tornado warning for a county of Kansas, sent at `sent`, that a copy received at `received`. */
function report(key: string, received: number, sent = T0): Report {
  return {
    id: reportId({ source: API, key, sent }),
    source: API,
    origin: "nws",
    key,
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
    sent,
    received,
    expires: sent + HOUR,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: `api:${key}` as ObservationId,
    parameters: {},
  };
}

const W1 = report("w1", T0).id;
const W2 = report("w2", T0).id;

const delivery = (key: string, incident: ReportId, at: number): Delivery => ({ key, incident, level: "life-safety", person: PERSON, channel: PUSHOVER, step: 0, at });
const started = (run: string, time: number): RuntimeEvent => ({ ...envelope("started", `started:${run}`, time), run });
const fetched = (id: string, time: number, reports: readonly Report[]): RuntimeEvent => ({
  ...envelope("fetch", id, time),
  record: { source: API, at: time, took: 100, fresh: reports.length, fatal: 0 },
  reports,
  problems: [],
});
const delivered = (key: string, incident: ReportId, time: number): RuntimeEvent => ({ ...envelope("delivery", `delivery:${key}`, time), delivery: delivery(key, incident, time) });
const cancelled = (key: string, time: number): RuntimeEvent => ({ ...envelope("cancelled", `cancelled:${key}`, time), delivery: key });
const escalation = (incident: ReportId, time: number): RuntimeEvent => ({ ...envelope("escalation", `escalation:${incident}`, time), start: { incident, level: "life-safety", person: PERSON, at: time } });
const endOf = (incident: ReportId, time: number): RuntimeEvent => ({ ...envelope("escalation-end", `escalation-end:${incident}:${PERSON}:0`, time), end: { incident, person: PERSON, at: time } });
const ended = (time: number, reports: readonly ReportId[]): RuntimeEvent => ({ ...envelope("ended", `ended:${API}:${time}`, time), source: API, reports });
const stepped = (n: number, time: number, size: number): RuntimeEvent => ({ ...envelope("clock", `clock:${n}`, time), size });
const retired = (time: number, reports: readonly ReportId[], until: number, keys: readonly string[] = []): RuntimeEvent => ({
  ...envelope("retired", `retired:${time}`, time),
  reports: [...reports].sort(),
  until,
  cancelled: [...keys].sort(),
});

/** The import of a shared event of the copy `b`. */
function imported(event: RuntimeEvent): RuntimeEvent {
  const item = sharedItem(event, "b");
  if (item === undefined) throw new Error(`The event ${event.id} is not a shared event.`);
  return importOf(item);
}

const foldAll = (events: readonly RuntimeEvent[]): RuntimeState => events.reduce((state, event) => fold(state, event, CONTEXT), EMPTY_RUNTIME);
const ids = (reports: readonly { readonly id: ReportId }[]): ReportId[] => reports.map((one) => one.id).sort();

// Each part of a report with a live tombstone of the own side is out of each merge state, and the imported side has no tombstone.
function expectNoRetiredPart(state: RuntimeState): void {
  const gone = new Set(state.own.merge.retired.map((tombstone) => tombstone.report));
  for (const merge of [state.merge, state.own.merge, state.imported.merge]) {
    expect(merge.reports.filter((one) => gone.has(one.id))).toEqual([]);
    expect(merge.deliveries.filter((one) => gone.has(one.incident))).toEqual([]);
    expect(merge.acks.filter((one) => gone.has(one.incident))).toEqual([]);
    expect(merge.ends.filter((one) => gone.has(one.report))).toEqual([]);
  }
  expect(state.imported.merge.retired).toEqual([]);
}

describe("the fold of a retirement (AL-47)", () => {
  const until = T0 + 8 * DAY + TOMBSTONE_LIFE;
  const events: RuntimeEvent[] = [
    started("run-a", T0),
    fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]),
    imported(fetched("fetch:1", T0 + 2 * SECOND, [report("w1", T0 + 2 * SECOND), report("w2", T0 + 2 * SECOND)])),
    escalation(W1, T0 + 3 * SECOND),
    delivered("k1", W1, T0 + 3 * SECOND),
    imported(delivered("k2", W2, T0 + 4 * SECOND)),
    cancelled("k1", T0 + 5 * SECOND),
    endOf(W1, T0 + 6 * SECOND),
    imported(endOf(W2, T0 + 7 * SECOND)),
    stepped(1, T0 + 8 * SECOND + 5 * MINUTE, 5 * MINUTE),
    retired(T0 + 8 * DAY, [W1], until, ["k1"]),
    // A late copy of each part of the retired incident: a fetch of this copy, and the shared events of the other copy.
    fetched("fetch:2", T0 + 8 * DAY + HOUR, [report("w1", T0 + 8 * DAY + HOUR)]),
    imported(fetched("fetch:2", T0 + 8 * DAY + HOUR, [report("w1", T0 + 8 * DAY + HOUR)])),
    imported(delivered("k3", W1, T0 + 8 * DAY + HOUR)),
    imported(ended(T0 + 8 * DAY + HOUR, [W1])),
    imported(endOf(W1, T0 + 8 * DAY + 2 * HOUR)),
    // The second retirement drops the first tombstone, because its time is after the end of the tombstone.
    retired(until + HOUR, [W2], until + HOUR + TOMBSTONE_LIFE),
    fetched("fetch:3", until + 2 * HOUR, [report("w1", until + 2 * HOUR)]),
  ];
  const at = (count: number): RuntimeState => foldAll(events.slice(0, count));
  const firstRetirement = events.findIndex((event) => event.type === "retired") + 1;

  it("gives the state of the rebuild after each event", () => {
    for (let count = 1; count <= events.length; count += 1) expect(at(count)).toEqual(rebuild(events.slice(0, count), CONTEXT));
  });

  it("removes each part of the retired incident from each side, and keeps the other incident", () => {
    const state = at(firstRetirement);
    expect(ids(state.merge.reports)).toEqual([W2]);
    expect(state.own.merge.reports).toEqual([]);
    expect(ids(state.imported.merge.reports)).toEqual([W2]);
    expect(state.merge.deliveries.map((one) => one.key)).toEqual(["k2"]);
    expect(state.own.merge.retired).toEqual([{ report: W1, until }]);
    expectNoRetiredPart(state);
  });

  it("drops the escalation starts, the escalation ends and the cancelled keys of the retired incident", () => {
    const before = at(firstRetirement - 1);
    expect(before.starts.map((start) => start.incident)).toEqual([W1]);
    expect(before.cancelled).toEqual(["k1"]);
    const state = at(firstRetirement);
    expect(state.starts).toEqual([]);
    expect(state.cancelled).toEqual([]);
    expect(state.escalationEnds.map((end) => end.incident)).toEqual([W2]);
  });

  it("keeps a late copy of a retired report out, from this copy and by import from the other copy", () => {
    const state = at(firstRetirement + 5);
    expect(ids(state.merge.reports)).toEqual([W2]);
    expect(state.merge.deliveries.map((one) => one.key)).toEqual(["k2"]);
    expect(state.merge.ends).toEqual([]);
    expect(state.escalationEnds.map((end) => end.incident)).toEqual([W2]);
    expectNoRetiredPart(state);
  });

  it("drops a tombstone at a later retirement after its end, and then a new copy of the report comes back", () => {
    const pruned = at(events.length - 1);
    expect(pruned.own.merge.retired).toEqual([{ report: W2, until: until + HOUR + TOMBSTONE_LIFE }]);
    expect(pruned.merge.reports).toEqual([]);
    const state = at(events.length);
    expect(ids(state.merge.reports)).toEqual([W1]);
  });

  it("moves each tombstone at a step of the clock, as each own instant", () => {
    const state = foldAll([...events.slice(0, firstRetirement), stepped(2, T0 + 9 * DAY, -2 * MINUTE)]);
    expect(state.own.merge.retired).toEqual([{ report: W1, until: until - 2 * MINUTE }]);
    expect(rebuild([...events.slice(0, firstRetirement), stepped(2, T0 + 9 * DAY, -2 * MINUTE)], CONTEXT)).toEqual(state);
  });
});

// A random log of one copy with imports, steps of the clock and retirements. The reports come from a small pool, thus the retirements and the late copies meet.
function randomLog(r: Random): RuntimeEvent[] {
  const pool = Array.from({ length: 6 }, (_, index) => `w${index}`);
  const idOf = (key: string): ReportId => report(key, T0).id;
  const events: RuntimeEvent[] = [started("run-a", T0)];
  let time = T0;
  let steps = 0;
  for (let index = 0; index < 60; index += 1) {
    time += r.int(1, 48) * HOUR;
    const key = r.pick(pool);
    const choice = r.below(9);
    const own = r.chance(0.5);
    const event = (): RuntimeEvent => {
      switch (choice) {
        case 0:
          return fetched(`fetch:${index}`, time, [report(key, time)]);
        case 1:
          return delivered(`k${index}`, idOf(key), time);
        case 2:
          return ended(time, [idOf(key)]);
        case 3:
          return endOf(idOf(key), time);
        case 4:
          return cancelled(`k${r.below(index + 1)}`, time);
        case 5:
          steps += 1;
          return stepped(steps, time, r.pick([-5, 5, 60]) * MINUTE);
        case 6:
          return escalation(idOf(key), time);
        default: {
          const reports = pool.filter(() => r.chance(0.4)).map(idOf);
          return retired(time, reports, time + r.int(1, 120) * HOUR, [`k${r.below(index + 1)}`]);
        }
      }
    };
    const made = event();
    // Only a shared event can come by import.
    const canImport = made.type !== "clock" && made.type !== "escalation" && made.type !== "retired";
    events.push(canImport && !own ? imported(made) : made);
  }
  return events;
}

describe("a random log with retirements", () => {
  it.each(SEEDS)("gives the state of the rebuild after each event, and keeps each retired part out (seed %i)", (seed) => {
    const events = randomLog(random(seed));
    let state = EMPTY_RUNTIME;
    let retirements = 0;
    for (let count = 1; count <= events.length; count += 1) {
      const event = events[count - 1]!;
      state = fold(state, event, CONTEXT);
      if (event.type === "retired") retirements += 1;
      expectNoRetiredPart(state);
      if (count % 10 === 0 || count === events.length) expect(state).toEqual(rebuild(events.slice(0, count), CONTEXT));
    }
    expect(retirements).toBeGreaterThan(0);
  });
});

describe("the retirement in the pass", () => {
  // A source that gives the same warning at each fetch: a feed that lists an old report for a long time.
  function source(clock: ReturnType<typeof fakeWallClock>): SourceProcedures {
    const observation = (at: number): Observation => ({ id: `api:w1:${String(at)}` as ObservationId, source: API, fetched: at, contentType: "application/json", body: JSON.stringify({ key: "w1" }), transport: { latency: 0 } });
    return {
      describe: () => ({
        id: API,
        title: "The source api",
        origins: ["nws"],
        dependsOn: ["provider:api"],
        uses: ["internet", "power"],
        kinds: ["met"],
        coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
        transport: "poll",
        interval: HOUR,
        slowAfter: 10_000,
        auth: "none",
      }),
      fetch: async () => ({ ok: true, observations: [observation(clock.now())], complete: true }),
      map: ({ observation: seen }) => ({ reports: [report("w1", seen.fetched)], problems: [] }),
    };
  }

  const open = (log: ReturnType<typeof openRuntimeLog>, clock: ReturnType<typeof fakeWallClock>, run: string) =>
    openRuntime({
      log,
      clock,
      sources: [source(clock)],
      watch: () => ({ places: [KANSAS], kinds: ["met"] }),
      view: { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } },
      run,
      retention: { horizon: 2 * HOUR, life: 6 * HOUR, every: HOUR },
    });

  it("writes one retired event for an old incident, keeps the next copies out, and a restart gives the same state", async () => {
    const log = openRuntimeLog(":memory:");
    const clock = fakeWallClock(T0);
    const runtime = open(log, clock, "run-1");
    await runtime.pass();
    expect(ids(runtime.state().merge.reports)).toEqual([W1]);
    // The warning expires at T0 + 1 h. The last change is the expiry, thus it retires at T0 + 3 h.
    await clock.advance(3 * HOUR);
    await runtime.pass();
    const retirements = [...log.entries({ types: ["retired"] })].map((entry) => entry.event);
    expect(retirements).toMatchObject([{ type: "retired", reports: [W1], until: T0 + 9 * HOUR, cancelled: [] }]);
    expect(runtime.state().merge.reports).toEqual([]);
    // The feed lists the report again. The tombstone keeps it out.
    await clock.advance(HOUR);
    await runtime.pass();
    expect(runtime.state().merge.reports).toEqual([]);
    expect(rebuild(log.read(), runtime.config)).toEqual(runtime.state());
    const again = open(log, clock, "run-2");
    expect(again.state().merge).toEqual(runtime.state().merge);
    log.close();
  });

  it("searches at most once in each interval", async () => {
    const log = openRuntimeLog(":memory:");
    const clock = fakeWallClock(T0);
    const runtime = open(log, clock, "run-1");
    await runtime.pass();
    // At T0 + 3 h - 1 min, the incident is not old enough. The next pass in the interval does not search again.
    await clock.advance(3 * HOUR - MINUTE);
    await runtime.pass();
    await clock.advance(2 * MINUTE);
    await runtime.pass();
    expect([...log.entries({ types: ["retired"] })]).toEqual([]);
    await clock.advance(HOUR);
    await runtime.pass();
    expect([...log.entries({ types: ["retired"] })]).toHaveLength(1);
    log.close();
  });
});

describe("retention", () => {
  it("gives the defaults of the core and an interval of one hour", () => {
    expect(retention()).toEqual({ horizon: 7 * DAY, life: TOMBSTONE_LIFE, every: RETIRE_EVERY });
    expect(RETIRE_EVERY).toBe(HOUR);
  });

  it("refuses a time that is not a finite number of 0 or more, and an interval of 0", () => {
    expect(() => retention({ horizon: -1 })).toThrow("The horizon of the retention is -1");
    expect(() => retention({ life: Number.NaN })).toThrow("The life of the retention is NaN");
    expect(() => retention({ every: 0 })).toThrow("The interval of the retirements is 0");
  });
});
