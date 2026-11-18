/**
 * The reader of the index of a CAP feed: an RSS 2.0 or Atom 1.0 document whose entries link to CAP messages. The
 * feeds of the WMO register of alerting authorities have this form. Examples are the feeds of the hub of the WMO and
 * the feeds of the DWD.
 */
import type { MapProblem, Problems } from "@mark1russell7/alerts";

import { atomLink, attributeOf, isObject, listOf, openFeed, textOf, type XmlObject } from "./feed.ts";

export { ATOM_NAMESPACE } from "./feed.ts";

/** The media type of a CAP message in the link of an entry. */
export const CAP_MEDIA_TYPE = "application/cap+xml";

/** One entry of the index of a CAP feed. */
export interface CapIndexEntry {
  /** The id of the entry: the `guid` of an RSS item or the `id` of an Atom entry. With neither, the link. */
  readonly id: string;
  /** The URL of the CAP message, as the feed gives it. A relative URL is relative to the URL of the feed. */
  readonly link: string;
  /** The time of the last change of the entry, as the feed gives it: `updated` of Atom or `pubDate` of RSS. */
  readonly updated?: string;
}

/** The index of a CAP feed, as `readCapIndex` reads it. */
export type CapIndexRead =
  | { readonly ok: true; readonly format: "rss" | "atom"; readonly entries: readonly CapIndexEntry[]; readonly problems: readonly MapProblem[] }
  | { readonly ok: false; readonly reason: string };

/**
 * This function chooses the link of an RSS item. The text of `link` wins. The next choices are an enclosure with the
 * media type of CAP, then a `guid` that is a URL and a permanent link.
 */
function rssLink(item: XmlObject): string | undefined {
  const text = listOf(item["link"]).map(textOf).find((link) => link !== undefined);
  if (text !== undefined) return text;
  const enclosure = listOf(item["enclosure"]).find((one) => attributeOf(one, "type") === CAP_MEDIA_TYPE && attributeOf(one, "url") !== undefined);
  if (enclosure !== undefined) return attributeOf(enclosure, "url");
  const guid = textOf(item["guid"]);
  return guid !== undefined && attributeOf(item["guid"], "isPermaLink") !== "false" && /^https?:\/\//i.test(guid) ? guid : undefined;
}

/** This function reads the entries of the index. It keeps the first entry of each id. */
function entriesOf(format: "rss" | "atom", nodes: readonly unknown[], problems: Problems): CapIndexEntry[] {
  const name = format === "rss" ? "item" : "entry";
  const entries: CapIndexEntry[] = [];
  const ids = new Set<string>();
  nodes.forEach((node, index) => {
    const path = `${name}[${String(index)}]`;
    if (!isObject(node)) {
      problems.add(path, `the ${name} is empty`);
      return;
    }
    const link = format === "rss" ? rssLink(node) : atomLink(node, CAP_MEDIA_TYPE);
    if (link === undefined) {
      problems.add(path, `the ${name} has no link to a CAP message`);
      return;
    }
    const id = (format === "rss" ? textOf(node["guid"]) : textOf(node["id"])) ?? link;
    if (ids.has(id)) {
      problems.add(path, `the id ${id} is not unique: the reader keeps the first ${name} of the id`, "note");
      return;
    }
    ids.add(id);
    const updated = format === "rss" ? textOf(node["pubDate"]) : (textOf(node["updated"]) ?? textOf(node["published"]));
    entries.push({ id, link, ...(updated === undefined ? {} : { updated }) });
  });
  return entries;
}

/**
 * This function reads the index of a CAP feed: an RSS 2.0 `rss` document or an Atom 1.0 `feed` document. Each entry
 * with a link to a CAP message gives one `CapIndexEntry`, in the order of the document. An entry with no link is a
 * lossy problem. The function does not read the messages: `readCap` does that.
 *
 * The reader refuses a text with a DOCTYPE, and a text that is not well formed. So a cut index is not a short index.
 */
export function readCapIndex(xml: string): CapIndexRead {
  const open = openFeed(xml);
  if (!open.ok) return { ok: false, reason: open.reason };
  return { ok: true, format: open.format, entries: entriesOf(open.format, open.nodes, open.problems), problems: open.problems.list };
}
