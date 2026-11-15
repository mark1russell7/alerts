/**
 * The split of a document that holds CAP alerts: the feed of FEMA IPAWS (`ns1:alerts`), an Atom feed
 * or an EDXL envelope. Each alert becomes one observation, so the id of each observation is stable.
 */

import { declaredNamespace, localName, nextTag, prefixOf } from "./scan.ts";

/** A document that holds CAP alerts, as `splitFeed` reads it. */
export interface CapFeed {
  /** The name of the root element, with its prefix. It is absent when the text has no element. */
  readonly root?: string;
  /** The namespace of the root element, when its start tag declares it. */
  readonly namespace?: string;
  /** The text of each alert, as `splitAlerts` gives it. */
  readonly alerts: readonly string[];
  /**
   * True: the root element ends, and only blanks, comments and processing instructions follow it. A
   * cut document is not whole. The client cannot see each cut, for example a cut of a body with no length.
   */
  readonly whole: boolean;
}

/** This function examines that the text from `from` holds only blanks, comments and processing instructions. */
function onlyBlanks(xml: string, from: number): boolean {
  let at = from;
  while (at < xml.length) {
    if ((xml[at] as string).trim() === "") {
      at += 1;
      continue;
    }
    const end = xml.startsWith("<!--", at) ? "-->" : xml.startsWith("<?", at) ? "?>" : undefined;
    if (end === undefined) return false;
    const close = xml.indexOf(end, at + 2);
    if (close < 0) return false;
    at = close + end.length;
  }
  return true;
}

/**
 * This function reads a document that holds CAP alerts: its root, the namespace of the root, its
 * alerts, and the end of the root. The function does not check the XML of the alerts: `readCap` does that.
 */
export function splitFeed(xml: string): CapFeed {
  const alerts = splitAlerts(xml);
  const first = nextTag(xml, 0);
  if (first === undefined || first.kind === "close") return { alerts, whole: false };
  const namespace = declaredNamespace(xml, first, prefixOf(first.name));
  const head = { root: first.name, ...(namespace === undefined ? {} : { namespace }), alerts };
  if (first.kind === "empty") return { ...head, whole: onlyBlanks(xml, first.end) };
  let depth = 1;
  let tag = nextTag(xml, first.end);
  while (tag !== undefined) {
    if (tag.kind !== "empty") depth += tag.kind === "open" ? 1 : -1;
    if (depth === 0) return { ...head, whole: onlyBlanks(xml, tag.end) };
    tag = nextTag(xml, tag.end);
  }
  return { ...head, whole: false };
}

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
