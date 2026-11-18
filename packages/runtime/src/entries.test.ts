import { fakeWallClock, type WallClock } from "@mark1russell7/algebra/clock";
import { EMPTY_STATE, reportId, type MergeState, type ObservationId, type PlaceId, type Report, type ReportId, type SourceId, type SourceProcedures, type WatchedPlace } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { entryIndex } from "./entries.ts";
import { envelope, type RuntimeEvent } from "./events.ts";
import { importOf, parsePage, sharedItem } from "./exchange.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openRuntime, type Runtime, type RuntimeOptions } from "./runtime.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const MINUTE = 60_000;
const API = "api" as SourceId;
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

function report(key: string, received: number): Report {
  return {
    id: reportId({ source: API, key, sent: T0 }),
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
    sent: T0,
    received,
    expires: T0 + 600 * MINUTE,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "NWS Wichita KS",
    headline: "Tornado Warning",
    observation: `api:${key}` as ObservationId,
    parameters: {},
  };
}

const fetched = (id: string, time: number, reports: readonly Report[]): RuntimeEvent => ({
  ...envelope("fetch", id, time),
  record: { source: API, at: time, took: 100, fresh: reports.length, fatal: 0 },
  reports,
  problems: [],
});
const ended = (time: number, reports: readonly ReportId[]): RuntimeEvent => ({ ...envelope("ended", `ended:${API}:${time}`, time), source: API, reports });
const exchanged = (peer: string, next: number, time: number): RuntimeEvent => ({ ...envelope("exchange", `exchange:${peer}:log:${next}`, time), peer, log: "log", next });
const stepped = (time: number, size: number): RuntimeEvent => ({ ...envelope("clock", `clock:${time}`, time), size });
const retired = (time: number, reports: readonly ReportId[]): RuntimeEvent => ({ ...envelope("retired", `retired:${time}`, time), reports, until: time + MINUTE, cancelled: [] });

// The import of an event of the copy b.
function imported(event: RuntimeEvent): RuntimeEvent {
  const item = sharedItem(event, "b");
  if (item === undefined) throw new Error(`The event ${event.id} is not a shared event.`);
  return importOf(item);
}

const w1 = report("w1", T0);
const w2 = report("w2", T0 + MINUTE);
const merge = (reports: readonly Report[], fields: Partial<MergeState> = {}): MergeState => ({ ...EMPTY_STATE, reports, ...fields });

describe("entryIndex", () => {
  it("gives an import the time of the exchange event of its read, and keeps the first stamp", () => {
    const index = entryIndex();
    for (const event of [imported(fetched("b:1", T0 + MINUTE, [w2])), exchanged("b", 1, T0 + 30 * MINUTE)]) index.add(event);
    expect(index.times(EMPTY_STATE).report(w2)).toBe(T0 + 30 * MINUTE);
    // A later read of the same report changes nothing.
    for (const event of [imported(fetched("b:2", T0 + 2 * MINUTE, [w2])), exchanged("b", 2, T0 + 40 * MINUTE)]) index.add(event);
    expect(index.times(EMPTY_STATE).report(w2)).toBe(T0 + 30 * MINUTE);
    // The flip: a report with no stamp has its time of receipt.
    expect(index.times(EMPTY_STATE).report(w1)).toBe(T0);
  });

  it("waits for the exchange event of the same copy", () => {
    const index = entryIndex();
    index.add(imported(fetched("b:1", T0 + MINUTE, [w2])));
    index.add(exchanged("c", 1, T0 + 20 * MINUTE));
    expect(index.times(EMPTY_STATE).report(w2)).toBe(w2.received);
    expect(index.size).toBe(1);
    index.add(exchanged("b", 1, T0 + 30 * MINUTE));
    expect(index.times(EMPTY_STATE).report(w2)).toBe(T0 + 30 * MINUTE);
  });

  it("gives a report of both sides the earlier time", () => {
    const index = entryIndex();
    for (const event of [imported(fetched("b:1", T0, [w1])), exchanged("b", 1, T0 + 30 * MINUTE)]) index.add(event);
    expect(index.times(merge([w1])).report(w1)).toBe(T0);
    const late = { ...w1, received: T0 + 50 * MINUTE };
    expect(index.times(merge([late])).report(w1)).toBe(T0 + 30 * MINUTE);
  });

  it("stamps an imported end mark, and an own end mark keeps its time", () => {
    const index = entryIndex();
    for (const event of [imported(ended(T0 + 5 * MINUTE, [w1.id])), exchanged("b", 1, T0 + 30 * MINUTE)]) index.add(event);
    const times = index.times(merge([w1], { ends: [{ report: w1.id, at: T0 + 10 * MINUTE, ended: true }] }));
    expect(times.mark({ report: w1.id, at: T0 + 5 * MINUTE, ended: true })).toBe(T0 + 30 * MINUTE);
    // The flip: the same time with the other kind has no stamp.
    expect(times.mark({ report: w1.id, at: T0 + 5 * MINUTE, ended: false })).toBe(T0 + 5 * MINUTE);
    expect(times.mark({ report: w1.id, at: T0 + 10 * MINUTE, ended: true })).toBe(T0 + 10 * MINUTE);
  });

  it("moves each stamp with a step of the clock, and drops the stamps of retired and pruned reports", () => {
    const index = entryIndex();
    for (const event of [imported(fetched("b:1", T0, [w1, w2])), imported(ended(T0, [w1.id])), exchanged("b", 2, T0 + 30 * MINUTE)]) index.add(event);
    index.add(stepped(T0 + 31 * MINUTE, -10 * MINUTE));
    expect(index.times(EMPTY_STATE).report(w2)).toBe(T0 + 20 * MINUTE);
    expect(index.times(EMPTY_STATE).mark({ report: w1.id, at: T0, ended: true })).toBe(T0 + 20 * MINUTE);
    expect(index.size).toBe(3);
    index.add(retired(T0 + 40 * MINUTE, [w1.id]));
    expect(index.size).toBe(1);
    index.prune(merge([w1]));
    expect(index.size).toBe(0);
    expect(index.times(EMPTY_STATE).report(w2)).toBe(w2.received);
  });
});

