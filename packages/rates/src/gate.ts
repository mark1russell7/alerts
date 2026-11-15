/**
 * The gate of the base rates. It compares each value of a new measure with the gate interval of the
 * committed file. A value out of its interval is a break: the base rate changed, or a source changed
 * the meaning of its data. A person then examines the change and commits the new file.
 */

import { COW_PHENOMENA } from "./cow.ts";
import type { Range, RatesFile } from "./rates.ts";

/** One value of the gate: the value of a measure and its gate interval. */
export interface Gated {
  readonly value: number;
  readonly gate: Range;
}

/** One break of the gate. */
export interface GateBreak {
  /** The name of the measure, for example `cow.TO.share` or `ncei.Tornado.deaths`. */
  readonly path: string;
  /** The new value. */
  readonly value: number;
  /** The gate interval of the committed file. */
  readonly gate: Range;
}

/** The gate interval of a measure that a file does not have. */
const ABSENT: Gated = { value: 0, gate: [0, 0] };

/** This function gives each value of a file that the gate examines, by its name. */
export function gatedValues(file: RatesFile): Map<string, Gated> {
  const values = new Map<string, Gated>();
  for (const phenomenon of COW_PHENOMENA) {
    const rate = file.cow.phenomena[phenomenon];
    values.set(`cow.${phenomenon}.share`, rate.share);
    values.set(`cow.${phenomenon}.ownShare`, rate.ownShare);
  }
  for (const [type, rate] of Object.entries(file.ncei.types)) {
    values.set(`ncei.${type}.deaths`, rate.deaths);
    values.set(`ncei.${type}.injuries`, rate.injuries);
  }
  return values;
}

/**
 * This function gives the breaks of a new file against the committed file. A measure that a file
 * does not have is 0, with the gate interval 0 to 0. Thus a new event type with deaths or injuries is
 * a break, and so is a type that goes away.
 */
export function checkRates(committed: RatesFile, fresh: RatesFile): GateBreak[] {
  const before = gatedValues(committed);
  const after = gatedValues(fresh);
  const breaks: GateBreak[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const { gate } = before.get(path) ?? ABSENT;
    const { value } = after.get(path) ?? ABSENT;
    if (value < gate[0] || value > gate[1]) breaks.push({ path, value, gate });
  }
  return breaks;
}
