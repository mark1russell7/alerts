/**
 * The drawing parts that the demo and the local page share. The parts are the SVG element, the chip of a level, the
 * chip of a status and the sign of a tone.
 * This module does not import the made-up data of the demo, so the bundle of the local page does not hold it.
 */

import type { AssessedLevel, Status } from "@mark1russell7/alerts";
import { h, svg } from "@mark1russell7/site-pages/chrome";
import type { Tone } from "./health-look.ts";
import { statusLook } from "./status.ts";

const SVG = "http://www.w3.org/2000/svg";

/**
 * This function makes an SVG element. It is a local copy of the private `s` of the explorer of
 * `@mark1russell7/site-pages`. It goes when `@mark1russell7/site-pages/chrome` exports `svg`.
 */
export function s(tag: string, attrs: Readonly<Record<string, string | number>>, ...children: (Node | string)[]): SVGElement {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  element.append(...children);
  return element;
}

/** The words of each level. */
export const LEVEL_WORDS: Readonly<Record<AssessedLevel, string>> = {
  "life-safety": "Life-safety",
  urgent: "Urgent",
  notice: "Notice",
  digest: "Digest",
  none: "No message",
};

/** This function draws a small chip of a level. */
export function levelChip(level: AssessedLevel): HTMLElement {
  return h("span", { class: `chip level-${level}` }, LEVEL_WORDS[level]);
}

/**
 * This function draws the chip of a status, or nothing for the status `actual`.
 * The chip has a dashed edge, as the area of the incident on the map.
 */
export function statusChip(status: Status): HTMLElement | null {
  const look = statusLook(status);
  return look === undefined ? null : h("span", { class: "chip status", "data-status": status }, look.word);
}

/** The shape of the sign of each tone, as the path of a line in a box of 12 units by 12 units. */
const SIGN_PATHS: Readonly<Record<Tone, string>> = {
  good: "M2.4 6.6 4.9 9l4.7-5.8",
  warn: "M6 2.4v4.7M6 9.6v.01",
  bad: "M3 3l6 6M9 3l-6 6",
  quiet: "M4.1 4.6a1.9 1.9 0 0 1 3.8 0c0 1.5-1.9 1.6-1.9 3M6 9.6v.01",
};

/**
 * This function draws the sign of a tone: a check mark, an exclamation mark, a cross or a question mark. The sign has
 * the color of the text around it. A text tells the same fact beside the sign, thus a screen reader does not read the sign.
 */
export function toneSign(tone: Tone): SVGElement {
  return svg("svg", { class: "sign", viewBox: "0 0 12 12", "aria-hidden": "true", focusable: "false" }, svg("path", { d: SIGN_PATHS[tone] }));
}

/** This function draws a chip with the sign of a tone and a word. Thus the color of the chip is not the only cue. */
export function toneChip(tone: Tone, word: string): HTMLElement {
  return h("span", { class: `chip toned ${tone}` }, toneSign(tone), word);
}
