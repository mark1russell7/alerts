/**
 * The reader of the index of a CAP feed: an RSS 2.0 or Atom 1.0 document whose entries link to CAP messages. The
 * feeds of the WMO register of alerting authorities have this form. Examples are the feeds of the hub of the WMO and
 * the feeds of the DWD.
 */
import { Problems, type MapProblem } from "@mark1russell7/alerts";
import { ENTITY_ACTION, EntityDecoder } from "@nodable/entities";
import { XMLParser, XMLValidator } from "fast-xml-parser";

/** The media type of a CAP message in the link of an entry. */
export const CAP_MEDIA_TYPE = "application/cap+xml";

/** The namespace of Atom 1.0. */
export const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";

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

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // The reader keeps the prefixes: an RSS item can hold an atom:link next to its link.
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === "item" || name === "entry" || name === "link" || name === "enclosure",
  // The decoder blocks each entity of a DOCTYPE: a second guard, after the refusal of a DOCTYPE.
  entityDecoder: new EntityDecoder({
    numericAllowed: true,
    onInputEntity: () => ENTITY_ACTION.BLOCK,
    onExternalEntity: () => ENTITY_ACTION.BLOCK,
  }),
});

type XmlObject = { readonly [name: string]: unknown };

const isObject = (value: unknown): value is XmlObject => typeof value === "object" && value !== null && !Array.isArray(value);

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/** This function gives the text of an element: a string, or the text of an element with attributes. An empty text gives `undefined`. */
function textOf(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : isObject(value) && typeof value["#text"] === "string" ? value["#text"] : undefined;
  return text === undefined || text.trim() === "" ? undefined : text.trim();
}

/** This function gives the value of an attribute of an element, or `undefined`. */
function attributeOf(value: unknown, name: string): string | undefined {
  const attribute = isObject(value) ? value[`@_${name}`] : undefined;
  return typeof attribute === "string" && attribute.trim() !== "" ? attribute.trim() : undefined;
}

/**
 * This function chooses the link of an Atom entry. A link with the media type of CAP wins. The next choice is the
 * link of the relation `alternate`, or a link with no relation.
 */
function atomLink(entry: XmlObject): string | undefined {
  const links = listOf(entry["link"]).filter((link) => attributeOf(link, "href") !== undefined);
  const chosen =
    links.find((link) => attributeOf(link, "type") === CAP_MEDIA_TYPE) ??
    links.find((link) => (attributeOf(link, "rel") ?? "alternate") === "alternate");
  return chosen === undefined ? undefined : attributeOf(chosen, "href");
}

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
    const link = format === "rss" ? rssLink(node) : atomLink(node);
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
  if (xml.includes("<!DOCTYPE")) return { ok: false, reason: "the text has a DOCTYPE: the index of a CAP feed has no DTD" };
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    const { msg, line, col } = valid.err;
    return { ok: false, reason: `the XML is not well formed: ${msg} (line ${String(line)}, column ${String(col)})` };
  }
  const document: unknown = parser.parse(xml);
  if (!isObject(document)) return { ok: false, reason: "the text has no root element" };
  const problems = new Problems();
  if (document["rss"] !== undefined) {
    const rss = document["rss"];
    const channel = isObject(rss) ? rss["channel"] : undefined;
    if (!isObject(channel)) return { ok: false, reason: "the rss element has no channel" };
    const version = attributeOf(rss, "version");
    if (version !== "2.0") problems.add("rss", `the version of RSS is ${version ?? "absent"}, not 2.0`, "note");
    return { ok: true, format: "rss", entries: entriesOf("rss", listOf(channel["item"]), problems), problems: problems.list };
  }
  if (document["feed"] !== undefined) {
    const feed = document["feed"];
    // An empty feed element is an Atom feed with no entry.
    const node: XmlObject = isObject(feed) ? feed : {};
    const namespace = attributeOf(node, "xmlns");
    if (namespace !== ATOM_NAMESPACE) problems.add("feed", `the namespace of the feed is ${namespace ?? "absent"}, not the namespace of Atom 1.0`, "note");
    return { ok: true, format: "atom", entries: entriesOf("atom", listOf(node["entry"]), problems), problems: problems.list };
  }
  const root = Object.keys(document).find((name) => !name.startsWith("?"));
  return { ok: false, reason: `the root element is ${root ?? "absent"}, not rss or an Atom feed` };
}
