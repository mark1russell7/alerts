/**
 * The summary of a measure in Markdown, for the summary of the workflow job.
 */

import { escapeMarkdown } from "@mark1russell7/text";

import { COW_PHENOMENA } from "./cow.ts";
import type { GateBreak } from "./gate.ts";
import type { Range, RatesFile } from "./rates.ts";

/** The count of event types in the table of NCEI: the types with the most deaths. */
export const TOP_TYPES = 15;

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const percentRange = ([low, high]: Range): string => `${percent(low)} to ${percent(high)}`;
const number = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const numberRange = ([low, high]: Range): string => `${number(low)} to ${number(high)}`;

/** The result of the gate: no committed file, or the breaks against the committed file. */
export type GateResult = { readonly committed: false } | { readonly committed: true; readonly breaks: readonly GateBreak[] };

/** This function gives the summary of a file of base rates in Markdown, with the result of the gate. */
export function ratesSummary(file: RatesFile, gate: GateResult): string {
  const { cow, ncei, cap } = file;
  const lines: string[] = [];
  lines.push("## The base rates", "");
  lines.push(`Fetched at ${file.fetched}. Each interval has the level ${percent(file.level)}.`, "");
  lines.push(`### The verified share of the NWS warnings (IEM Cow, ${String(cow.years.first)} to ${String(cow.years.last)})`, "");
  lines.push("| Phenomenon | Kind | Warnings | Verified | Share | Wilson | Over the years | Own hazard | Own hazard over the years |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- | --- | ---: | --- |");
  for (const phenomenon of COW_PHENOMENA) {
    const rate = cow.phenomena[phenomenon];
    lines.push(
      `| ${phenomenon} ${rate.label} | \`${rate.kind}\` | ${String(rate.warnings)} | ${String(rate.verified)} | ${percent(rate.share.value)} | ${percentRange(rate.share.wilson)} | ${percentRange(rate.share.overYears)} | ${percent(rate.ownShare.value)} | ${percentRange(rate.ownShare.overYears)} |`,
    );
  }
  lines.push("", `### The deaths and injuries of each event type (NCEI Storm Events, ${String(ncei.years.first)} to ${String(ncei.years.last)})`, "");
  lines.push(`The ${String(TOP_TYPES)} types with the most deaths. The counts are direct plus indirect.`, "");
  lines.push("| Type | Kind | Events | Deaths | Deaths each year | Injuries | Injuries each year |");
  lines.push("| --- | --- | ---: | ---: | --- | ---: | --- |");
  const types = Object.entries(ncei.types).sort(([, a], [, b]) => b.deathsDirect + b.deathsIndirect - (a.deathsDirect + a.deathsIndirect) || b.injuries.value - a.injuries.value);
  for (const [type, rate] of types.slice(0, TOP_TYPES)) {
    lines.push(
      `| ${escapeMarkdown(type)} | ${rate.kind === null ? "none" : `\`${rate.kind}\``} | ${String(rate.events)} | ${String(rate.deathsDirect + rate.deathsIndirect)} | ${number(rate.deaths.value)} (${numberRange(rate.deaths.overYears)}) | ${String(rate.injuriesDirect + rate.injuriesIndirect)} | ${number(rate.injuries.value)} (${numberRange(rate.injuries.overYears)}) |`,
    );
  }
  lines.push("", ncei.newTypes.length === 0 ? "The map of the event types has each type of the files." : `The map of the event types does not have these types: ${ncei.newTypes.map(escapeMarkdown).join(", ")}.`, "");
  lines.push(`### The CAP certainty bands (${cap.source.document}, section ${cap.source.section})`, "");
  lines.push("| Certainty | Text of CAP | Band |", "| --- | --- | --- |");
  for (const [value, band] of Object.entries(cap.bands)) {
    lines.push(`| ${value} | ${escapeMarkdown(band.text)} | ${band.lowOpen ? "(" : "["}${String(band.low)}, ${String(band.high)}]${band.approximate ? ", approximate" : ""} |`);
  }
  lines.push("", "### The gate", "");
  if (!gate.committed) lines.push("There is no committed file. The gate examined nothing.");
  else if (gate.breaks.length === 0) lines.push("Each value is in the gate interval of the committed file.");
  else {
    lines.push(`${String(gate.breaks.length)} values are out of the gate interval of the committed file:`, "");
    lines.push("| Measure | New value | Gate interval |", "| --- | ---: | --- |");
    for (const { path, value, gate: range } of gate.breaks) lines.push(`| ${escapeMarkdown(path)} | ${String(value)} | ${String(range[0])} to ${String(range[1])} |`);
  }
  return `${lines.join("\n")}\n`;
}
