/**
 * The summary of a measure in Markdown, for the summary of the workflow job.
 */

import { escapeMarkdown } from "@mark1russell7/text";

import { COW_PHENOMENA, COW_UNVERIFIED_PHENOMENA } from "./cow.ts";
import type { GateCheck } from "./gate.ts";
import type { Range, RatesFile, Share } from "./rates.ts";
import { numberingDoubts } from "./watchwarn.ts";

/** The count of event types in the table of NCEI: the types with the most deaths. */
export const TOP_TYPES = 15;

/** The count of rows in the table of the harm under an alert: the pairs of a kind and a significance with the most deaths. */
export const TOP_UNDER = 30;

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const percentRange = ([low, high]: Range): string => `${percent(low)} to ${percent(high)}`;
const number = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const numberRange = ([low, high]: Range): string => `${number(low)} to ${number(high)}`;

/** The result of the gate: no committed file, or the breaks and the no reads against the committed file. */
export type GateResult = { readonly committed: false } | ({ readonly committed: true } & GateCheck);

/** This function gives the state of the gate for two shares: `reads`, or `no read` when one share has a reason of no read. */
const readState = (...shares: readonly Share[]): string => (shares.some((share) => share.noRead !== null) ? "no read" : "reads");

/** This function gives a code in code font of Markdown. */
const code = (text: string): string => `\`${text}\``;

