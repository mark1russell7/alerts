import { globePoint, pointRadius } from "@mark1russell7/visuals/globe";
import { describe, expect, it } from "vitest";
import { labelOf } from "./globe-stage.ts";
import { GAP_SIZE, globeParts, levelRank, PIN_SIZE, pinKind, placeRecord, type GlobeName } from "./globe-view.ts";
import { MAP_FIXTURE } from "./map-view.fixture.ts";

const names = globeParts(MAP_FIXTURE).names;

/** This function gives the name of the fixture with a text. */
function named(text: string): GlobeName {
  const name = names.find((one) => one.text === text);
  if (name === undefined) throw new Error(`the fixture has no name ${text}`);
  return name;
}

describe("labelOf", () => {
  it("puts the text of a place at its point of the globe, off the dot of the place", () => {
    expect(labelOf(named("Farm"))).toEqual({
      record: placeRecord("place:farm"),
      at: globePoint({ lat: 37.64, lon: -97.42 }),
      text: "Farm",
      kind: pinKind("life-safety"),
      rank: levelRank("life-safety"),
      clear: pointRadius(PIN_SIZE),
    });
  });

  it("keeps the text of a place with a short coverage off the gap ring", () => {
    const shop = labelOf(named("Shop"));
    expect(shop.clear).toBe(pointRadius(GAP_SIZE));
    expect(shop.sides).toBeUndefined();
  });

  it("puts the middle of the text of a place with no mark on its position", () => {
    const cabin = labelOf(named("Cabin"));
    expect(cabin.sides).toEqual(["center"]);
    expect(cabin.clear).toBeUndefined();
    expect(cabin.at).toEqual(globePoint(named("Cabin").place));
  });
});
