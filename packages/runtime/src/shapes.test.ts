import type { Incident, MapRegion, PlaceId, RegionCode, ReportId, WatchedPlace } from "@mark1russell7/alerts";
import type { Refreshed, RefreshInput, ShapeStore } from "@mark1russell7/alerts-shapes-nws";
import { describe, expect, it } from "vitest";
import { keepShapes, liveCodes, shapeReport, wantedShapes } from "./shapes.ts";

const T0 = Date.UTC(2026, 10, 15, 18, 0, 0);
const RING = [
  [-97, 37],
  [-96, 37],
  [-96, 38],
  [-97, 37],
] as const;

// Public places in Kansas and Texas. The codes are public regions, not the places of a person.
const KANSAS: WatchedPlace = { id: "place-ks" as PlaceId, codes: [{ system: "state", code: "KS" }, { system: "ugc", code: "KSZ083" }, { system: "same", code: "020173" }, { system: "iso3166", code: "US" }], bufferKm: 0 };
const TEXAS: WatchedPlace = { id: "place-tx" as PlaceId, codes: [{ system: "ugc", code: "TXC029" }], bufferKm: 5 };

function incident(anchor: string, codes: readonly RegionCode[], live = true): Incident {
  return {
    anchor: anchor.padEnd(64, "0") as ReportId,
    reports: [anchor.padEnd(64, "0") as ReportId],
    status: "actual",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    areas: [...codes.map((code) => ({ type: "code" as const, ...code })), { type: "circle", center: [-97, 37], radiusKm: 5 }],
    about: [],
    live,
    corroboration: 1,
  };
}

const REFRESHED: Refreshed = { requests: 2, failures: [], problems: [], stop: "done" };

/** A fake store. It has a region for each UGC code in `known`, and each refresh waits until the test ends it. */
function fakeStore(known: readonly string[]) {
  const calls: RefreshInput[] = [];
  let end: ((value: Refreshed) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const region = (id: string): MapRegion => ({ code: { system: "ugc", code: id }, name: `Zone ${id}`, shapes: [{ type: "polygon", rings: [RING] }] });
  const zoneOf = (code: RegionCode): string | undefined => {
    const text = code.code.toUpperCase();
    if (code.system === "ugc") return text;
    if (code.system === "same") return text === "020173" ? "KSC173" : undefined;
    return undefined;
  };
  const store: ShapeStore = {
    lookup: (code) => {
      const id = zoneOf(code);
      return id !== undefined && known.includes(id) ? region(id).shapes : undefined;
    },
    region: (code) => {
      const id = zoneOf(code);
      return id !== undefined && known.includes(id) ? region(id) : undefined;
    },
    basemap: () => [],
    nextDue: () => undefined,
    refresh: (input) => {
      calls.push(input);
      return new Promise<Refreshed>((resolve, reject) => {
        end = resolve;
        fail = reject;
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason));
      });
    },
  };
  return { store, calls, end: (value: Refreshed = REFRESHED) => end?.(value), fail: (error: unknown) => fail?.(error) };
}

describe("the codes of the outlines", () => {
  it("gives the codes of the live incidents, once each and in order", () => {
    const incidents = [
      incident("b", [{ system: "ugc", code: "TXC167" }, { system: "same", code: "020173" }]),
      incident("a", [{ system: "ugc", code: "txc167" }, { system: "ugc", code: "KSZ083" }]),
      incident("c", [{ system: "ugc", code: "KSC015" }], false),
    ];
    expect(liveCodes(incidents)).toEqual([
      { system: "same", code: "020173" },
      { system: "ugc", code: "KSZ083" },
      { system: "ugc", code: "TXC167" },
    ]);
  });

  it("wants the states of the places and the codes of the live incidents, and no code of a place", () => {
    const wanted = wantedShapes([TEXAS, KANSAS], [incident("a", [{ system: "ugc", code: "OKC001" }])]);
    expect(wanted).toEqual({ states: ["KS", "TX"], codes: [{ system: "ugc", code: "OKC001" }] });
  });

  it("wants no state for a place with only a country code", () => {
    const world: WatchedPlace = { id: "place-us" as PlaceId, codes: [{ system: "iso3166", code: "US" }], bufferKm: 0 };
    expect(wantedShapes([world], [])).toEqual({ states: [], codes: [] });
  });
});

