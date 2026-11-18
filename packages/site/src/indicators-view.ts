/**
 * The panel of the indicators of the local page. An indicator is a measure with a normal level, for example the grid
 * frequency. The panel tells the dimensions out of their normal level in the world and near each watched place.
 * The breadth gives counts and no decision. Thus the panel tells the counts, and the threat level is not in it.
 *
 * The data function is pure. The draw function makes the elements of the panel from that data.
 */

import { DIMENSIONS, type Breadth, type DimensionCount, type DimensionId, type IndicatorBreadth, type MapPlace } from "@mark1russell7/alerts";
import { h } from "@mark1russell7/site-pages/chrome";
import { countOf } from "@mark1russell7/text/english";
import { toneChip } from "./draw.ts";
import type { Tone } from "./health-look.ts";
import type { Verdict } from "./health-view.ts";

/** One row of the panel: the world or one watched place. */
export interface IndicatorRow {
  /** The name of the row: the world, or the label of the place. */
  readonly name: string;
  readonly tone: Tone;
  /** The word of the chip of the row. */
  readonly word: string;
  /** The sentence of the counts of the row. */
  readonly text: string;
  /** One sentence for each dimension with a series, in the order of `DIMENSIONS`, then the notes of the row. */
  readonly lines: readonly string[];
}

/** The data of the panel: one sentence for the world, and the rows. */
export interface IndicatorPanel {
  readonly verdict: Verdict;
  readonly rows: readonly IndicatorRow[];
}

/** The sentence of a runtime that gives no breadth: it has no store of the readings. */
export const NO_BREADTH_TEXT = "This runtime gives no indicators. It has no store of the readings.";

/** The sentence of a breadth with no series. */
export const NO_SERIES_TEXT = "No source gives indicator readings yet.";

const TITLES: ReadonlyMap<DimensionId, string> = new Map(DIMENSIONS.map((dimension) => [dimension.id, dimension.title]));

/** This function gives the title of a dimension. An unknown id gives the id. */
export function dimensionTitle(dimension: DimensionId): string {
  return TITLES.get(dimension) ?? dimension;
}

const seriesOf = (count: number): string => countOf(count, "series", "series");
const noReadOf = (counts: readonly DimensionCount[]): number => counts.reduce((sum, count) => sum + count.noRead, 0);

/** This function gives the sentence of one dimension: the series out of the normal level, and the series with no read. */
export function dimensionLine(count: DimensionCount): string {
  const noRead = count.noRead === 0 ? "" : `, ${String(count.noRead)} with no read`;
  return `${dimensionTitle(count.dimension)}: ${String(count.signals)} of ${seriesOf(count.read)} out of the normal level${noRead}.`;
}

/**
 * This function gives the tone, the word and the sentence of a breadth. A signal gives the tone `warn`, a read with no
 * signal gives `good`, and a breadth with no read gives `quiet`.
 */
export function breadthText(breadth: Breadth): { readonly tone: Tone; readonly word: string; readonly text: string } {
  const { signals, read, dimensions } = breadth;
  if (signals.length > 0) {
    // The titles of the dimensions can hold the word and, thus only one title goes in the sentence. The lines name each one.
    const which = signals.length === 1 ? ` is out of the normal level: ${dimensionTitle(signals[0]!)}` : " are out of the normal level";
    return { tone: "warn", word: "Out of normal", text: `${String(signals.length)} of ${countOf(read.length, "dimension")} with a read${which}.` };
  }
  if (read.length > 0) {
    const text = read.length === 1 ? `The dimension with a read is at its normal level: ${dimensionTitle(read[0]!)}.` : `Each of the ${String(read.length)} dimensions with a read is at its normal level.`;
    return { tone: "good", word: "Normal", text };
  }
  if (dimensions.length > 0) return { tone: "quiet", word: "No read", text: `No series has a read yet. ${seriesOf(noReadOf(dimensions))} wait for more readings.` };
  return { tone: "quiet", word: "No series", text: "No series is near." };
}

function rowOf(name: string, breadth: Breadth, notes: readonly string[] = []): IndicatorRow {
  return { name, ...breadthText(breadth), lines: [...breadth.dimensions.map(dimensionLine), ...notes] };
}

/**
 * This function gives the data of the panel from the breadth of the map payload. The first row is the world, and the
 * other rows are the places in the order of the breadth. The label of a place comes from the places of the map.
 */
export function indicatorPanel(breadth: IndicatorBreadth | undefined, places: readonly MapPlace[]): IndicatorPanel {
  if (breadth === undefined) return { verdict: { tone: "quiet", text: NO_BREADTH_TEXT }, rows: [] };
  if (breadth.world.dimensions.length === 0) return { verdict: { tone: "quiet", text: NO_SERIES_TEXT }, rows: [] };
  const world = breadthText(breadth.world);
  const labels = new Map(places.map((place) => [place.id, place.label]));
  const unplaced = breadth.unplaced.length;
  const note = unplaced === 0 ? [] : [`${seriesOf(unplaced)} with an area that no place can match. The world counts them, and no place counts them.`];
  const rows = [rowOf("The world", breadth.world, note), ...breadth.places.map((place) => rowOf(labels.get(place.place) ?? place.place, place))];
  return { verdict: { tone: world.tone, text: `In the world, ${world.text.charAt(0).toLowerCase()}${world.text.slice(1)}` }, rows };
}

function drawRow(row: IndicatorRow): HTMLElement {
  return h(
    "li",
    { class: "source-row" },
    h("strong", { class: "source-name" }, row.name),
    h("span", { class: "source-state" }, toneChip(row.tone, row.word)),
    h("span", { class: "source-read" }, row.text),
    row.lines.length === 0 ? null : h("div", { class: "source-more" }, ...row.lines.map((line) => h("p", {}, line))),
  );
}

/** This function draws the rows of the panel. A panel with no row gives no element. */
export function drawIndicators(panel: IndicatorPanel): HTMLElement[] {
  return panel.rows.length === 0 ? [] : [h("ul", { class: "source-list", "aria-label": "The indicators of the world and of each place" }, ...panel.rows.map(drawRow))];
}
