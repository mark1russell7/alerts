/**
 * The drawing parts that the demo and the local page share: the SVG element, the chip of a level and the chip of a status.
 * This module does not import the made-up data of the demo, so the bundle of the local page does not hold it.
 */

import type { AssessedLevel, Status } from "@mark1russell7/alerts";
import { h } from "@mark1russell7/site-pages/chrome";
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