describe("shapeReport", () => {
  it("gives no text for a refresh with no failure and no problem", () => {
    expect(shapeReport({ ok: true, refreshed: REFRESHED })).toBeUndefined();
  });

  it("names each failure and each problem, and the stop", () => {
    const report = shapeReport({
      ok: true,
      refreshed: { requests: 3, failures: [{ task: "zone:county:KSC173", failure: { kind: "server", message: "HTTP 503." } }], problems: ["A row has no id."], stop: "host" },
    });
    expect(report).toBe('The refresh of the shapes made 3 requests and stopped at "host". It has these failures and problems:\n- zone:county:KSC173: server: HTTP 503.\n- A row has no id.');
  });

  it("gives the message of an error", () => {
    expect(shapeReport({ ok: false, error: new Error("The disk is full.") })).toBe("The refresh of the shapes threw: The disk is full.");
  });
});

describe("keepShapes", () => {
  it("has no outline and starts no refresh without a store", async () => {
    const keeper = keepShapes({ places: [KANSAS] });
    keeper.afterPass([], T0);
    expect(keeper.lookup({ system: "ugc", code: "KSZ083" })).toBeUndefined();
    expect(keeper.basemap()).toEqual([]);
    await keeper.idle();
    await keeper.close();
  });

  it("starts one refresh at a time with the time limit of the pass, and none with no time limit", async () => {
    const fake = fakeStore([]);
    const outcomes: unknown[] = [];
    const keeper = keepShapes({ store: fake.store, places: [KANSAS], onShapes: (outcome) => outcomes.push(outcome) });
    keeper.afterPass([], undefined);
    expect(fake.calls).toEqual([]);
    const live = [incident("a", [{ system: "ugc", code: "TXC167" }])];
    keeper.afterPass(live, T0);
    keeper.afterPass(live, T0 + 1);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ wanted: { states: ["KS"], codes: [{ system: "ugc", code: "TXC167" }] }, until: T0 });
    fake.end();
    await keeper.idle();
    expect(outcomes).toEqual([{ ok: true, refreshed: REFRESHED }]);
    keeper.afterPass(live, T0 + 2);
    expect(fake.calls).toHaveLength(2);
    fake.end();
    await keeper.idle();
  });

  it("gives an error of a refresh to the hook, and a fault of the hook stops nothing", async () => {
    const fake = fakeStore([]);
    const keeper = keepShapes({
      store: fake.store,
      places: [KANSAS],
      onShapes: () => {
        throw new Error("The hook failed.");
      },
    });
    keeper.afterPass([], T0);
    fake.fail(new Error("The cache is closed."));
    await keeper.idle();
    keeper.afterPass([], T0);
    fake.end();
    await keeper.idle();
    expect(fake.calls).toHaveLength(2);
  });

  it("gives the regions of the places and of the live incidents, once each, and the lookup of the store", async () => {
    const fake = fakeStore(["KSZ083", "KSC173", "TXC167", "KSC015"]);
    const keeper = keepShapes({ store: fake.store, places: [KANSAS, TEXAS] });
    expect(keeper.basemap().map((region) => region.code.code)).toEqual(["KSC173", "KSZ083"]);
    keeper.afterPass([incident("a", [{ system: "ugc", code: "TXC167" }, { system: "ugc", code: "KSC173" }]), incident("b", [{ system: "ugc", code: "KSC015" }], false)], undefined);
    expect(keeper.basemap().map((region) => region.code.code)).toEqual(["KSC173", "KSZ083", "TXC167"]);
    expect(keeper.lookup({ system: "same", code: "020173" })).toHaveLength(1);
    expect(keeper.lookup({ system: "ugc", code: "TXC029" })).toBeUndefined();
    await keeper.close();
  });

  it("stops the refresh at the close, closes the cache after its end, and starts no refresh after the close", async () => {
    const fake = fakeStore([]);
    const outcomes: unknown[] = [];
    const order: string[] = [];
    const keeper = keepShapes({ store: fake.store, places: [KANSAS], onShapes: (outcome) => outcomes.push(outcome), close: () => order.push("cache") });
    keeper.afterPass([], T0);
    const closed = keeper.close().then(() => order.push("closed"));
    await closed;
    expect(fake.calls[0]?.signal?.aborted).toBe(true);
    expect(order).toEqual(["cache", "closed"]);
    // The abort of the close is not a fault.
    expect(outcomes).toEqual([]);
    keeper.afterPass([], T0);
    expect(fake.calls).toHaveLength(1);
    await keeper.close();
    expect(order).toEqual(["cache", "closed"]);
  });
});
