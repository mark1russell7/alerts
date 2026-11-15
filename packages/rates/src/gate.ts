/**
 * The gate of the base rates. It compares each value of a new measure with the gate interval of the
 * committed file. A value out of its interval is a break: the base rate changed, or a source changed
 * the meaning of its data. A person then examines the change and commits the new file.
 *
 * A share with a reason of no read in the committed file or in the new file is a no read. The gate
 * does not compare it. A no read is not a pass and not a break.
 *
 * The rule of a read: each year of the window has n p >= 10 and n (1 - p) >= 10, with `MIN_YEAR_COUNT`
 * as the limit. Here n is the count of warnings of the year, and p is the share of the year. The
 * interval over the years uses the normal approximation of each share, and the approximation needs
 * these counts.
 */

import { COW_PHENOMENA } from "./cow.ts";
import type { Range, RatesFile } from "./rates.ts";

/** One value of the gate: the value of a measure and its gate interval. */
export interface Gated {
  readonly value: number;
  readonly gate: Range;
  /** The reason that the gate cannot read the value, or `null` or no field when it reads it. */
  readonly noRead?: string | null;
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

/** One value that the gate cannot read. */
export interface GateNoRead {
  /** The name of the measure. */
  readonly path: string;
  /** The file with the reason, and the reason with the counts. */
  readonly reason: string;
}

/** The result of the gate: the breaks and the no reads. */
export interface GateCheck {
  readonly breaks: readonly GateBreak[];
  readonly noReads: readonly GateNoRead[];
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
 * This function gives the breaks and the no reads of a new file against the committed file.
 *
 * - A measure that a file does not have is 0, with the gate interval 0 to 0. Thus a new event type with deaths or
 *   injuries is a break, and so is a type that goes away.
 * - A value with a reason of no read in the new file or in the committed file is a no read, not a break. The reason of
 *   the new file comes first.
 */
export function checkRates(committed: RatesFile, fresh: RatesFile): GateCheck {
  const before = gatedValues(committed);
  const after = gatedValues(fresh);
  const breaks: GateBreak[] = [];
  const noReads: GateNoRead[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const { gate, noRead: committedNoRead } = before.get(path) ?? ABSENT;
    const { value, noRead: freshNoRead } = after.get(path) ?? ABSENT;
    if (typeof freshNoRead === "string") noReads.push({ path, reason: `the new measure has ${freshNoRead}` });
    else if (typeof committedNoRead === "string") noReads.push({ path, reason: `the committed file has ${committedNoRead}` });
    else if (value < gate[0] || value > gate[1]) breaks.push({ path, value, gate });
  }
  return { breaks, noReads };
}
