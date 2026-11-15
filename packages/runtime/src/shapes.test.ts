import { CONFIG_FORMAT, type AlertConfig, type Incident, type MapRegion, type PlaceConfig, type PlaceId, type Position, type RegionCode, type ReportId, type WatchedPlace } from "@mark1russell7/alerts";
import type { Refreshed, RefreshInput, ShapeStore } from "@mark1russell7/alerts-shapes-nws";
import { describe, expect, it } from "vitest";
import { keepShapes, liveCodes, placeCodesKey, shapeReport, wantedShapes, withZoneCodes, type ShapeOutcome } from "./shapes.ts";

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

/**
 * A fake store. It has a region for each UGC code in `known`, and the regions of `states` for the basemap of each state.
 * Each refresh waits until the test ends it. A region keeps its array of shapes, as in the real store.
 */
function fakeStore(known: readonly string[], states: Readonly<Record<string, readonly MapRegion[]>> = {}) {
  const calls: RefreshInput[] = [];
  let end: ((value: Refreshed) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const regions = new Map<string, MapRegion>();
  const region = (id: string): MapRegion => {
    const held = regions.get(id) ?? { code: { system: "ugc", code: id }, name: `Zone ${id}`, shapes: [{ type: "polygon", rings: [RING] }] };
    regions.set(id, held);
    return held;
  };
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
    basemap: (state) => states[state] ?? [],
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

// Two squares of one degree in Kansas with a shared edge at the longitude -97, and a square in Texas.
const square = (west: number, south: number): Position[] => [
  [west, south],
  [west + 1, south],
  [west + 1, south + 1],
  [west, south + 1],
  [west, south],
];
const zoneRegion = (id: string, west: number, south: number): MapRegion => ({ code: { system: "ugc", code: id }, name: `Zone ${id}`, shapes: [{ type: "polygon", rings: [square(west, south)] }] });
const OUTLINES: Readonly<Record<string, readonly MapRegion[]>> = {
  KS: [zoneRegion("KSC173", -98, 37), zoneRegion("KSZ083", -98, 37), zoneRegion("KSC015", -97, 37)],
  TX: [zoneRegion("TXC029", -99, 29)],
};
const outlines = (state: string): readonly MapRegion[] => OUTLINES[state] ?? [];

/** This function gives a configuration with these places and no person. */
const configOf = (...places: PlaceConfig[]): AlertConfig => ({ format: CONFIG_FORMAT, places, people: [], contacts: [], policies: [] });
const kansasPlace: PlaceConfig = { id: "place-ks" as PlaceId, label: "A place", at: [-97.5, 37.5], codes: [{ system: "same", code: "020173" }], bufferKm: 0 };

describe("withZoneCodes", () => {
  it("adds the codes of the zones that contain the position, after the codes of the file", () => {
    const [place] = withZoneCodes(configOf(kansasPlace), outlines).places;
    expect(place?.codes).toEqual([
      { system: "same", code: "020173" },
      { system: "state", code: "KS" },
      { system: "ugc", code: "KSC173" },
      { system: "ugc", code: "KSZ083" },
    ]);
  });

  it("adds the codes of a zone in the buffer, and no code of the file again", () => {
    const near: PlaceConfig = { ...kansasPlace, codes: [{ system: "ugc", code: "ksc173" }, { system: "same", code: "020173" }], bufferKm: 50 };
    const [place] = withZoneCodes(configOf(near), outlines).places;
    expect(place?.codes.map((code) => `${code.system}:${code.code}`)).toEqual(["ugc:ksc173", "same:020173", "same:020015", "state:KS", "ugc:KSC015", "ugc:KSZ083"]);
  });

  it("keeps the codes of a place with no position, or with no outline of its states", () => {
    const noPosition: PlaceConfig = { id: "place-a" as PlaceId, label: "A", codes: [{ system: "state", code: "KS" }], bufferKm: 0 };
    const noOutline: PlaceConfig = { id: "place-b" as PlaceId, label: "B", at: [-100.5, 44.5], codes: [{ system: "state", code: "SD" }], bufferKm: 0 };
    const config = configOf(noPosition, noOutline);
    expect(withZoneCodes(config, outlines).places).toEqual(config.places);
  });

  it("reads only the outlines of the states of the codes of the place", () => {
    const asked: string[] = [];
    // The position is in the square of Texas, but the place has only a code of Kansas.
    const wrong: PlaceConfig = { ...kansasPlace, at: [-98.5, 29.5] };
    const [place] = withZoneCodes(configOf(wrong), (state) => {
      asked.push(state);
      return outlines(state);
    }).places;
    expect(asked).toEqual(["KS"]);
    expect(place?.codes).toEqual(wrong.codes);
  });

  it("gives one key for the same codes, and a new key for new codes", () => {
    const config = configOf(kansasPlace);
    const zoned = withZoneCodes(config, outlines);
    expect(placeCodesKey(config)).toBe(placeCodesKey(configOf({ ...kansasPlace, label: "Other", codes: [{ system: "same", code: "020173" }] })));
    expect(placeCodesKey(zoned)).not.toBe(placeCodesKey(config));
    expect(placeCodesKey(withZoneCodes(zoned, outlines))).toBe(placeCodesKey(zoned));
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

  it("gives each region of each watched state, simplified, and simplifies again only after a change", async () => {
    // A public county of Kansas. Its south edge has 3 positions that are 1 m from the line, thus the simplification removes them.
    const harvey: MapRegion = { code: { system: "ugc", code: "KSC079" }, name: "Harvey", shapes: [{ type: "polygon", rings: [[[-98, 37], [-97.75, 37.00001], [-97.5, 37], [-97.25, 37.00001], [-97, 37], [-97, 38], [-98, 38], [-98, 37]]] }] };
    const fake = fakeStore(["KSZ083", "KSC173", "TXC167"], { KS: [harvey] });
    const outcomes: ShapeOutcome[] = [];
    const keeper = keepShapes({ store: fake.store, places: [KANSAS], onShapes: (outcome) => outcomes.push(outcome) });
    const first = keeper.basemap();
    expect(first.map((region) => region.code.code)).toEqual(["KSC079", "KSC173", "KSZ083"]);
    const ring = first[0]!.shapes[0]!.type === "polygon" ? first[0]!.shapes[0]!.rings[0]! : [];
    expect(ring).toHaveLength(5);
    expect(new Set(ring.map(([lon, lat]) => `${String(lon)},${String(lat)}`))).toEqual(new Set(["-98,37", "-97,37", "-97,38", "-98,38"]));
    // The same regions give the same simplified copy.
    expect(keeper.basemap()).toBe(first);
    keeper.afterPass([incident("a", [{ system: "ugc", code: "TXC167" }])], undefined);
    const second = keeper.basemap();
    expect(second).not.toBe(first);
    expect(second.map((region) => region.code.code)).toEqual(["KSC079", "KSC173", "KSZ083", "TXC167"]);
    expect(outcomes).toEqual([]);
    await keeper.close();
  });

  it("gives the full outlines and reports the error one time when the simplification throws", async () => {
    // The ring is not closed, thus geo refuses it.
    const open: MapRegion = { code: { system: "ugc", code: "KSC079" }, name: "Harvey", shapes: [{ type: "polygon", rings: [[[-98, 37], [-97, 37], [-97, 38], [-98, 38]]] }] };
    const fake = fakeStore([], { KS: [open] });
    const outcomes: ShapeOutcome[] = [];
    const keeper = keepShapes({ store: fake.store, places: [KANSAS], onShapes: (outcome) => outcomes.push(outcome) });
    expect(keeper.basemap()).toEqual([open]);
    expect(keeper.basemap()[0]).toBe(open);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ ok: false, step: "basemap" });
    expect(shapeReport(outcomes[0]!)).toMatch(/^The simplification of the basemap threw, thus the map has the full outlines: .*linear ring/);
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
