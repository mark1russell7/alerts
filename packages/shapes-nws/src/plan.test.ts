import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { dropsOf, listKey, plan, taskId, zoneKey, type CachedList, type CachedZone, type PlanInput, type ShapeState, type Task } from "./plan.ts";
import type { ZoneKind } from "./zones.ts";

const NOW = Date.UTC(2026, 10, 15, 18, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const REFRESH = 7 * DAY;

const list = (state: string, kind: ZoneKind, ids: string[], fetched = NOW): CachedList => ({ state, kind, ids, fetched });
const zone = (id: string, fetched = NOW): CachedZone => ({
  kind: id[2] === "C" ? "county" : "forecast",
  id,
  state: id.slice(0, 2),
  name: id,
  fetched,
  shapes: [],
});
const records = (lists: CachedList[], zones: CachedZone[]): ShapeState => ({
  lists: new Map(lists.map((item) => [listKey(item.state, item.kind), item])),
  zones: new Map(zones.map((item) => [zoneKey(item), item])),
});
const input = (state: ShapeState, extra: Partial<PlanInput> = {}): PlanInput => ({ state, wanted: { states: ["KS"] }, now: NOW, refreshMs: REFRESH, retryAt: () => undefined, ...extra });
const ids = (tasks: readonly Task[]): string[] => tasks.map(taskId);

describe("plan", () => {
  it("asks for the two lists of a new state", () => {
    expect(plan(input(records([], [])))).toEqual({ tasks: [{ type: "list", state: "KS", kind: "county" }, { type: "list", state: "KS", kind: "forecast" }] });
  });

  it("puts the zones of the codes first, then the lists, then the zones of the lists", () => {
    const state = records([list("KS", "county", ["KSC015", "KSC173"])], [zone("KSC015")]);
    const wanted = { states: ["ks"], codes: [{ system: "ugc", code: "TXC167" }, { system: "same", code: "020173" }, { system: "state", code: "KS" }] };
    expect(ids(plan(input(state, { wanted })).tasks)).toEqual(["zone:county:TXC167", "zone:county:KSC173", "list:KS:forecast"]);
  });

  it("asks again for the records older than the refresh period, from the oldest, and tells the next time", () => {
    const state = records(
      [list("KS", "county", ["KSC015", "KSC079", "KSC173"], NOW - REFRESH), list("KS", "forecast", [], NOW - DAY)],
      [zone("KSC015", NOW - REFRESH + 10), zone("KSC079", NOW - REFRESH - 10), zone("KSC173", NOW - 2 * DAY)],
    );
    expect(plan(input(state))).toEqual({
      tasks: [
        { type: "list", state: "KS", kind: "county" },
        { type: "zone", key: { kind: "county", id: "KSC079" } },
      ],
      next: NOW + 10,
    });
  });

  it("waits until the time of retryAt, also for a task with no record", () => {
    const state = records([], []);
    const retryAt = (task: Task): number | undefined => (taskId(task) === "list:KS:county" ? NOW + DAY : undefined);
    expect(plan(input(state, { retryAt }))).toEqual({ tasks: [{ type: "list", state: "KS", kind: "forecast" }], next: NOW + DAY });
  });

  it("keeps no task for the zones of a state that is not wanted", () => {
    const state = records([list("TX", "county", ["TXC167"], NOW - REFRESH)], [zone("TXC167", NOW - REFRESH)]);
    expect(plan(input(state, { wanted: { states: ["XX"] } }))).toEqual({ tasks: [] });
  });

  it("has each task once, and the time of each task that waits is later than now", () => {
    const code = fc.constantFrom("KSC015", "KSC079", "KSC173", "KSZ069", "KSZ083", "TXC167");
    const time = fc.integer({ min: NOW - 2 * REFRESH, max: NOW });
    const arbitrary = fc.record({
      listed: fc.uniqueArray(code),
      cached: fc.uniqueArray(fc.tuple(code, time), { selector: ([id]) => id }),
      codes: fc.array(code),
      listTime: time,
      retry: fc.option(fc.integer({ min: NOW - DAY, max: NOW + DAY }), { nil: undefined }),
    });
    fc.assert(
      fc.property(arbitrary, ({ listed, cached, codes, listTime, retry }) => {
        const lists = (["county", "forecast"] as const).map((kind) => list("KS", kind, listed.filter((id) => id.startsWith("KS") && (id[2] === "C") === (kind === "county")), listTime));
        const state = records(lists, cached.map(([id, fetched]) => zone(id, fetched)));
        const result = plan(input(state, { wanted: { states: ["KS"], codes: codes.map((id) => ({ system: "ugc", code: id })) }, retryAt: () => retry }));
        expect(new Set(ids(result.tasks)).size).toBe(result.tasks.length);
        if (result.next !== undefined) expect(result.next).toBeGreaterThan(NOW);
        if (retry !== undefined && retry > NOW) expect(result.tasks).toEqual([]);
      }),
    );
  });
});

describe("dropsOf", () => {
  it("gives the zones of the state and kind that the new list does not have", () => {
    const state = records([], [zone("KSC015"), zone("KSC173"), zone("KSZ083"), zone("TXC167")]);
    expect(dropsOf(state, { state: "KS", kind: "county", ids: ["KSC173"] })).toEqual([{ kind: "county", id: "KSC015" }]);
    expect(dropsOf(state, { state: "KS", kind: "forecast", ids: ["KSZ083"] })).toEqual([]);
  });
});
