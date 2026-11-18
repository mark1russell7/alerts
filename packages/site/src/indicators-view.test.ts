import type { Breadth, IndicatorBreadth, MapPlace, PlaceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { breadthText, dimensionLine, dimensionTitle, indicatorPanel, NO_BREADTH_TEXT, NO_SERIES_TEXT } from "./indicators-view.ts";

const HOME = "home" as PlaceId;
const CABIN = "cabin" as PlaceId;
const place = (id: PlaceId, label: string): MapPlace => ({ id, label, shapes: [], level: "none", incidents: [], gaps: [] });
const PLACES = [place(HOME, "Home"), place(CABIN, "Cabin")];
const EMPTY: Breadth = { signals: [], read: [], dimensions: [] };

describe("the panel of the indicators", () => {
  it("tells a runtime with no breadth, and a breadth with no series", () => {
    expect(indicatorPanel(undefined, PLACES)).toEqual({ verdict: { tone: "quiet", text: NO_BREADTH_TEXT }, rows: [] });
    const none: IndicatorBreadth = { world: EMPTY, places: [{ place: HOME, ...EMPTY }], unplaced: [] };
    expect(indicatorPanel(none, PLACES)).toEqual({ verdict: { tone: "quiet", text: NO_SERIES_TEXT }, rows: [] });
  });

  it("gives the world first, then each place with its label, and the counts of each dimension", () => {
    const breadth: IndicatorBreadth = {
      world: {
        signals: ["rail", "grid-frequency"],
        read: ["rail", "grid-frequency", "power-demand"],
        dimensions: [
          { dimension: "rail", read: 2, signals: 1, noRead: 0 },
          { dimension: "power-demand", read: 1, signals: 0, noRead: 1 },
          { dimension: "grid-frequency", read: 1, signals: 1, noRead: 0 },
        ],
      },
      places: [
        { place: HOME, signals: ["rail"], read: ["rail"], dimensions: [{ dimension: "rail", read: 1, signals: 1, noRead: 0 }] },
        { place: CABIN, ...EMPTY },
      ],
      unplaced: ["series-9"],
    };
    const panel = indicatorPanel(breadth, PLACES);
    expect(panel.verdict).toEqual({ tone: "warn", text: "In the world, 2 of 3 dimensions with a read are out of the normal level." });
    expect(panel.rows.map((row) => [row.name, row.tone, row.word])).toEqual([
      ["The world", "warn", "Out of normal"],
      ["Home", "warn", "Out of normal"],
      ["Cabin", "quiet", "No series"],
    ]);
    expect(panel.rows[0]?.lines).toEqual([
      "Rail punctuality and cancellations: 1 of 2 series out of the normal level.",
      "Electric load: 0 of 1 series out of the normal level, 1 with no read.",
      "Grid frequency: 1 of 1 series out of the normal level.",
      "1 series with an area that no place can match. The world counts them, and no place counts them.",
    ]);
    expect(panel.rows[2]?.lines).toEqual([]);
  });

  it("gives the id of a place with no label on the map", () => {
    const breadth: IndicatorBreadth = { world: { signals: [], read: ["rail"], dimensions: [{ dimension: "rail", read: 1, signals: 0, noRead: 0 }] }, places: [{ place: "gone" as PlaceId, ...EMPTY }], unplaced: [] };
    expect(indicatorPanel(breadth, PLACES).rows.map((row) => row.name)).toEqual(["The world", "gone"]);
  });

  it("tells a breadth with reads and no signal, and a breadth with no read", () => {
    expect(breadthText({ signals: [], read: ["rail"], dimensions: [{ dimension: "rail", read: 1, signals: 0, noRead: 0 }] })).toEqual({
      tone: "good",
      word: "Normal",
      text: "The dimension with a read is at its normal level: Rail punctuality and cancellations.",
    });
    expect(breadthText({ signals: [], read: ["rail", "air-traffic"], dimensions: [] }).text).toBe("Each of the 2 dimensions with a read is at its normal level.");
    expect(breadthText({ signals: ["rail"], read: ["rail"], dimensions: [] }).text).toBe("1 of 1 dimension with a read is out of the normal level: Rail punctuality and cancellations.");
    expect(breadthText({ signals: [], read: [], dimensions: [{ dimension: "rail", read: 0, signals: 0, noRead: 3 }] })).toEqual({ tone: "quiet", word: "No read", text: "No series has a read yet. 3 series wait for more readings." });
  });

  it("gives the title of each dimension, and the id of an unknown dimension", () => {
    expect(dimensionTitle("grid-frequency")).toBe("Grid frequency");
    expect(dimensionLine({ dimension: "rail", read: 4, signals: 0, noRead: 2 })).toBe("Rail punctuality and cancellations: 0 of 4 series out of the normal level, 2 with no read.");
  });
});