describe("the times of entry of a runtime", () => {
  // A source that gives the same warnings at each fetch.
  function source(keys: readonly string[], clock: WallClock): SourceProcedures {
    return {
      describe: () => ({
        id: API,
        title: "The source api",
        origins: ["nws"],
        dependsOn: ["provider:api"],
        uses: ["internet", "dns", "power"],
        kinds: ["met"],
        coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
        transport: "poll",
        interval: MINUTE,
        slowAfter: 10_000,
        auth: "none",
      }),
      fetch: async () => ({
        ok: true,
        complete: true,
        observations: keys.map((key) => ({ id: `api:${key}` as ObservationId, source: API, fetched: clock.now(), contentType: "application/json", body: JSON.stringify({ key }), transport: { latency: 0 } })),
      }),
      map: ({ observation: seen }) => ({ reports: [report((JSON.parse(seen.body) as { readonly key: string }).key, seen.fetched)], problems: [] }),
    };
  }

  const open = (copy: string, keys: readonly string[], clock: WallClock, log: RuntimeLog, run = `run-${copy}`): Runtime =>
    openRuntime({ log, clock, sources: [source(keys, clock)], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run, copy });

  it("gives an imported report the time of the take on this copy, also after a restart", async () => {
    const clockA = fakeWallClock(T0);
    const clockB = fakeWallClock(T0);
    const logA = openRuntimeLog(":memory:");
    const a = open("a", ["w1"], clockA, logA);
    const b = open("b", ["w1", "w2"], clockB, openRuntimeLog(":memory:"));
    await a.pass();
    await b.pass();
    // The copy a reads the page of b 25 minutes later.
    await clockA.advance(25 * MINUTE);
    const parsed = parsePage(JSON.parse(JSON.stringify(b.share(a.position("b")))));
    if (parsed.tag !== "ok") throw new Error(parsed.error.join(" "));
    expect(a.take(parsed.value).imports).toBeGreaterThan(0);
    const w2Report = a.state().merge.reports.find((one) => one.key === "w2");
    const w1Report = a.state().merge.reports.find((one) => one.key === "w1");
    if (w2Report === undefined || w1Report === undefined) throw new Error("The copy a has no report w1 or w2.");
    expect(w2Report.received).toBe(T0);
    expect(a.entered().report(w2Report)).toBe(T0 + 25 * MINUTE);
    // The copy a fetched w1 before the read, thus w1 keeps its own time.
    expect(a.entered().report(w1Report)).toBe(T0);
    // A restart folds the same log, thus it gives the same times.
    const again = open("a", ["w1"], clockA, logA, "run-a2");
    expect(again.entered().report(w2Report)).toBe(T0 + 25 * MINUTE);
    expect(again.entered().report(w1Report)).toBe(T0);
  });

  it("moves no stamp when the write of a take fails", async () => {
    const clockA = fakeWallClock(T0);
    const clockB = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    // The first write of an import accepts each event, and then the disk is full.
    let fail = true;
    const flaky: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        if (fail && events.some((event) => event.type === "import")) {
          fail = false;
          for (const event of events) accept(event);
          throw new Error("The disk is full.");
        }
        return inner.appendAll(events, accept);
      },
    };
    const a = open("a", [], clockA, flaky);
    const b = open("b", ["w2"], clockB, openRuntimeLog(":memory:"));
    await b.pass();
    const read = () => {
      const parsed = parsePage(JSON.parse(JSON.stringify(b.share(a.position("b")))));
      if (parsed.tag !== "ok") throw new Error(parsed.error.join(" "));
      return a.take(parsed.value);
    };
    await clockA.advance(25 * MINUTE);
    expect(read).toThrow("The disk is full.");
    expect(a.state().merge.reports).toEqual([]);
    // The read again comes 10 minutes later. Its time is the time of entry, not the time of the failed read.
    await clockA.advance(10 * MINUTE);
    expect(read().imports).toBeGreaterThan(0);
    const [w2Report] = a.state().merge.reports.filter((one) => one.key === "w2");
    if (w2Report === undefined) throw new Error("The copy a has no report w2.");
    expect(a.entered().report(w2Report)).toBe(T0 + 35 * MINUTE);
    inner.close();
  });
});
