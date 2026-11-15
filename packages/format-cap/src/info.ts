/**
 * The choice of one info block of a CAP message. A message has one info block for each language. A
 * map function gives one report for each message, so it uses one block only.
 *
 * Two reports from one message get the same report id with two contents. The merge then keeps one of
 * them by its content, not by its language. So the map chooses the block, with this function.
 */

import type { CapInfo } from "./read.ts";

/** The languages of the choice when the configuration gives none. */
export const DEFAULT_LANGUAGES: readonly string[] = ["en-US"];

/** The info block that `chooseInfo` chose. */
export interface ChosenInfo {
  readonly info: CapInfo;
  /** The index of the block in the message. */
  readonly index: number;
  /** The count of the blocks of the message in the language of the chosen block. One is the usual count. */
  readonly sameLanguage: number;
}

const primaryOf = (language: string): string => (language.split("-", 1)[0] ?? "").toLowerCase();

/**
 * This function chooses one info block. The function tries each language of the list in order. A
 * language matches in full, with no change of case, or else by its first part: `en-US` gives `en-GB`.
 * Thus a reader of English gets English before the next language. When no language matches, the
 * function gives the first block. A message with no info block gives `undefined`.
 */
export function chooseInfo(infos: readonly CapInfo[], languages: readonly string[] = DEFAULT_LANGUAGES): ChosenInfo | undefined {
  const chosen = (index: number): ChosenInfo => {
    const info = infos[index] as CapInfo;
    const language = info.language.toLowerCase();
    return { info, index, sameLanguage: infos.filter((other) => other.language.toLowerCase() === language).length };
  };
  if (infos.length === 0) return undefined;
  for (const wanted of languages) {
    const exact = infos.findIndex((info) => info.language.toLowerCase() === wanted.toLowerCase());
    if (exact >= 0) return chosen(exact);
    const primary = primaryOf(wanted);
    const near = infos.findIndex((info) => primaryOf(info.language) === primary);
    if (near >= 0) return chosen(near);
  }
  return chosen(0);
}
