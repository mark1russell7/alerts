import type { PlaceId, WatchedPlace } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { statesOf } from "./watch.ts";

/** A place of the tests. The codes are public regions, not the places of an owner. */
const place = (id: string, codes: WatchedPlace["codes"]): WatchedPlace => ({ id: id as PlaceId, codes, bufferKm: 0 });
const KANSAS = place("a", [{ system: "ugc", code: "KSZ083" }]);
const TEXAS = place("b", [{ system: "state", code: "tx" }]);
const NO_STATE = place("c", [{ system: "fips", code: "20173" }]);

describe("statesOf", () => {
  it("gives the states of the places from the state, UGC and SAME codes", () => {
    expect(statesOf({ places: [KANSAS, TEXAS] })).toEqual(new Set(["KS", "TX"]));
    expect(statesOf({ places: [place("d", [{ system: "same", code: "048019" }])] })).toEqual(new Set(["TX"]));
  });

  it("gives all states when a place has no code of a state", () => {
    expect(statesOf({ places: [KANSAS, NO_STATE] })).toBeUndefined();
    expect(statesOf({ places: [place("e", [{ system: "ugc", code: "GMZ250" }])] })).toBeUndefined();
    // A state code that is not a state does not narrow the watch to no row.
    expect(statesOf({ places: [place("f", [{ system: "state", code: "XX" }])] })).toBeUndefined();
  });

  it("gives no state for a watch with no place", () => {
    expect(statesOf({ places: [] })).toEqual(new Set());
  });
});
