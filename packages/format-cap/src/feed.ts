/**
 * The reader of a feed: an RSS 2.0 or Atom 1.0 document. The reader of the index of a CAP feed uses it, and each source
 * that reads a feed of texts uses it too. The reader refuses a DOCTYPE and a text that is not well formed.
 */
import { Problems, type MapProblem } from "@mark1russell7/alerts";
import { ENTITY_ACTION, EntityDecoder } from "@nodable/entities";
import { XMLParser, XMLValidator } from "fast-xml-parser";

/** The namespace of Atom 1.0. */
export const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";

/** One entry of a feed: an RSS item or an Atom entry. Each field is a trimmed text. An absent or empty field is absent. */
export interface FeedEntry {
  /** The `guid` of an RSS item or the `id` of an Atom entry. */
  readonly id?: string;
  /** The `title` of the entry. */
  readonly title?: string;
  /** The `link` text of an RSS item, or the `href` of the `alternate` link of an Atom entry. */
  readonly link?: string;
  /** The time of the entry, as the feed gives it: `pubDate` of RSS, or `updated` (else `published`) of Atom. */
  readonly updated?: string;
  /** The `description` of an RSS item, or the `summary` (else `content`) of an Atom entry. */
  readonly summary?: string;
}

/** A feed, as `readFeed` reads it. `malformed` tells a text that is not well formed: a cut answer gives such a text. */
export type FeedRead =
  | { readonly ok: true; readonly format: "rss" | "atom"; readonly title?: string; readonly entries: readonly FeedEntry[]; readonly problems: readonly MapProblem[] }
  | { readonly ok: false; readonly reason: string; readonly malformed: boolean };

/** An open feed: its format, its channel or feed element, its entry elements and the notes of its head. */
export type OpenFeed =
  | { readonly ok: true; readonly format: "rss" | "atom"; readonly head: XmlObject; readonly nodes: readonly unknown[]; readonly problems: Problems }
  | { readonly ok: false; readonly reason: string; readonly malformed: boolean };

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

/** An element of a feed, as the parser gives it. Each attribute has the prefix `@_`. */
export type XmlObject = { readonly [name: string]: unknown };

/** This function tells if a value is an element with children or attributes. */
export const isObject = (value: unknown): value is XmlObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** This function gives a list for a value that the parser gives as one value or as a list. */
export const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/** This function gives the text of an element: a string, or the text of an element with attributes. An empty text gives `undefined`. */
export function textOf(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : isObject(value) && typeof value["#text"] === "string" ? value["#text"] : undefined;
  return text === undefined || text.trim() === "" ? undefined : text.trim();
}

/** This function gives the value of an attribute of an element, or `undefined`. */
export function attributeOf(value: unknown, name: string): string | undefined {
  const attribute = isObject(value) ? value[`@_${name}`] : undefined;
  return typeof attribute === "string" && attribute.trim() !== "" ? attribute.trim() : undefined;
}

/**
 * This function opens a feed. It refuses a DOCTYPE and a text that is not well formed. It finds the channel of RSS or
 * the Atom feed. A version that is not RSS 2.0, or a namespace that is not Atom 1.0, gives a note.
 */
export function openFeed(xml: string): OpenFeed {
  if (xml.includes("<!DOCTYPE")) return { ok: false, reason: "the text has a DOCTYPE: a feed has no DTD", malformed: false };
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    const { msg, line, col } = valid.err;
    return { ok: false, reason: `the XML is not well formed: ${msg} (line ${String(line)}, column ${String(col)})`, malformed: true };
  }
  const document: unknown = parser.parse(xml);
  if (!isObject(document)) return { ok: false, reason: "the text has no root element", malformed: false };
  const problems = new Problems();
  if (document["rss"] !== undefined) {
    const rss = document["rss"];
    const channel = isObject(rss) ? rss["channel"] : undefined;
    if (!isObject(channel)) return { ok: false, reason: "the rss element has no channel", malformed: false };
    const version = attributeOf(rss, "version");
    if (version !== "2.0") problems.add("rss", `the version of RSS is ${version ?? "absent"}, not 2.0`, "note");
    return { ok: true, format: "rss", head: channel, nodes: listOf(channel["item"]), problems };
  }
  if (document["feed"] !== undefined) {
    const feed = document["feed"];
    // An empty feed element is an Atom feed with no entry.
    const head: XmlObject = isObject(feed) ? feed : {};
    const namespace = attributeOf(head, "xmlns");
    if (namespace !== ATOM_NAMESPACE) problems.add("feed", `the namespace of the feed is ${namespace ?? "absent"}, not the namespace of Atom 1.0`, "note");
    return { ok: true, format: "atom", head, nodes: listOf(head["entry"]), problems };
  }
  const root = Object.keys(document).find((name) => !name.startsWith("?"));
  return { ok: false, reason: `the root element is ${root ?? "absent"}, not rss or an Atom feed`, malformed: false };
}

/**
 * This function chooses the link of an Atom entry. A link of the media type `preferred` wins. The next choice is the
 * link of the relation `alternate`, or a link with no relation.
 */
export function atomLink(entry: XmlObject, preferred?: string): string | undefined {
  const links = listOf(entry["link"]).filter((link) => attributeOf(link, "href") !== undefined);
  const chosen =
    (preferred === undefined ? undefined : links.find((link) => attributeOf(link, "type") === preferred)) ??
    links.find((link) => (attributeOf(link, "rel") ?? "alternate") === "alternate");
  return chosen === undefined ? undefined : attributeOf(chosen, "href");
}

/** This function gives the fields of one entry that are present. */
function entryOf(format: "rss" | "atom", node: XmlObject): FeedEntry {
  const fields: Record<string, string | undefined> =
    format === "rss"
      ? { id: textOf(node["guid"]), title: textOf(node["title"]), link: listOf(node["link"]).map(textOf).find((link) => link !== undefined), updated: textOf(node["pubDate"]), summary: textOf(node["description"]) }
      : { id: textOf(node["id"]), title: textOf(node["title"]), link: atomLink(node), updated: textOf(node["updated"]) ?? textOf(node["published"]), summary: textOf(node["summary"]) ?? textOf(node["content"]) };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as FeedEntry;
}

/**
 * This function reads a feed: an RSS 2.0 `rss` document or an Atom 1.0 `feed` document. Each item or entry gives one
 * `FeedEntry`, in the order of the document. An empty item is a lossy problem. The function keeps each entry, also two
 * entries with the same id: the caller chooses.
 */
export function readFeed(xml: string): FeedRead {
  const open = openFeed(xml);
  if (!open.ok) return open;
  const name = open.format === "rss" ? "item" : "entry";
  const entries: FeedEntry[] = [];
  open.nodes.forEach((node, index) => {
    if (isObject(node)) entries.push(entryOf(open.format, node));
    else open.problems.add(`${name}[${String(index)}]`, `the ${name} is empty`);
  });
  const title = textOf(open.head["title"]);
  return { ok: true, format: open.format, ...(title === undefined ? {} : { title }), entries, problems: open.problems.list };
}