/** This function adds the lines of the harm under an active alert to the summary. */
function underLines(file: RatesFile, lines: string[]): void {
  const { under } = file;
  const years = under.years.last - under.years.first + 1;
  lines.push(`### The harm under an active alert (IEM and NCEI, ${String(under.years.first)} to ${String(under.years.last)})`, "");
  lines.push(
    `The ${String(TOP_UNDER)} pairs of a kind and a significance with the most deaths under an alert. The harm is that of the NCEI kind of the alert. The share is the part of all the deaths of that kind. The gate does not read these values.`,
    "",
  );
  lines.push("| Alert | Kind | NCEI kind | Alerts each year | Events | Deaths | Injuries | Share of the deaths | Deaths in 1000 alerts | Injuries in 1000 alerts |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  const pairs = Object.entries(under.kinds).flatMap(([kind, entry]) => Object.entries(entry.significances).map(([significance, rate]) => ({ kind, entry, significance, rate })));
  pairs.sort((a, b) => b.rate.total.harm.deaths - a.rate.total.harm.deaths || b.rate.total.harm.injuries - a.rate.total.harm.injuries || b.rate.total.alerts - a.rate.total.alerts);
  for (const { kind, entry, significance, rate } of pairs.slice(0, TOP_UNDER)) {
    const all = Object.values(entry.ncei).reduce((sum, harm) => sum + harm.deaths, 0);
    const { alerts, harm } = rate.total;
    const label = Object.keys(rate.phenomena)
      .map((phenomenon) => `${phenomenon}.${significance}`)
      .join(", ");
    const cells = [
      label,
      code(kind),
      entry.nceiKind === null ? "none" : code(entry.nceiKind),
      number(alerts / years),
      String(harm.events),
      String(harm.deaths),
      String(harm.injuries),
      all === 0 ? "none" : percent(harm.deaths / all),
      number((1000 * harm.deaths) / alerts),
      number((1000 * harm.injuries) / alerts),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  const unplaced = Object.entries(under.unplaced).map(([reason, harm]) => `${reason}: ${String(harm.events)} events, ${String(harm.deaths)} deaths, ${String(harm.injuries)} injuries`);
  lines.push("", unplaced.length === 0 ? "The join placed each event with harm." : `The join cannot place these events with harm: ${unplaced.join("; ")}.`, "");
  const faults = Object.entries(under.faults).map(([fault, rows]) => `${fault}: ${String(rows)}`);
  lines.push(`The requests gave ${String(under.rows)} rows.${faults.length === 0 ? "" : ` Rows with a fault: ${faults.join(", ")}.`}`, "");
  const doubts = numberingDoubts(under.numbering);
  lines.push(doubts.length === 0 ? "The data agree with the list of the national event numbers." : `**Doubt of the national numbers:** ${doubts.map(escapeMarkdown).join(" ")}`, "");
}

/** This function gives the summary of a file of base rates in Markdown, with the result of the gate. */
export function ratesSummary(file: RatesFile, gate: GateResult): string {
  const { cow, ncei, cap } = file;
  const lines: string[] = [];
  lines.push("## The base rates", "");
  lines.push(`Fetched at ${file.fetched}. Each interval has the level ${percent(file.level)}.`, "");
  lines.push(`### The verified share of the NWS warnings (IEM Cow, ${String(cow.years.first)} to ${String(cow.years.last)})`, "");
  lines.push("| Phenomenon | Kind | Warnings | Verified | Share | Wilson | Over the years | Own hazard | Own hazard over the years | Gate |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- | --- | ---: | --- | --- |");
  for (const phenomenon of COW_PHENOMENA) {
    const rate = cow.phenomena[phenomenon];
    lines.push(
      `| ${phenomenon} ${rate.label} | \`${rate.kind}\` | ${String(rate.warnings)} | ${String(rate.verified)} | ${percent(rate.share.value)} | ${percentRange(rate.share.wilson)} | ${percentRange(rate.share.overYears)} | ${percent(rate.ownShare.value)} | ${percentRange(rate.ownShare.overYears)} | ${readState(rate.share, rate.ownShare)} |`,
    );
  }
  lines.push("", "### The phenomena that Cow does not verify", "");
  lines.push("The file has no share for these phenomena. Their counts are a note.", "");
  for (const phenomenon of COW_UNVERIFIED_PHENOMENA) {
    const rate = cow.unverified[phenomenon];
    lines.push(`- **${phenomenon} ${rate.label}** (\`${rate.kind}\`): ${String(rate.verified)} verified of ${String(rate.warnings)}. ${escapeMarkdown(rate.reason)} In place of the share: ${escapeMarkdown(rate.instead)}`);
    for (const source of rate.sources) lines.push(`  - ${escapeMarkdown(source)}`);
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
  underLines(file, lines);
  lines.push(`### The CAP certainty bands (${cap.source.document}, section ${cap.source.section})`, "");
  lines.push("| Certainty | Text of CAP | Band |", "| --- | --- | --- |");
  for (const [value, band] of Object.entries(cap.bands)) {
    lines.push(`| ${value} | ${escapeMarkdown(band.text)} | ${band.lowOpen ? "(" : "["}${String(band.low)}, ${String(band.high)}]${band.approximate ? ", approximate" : ""} |`);
  }
  lines.push("", "### The gate", "");
  if (!gate.committed) lines.push("There is no committed file. The gate examined nothing.");
  else if (gate.breaks.length === 0) lines.push(gate.noReads.length === 0 ? "Each value is in the gate interval of the committed file." : "Each value that the gate reads is in the gate interval of the committed file.");
  else {
    lines.push(`${String(gate.breaks.length)} values are out of the gate interval of the committed file:`, "");
    lines.push("| Measure | New value | Gate interval |", "| --- | ---: | --- |");
    for (const { path, value, gate: range } of gate.breaks) lines.push(`| ${escapeMarkdown(path)} | ${String(value)} | ${String(range[0])} to ${String(range[1])} |`);
  }
  if (gate.committed && gate.noReads.length > 0) {
    lines.push("", `**No read:** the gate cannot read ${String(gate.noReads.length)} values. A no read is not a pass.`, "");
    lines.push("| Measure | Reason |", "| --- | --- |");
    for (const { path, reason } of gate.noReads) lines.push(`| ${escapeMarkdown(path)} | ${escapeMarkdown(reason)} |`);
  }
  return `${lines.join("\n")}\n`;
}
