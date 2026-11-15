/**
 * The split of a document that holds CAP alerts: the feed of FEMA IPAWS (`ns1:alerts`), an Atom feed
 * or an EDXL envelope. Each alert becomes one observation, so the id of each observation is stable.
 */

import { localName, nextTag } from "./scan.ts";

/**
 * This function gives the text of each `alert` element of a document, in order, as the document has
 * it. The name of the element can have a prefix. A document that stops in an alert gives the rest of
 * the text as the last alert, and the reader then refuses it.
 *
 * The text keeps the bytes of the element, so a check of its XML signature stays possible.
 */
export function splitAlerts(xml: string): string[] {
  const alerts: string[] = [];
  let tag = nextTag(xml, 0);
  while (tag !== undefined) {
    if (tag.kind === "close" || localName(tag.name) !== "alert") {
      tag = nextTag(xml, tag.end);
      continue;
    }
    if (tag.kind === "empty") {
      alerts.push(xml.slice(tag.start, tag.end));
      tag = nextTag(xml, tag.end);
      continue;
    }
    // CAP has no alert in an alert, but the depth keeps the split right for an element of the same name
    let depth = 1;
    let inner = nextTag(xml, tag.end);
    while (inner !== undefined) {
      if (inner.name === tag.name && inner.kind !== "empty") depth += inner.kind === "open" ? 1 : -1;
      if (depth === 0) break;
      inner = nextTag(xml, inner.end);
    }
    if (inner === undefined) {
      alerts.push(xml.slice(tag.start));
      break;
    }
    alerts.push(xml.slice(tag.start, inner.end));
    tag = nextTag(xml, inner.end);
  }
  return alerts;
}
