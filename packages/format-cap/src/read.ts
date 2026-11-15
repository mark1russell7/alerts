/**
 * The reader of one CAP 1.2 message (OASIS CAP 1.2, and CAP 1.1). It gives the elements of the message
 * as texts, with no change of value. The map function of each source changes the texts into a report.
 */

import { Problems, type MapProblem } from "@mark1russell7/alerts";
import { ENTITY_ACTION, EntityDecoder } from "@nodable/entities";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { declaredNamespace, localName, nextTag, prefixOf } from "./scan.ts";
import { capList } from "./values.ts";

/** The namespaces of CAP that the reader knows, with their versions. */
export const CAP_NAMESPACES: Readonly<Record<string, CapVersion>> = {
  "urn:oasis:names:tc:emergency:cap:1.2": "1.2",
  "urn:oasis:names:tc:emergency:cap:1.1": "1.1",
};

/** The versions of CAP that the reader knows. */
export type CapVersion = "1.2" | "1.1";

/** A name and a value: an `eventCode`, a `parameter` or a `geocode`. */
export interface CapPair {
  readonly valueName: string;
  readonly value: string;
}

/** One entry of the `references` of a message: the message that this message updates or cancels. */
export interface CapReference {
  readonly sender: string;
  readonly identifier: string;
  readonly sent: string;
}

/** One `resource` of an info block. The reader does not keep `derefUri`, the inline content. */
export interface CapResource {
  readonly resourceDesc: string;
  readonly mimeType: string;
  readonly size?: string;
  readonly uri?: string;
  readonly digest?: string;
}

/** One `area` of an info block. The polygons and circles stay texts: `capPolygon` and `capCircle` read them. */
export interface CapArea {
  readonly areaDesc: string;
  readonly polygons: readonly string[];
  readonly circles: readonly string[];
  readonly geocodes: readonly CapPair[];
  readonly altitude?: string;
  readonly ceiling?: string;
}

/** One `info` block of a message. A message has one info block for each language, or more. */
export interface CapInfo {
  /** The language of the block. CAP gives `en-US` when the element is absent. */
  readonly language: string;
  readonly categories: readonly string[];
  readonly event: string;
  readonly responseTypes: readonly string[];
  readonly urgency: string;
  readonly severity: string;
  readonly certainty: string;
  readonly audience?: string;
  readonly eventCodes: readonly CapPair[];
  readonly effective?: string;
  readonly onset?: string;
  readonly expires?: string;
  readonly senderName?: string;
  readonly headline?: string;
  readonly description?: string;
  readonly instruction?: string;
  readonly web?: string;
  readonly contact?: string;
  readonly parameters: readonly CapPair[];
  readonly resources: readonly CapResource[];
  readonly areas: readonly CapArea[];
}

/** One CAP message. An absent necessary element gives an empty text and a problem. */
export interface CapAlert {
  readonly version: CapVersion;
  readonly identifier: string;
  readonly sender: string;
  readonly sent: string;
  readonly status: string;
  readonly msgType: string;
  readonly source?: string;
  readonly scope: string;
  readonly restriction?: string;
  readonly addresses: readonly string[];
  readonly codes: readonly string[];
  readonly note?: string;
  readonly references: readonly CapReference[];
  readonly incidents: readonly string[];
  readonly infos: readonly CapInfo[];
}

/**
 * The result of the reader. A text that is not a CAP message gives `ok: false` and the reason. A CAP
 * message gives its elements and the problems: unknown elements, absent necessary elements and bad references.
 */
export type CapRead =
  | { readonly ok: true; readonly alert: CapAlert; readonly problems: readonly MapProblem[] }
  | { readonly ok: false; readonly reason: string };

/** The elements that can occur more than one time. The parser gives a list for each of them. */
const LISTS: ReadonlySet<string> = new Set([
  "code",
  "info",
  "category",
  "responseType",
  "eventCode",
  "parameter",
  "resource",
  "area",
  "polygon",
  "circle",
  "geocode",
]);

/** The elements of each level that the reader knows. `Signature` is the XML signature (XML DSig) of IPAWS. */
const KNOWN = {
  alert: new Set([
    "identifier",
    "sender",
    "sent",
    "status",
    "msgType",
    "source",
    "scope",
    "restriction",
    "addresses",
    "code",
    "note",
    "references",
    "incidents",
    "info",
    "Signature",
  ]),
  info: new Set([
    "language",
    "category",
    "event",
    "responseType",
    "urgency",
    "severity",
    "certainty",
    "audience",
    "eventCode",
    "effective",
    "onset",
    "expires",
    "senderName",
    "headline",
    "description",
    "instruction",
    "web",
    "contact",
    "parameter",
    "resource",
    "area",
  ]),
  resource: new Set(["resourceDesc", "mimeType", "size", "uri", "derefUri", "digest"]),
  area: new Set(["areaDesc", "polygon", "circle", "geocode", "altitude", "ceiling"]),
  pair: new Set(["valueName", "value"]),
} as const;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Each value stays a text: a SAME code such as 048019 is not a number
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => LISTS.has(name),
  // The reader does not read the signature. A later check reads the bytes of the alert.
  stopNodes: ["*.Signature"],
  // XML has five named entities and the numeric references, for example &#39;. The default decoder
  // of fast-xml-parser does not read the numeric references, so the reader gives its own decoder.
  // The decoder blocks each entity of a DOCTYPE: a second guard, after the refusal of a DOCTYPE.
  entityDecoder: new EntityDecoder({
    numericAllowed: true,
    onInputEntity: () => ENTITY_ACTION.BLOCK,
    onExternalEntity: () => ENTITY_ACTION.BLOCK,
  }),
});

type XmlObject = { readonly [name: string]: unknown };

const isObject = (value: unknown): value is XmlObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** This function reports each element of an object that the reader does not know. */
function checkKnown(node: XmlObject, known: ReadonlySet<string>, path: string, problems: Problems): void {
  for (const name of Object.keys(node)) {
    if (name !== "#text" && !known.has(name)) problems.add(`${path}.${name}`, "the reader does not know this element");
  }
}

/** This function reads the text of one element. An empty element gives `undefined`. */
function textOf(node: XmlObject, name: string, path: string, problems: Problems): string | undefined {
  const value = node[name];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value === "" ? undefined : value;
  problems.add(`${path}.${name}`, "the element holds elements, not a text");
  return undefined;
}

/** This function reads the text of a necessary element. An absent element gives an empty text and a problem. */
function requiredOf(node: XmlObject, name: string, path: string, problems: Problems): string {
  const text = textOf(node, name, path, problems);
  if (text !== undefined) return text;
  problems.add(`${path}.${name}`, "the required element is absent");
  return "";
}

/** This function gives the items of an element that can occur more than one time. */
function itemsOf(node: XmlObject, name: string): readonly unknown[] {
  const value = node[name];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

/** This function reads the texts of an element that can occur more than one time. */
function textsOf(node: XmlObject, name: string, path: string, problems: Problems): string[] {
  const texts: string[] = [];
  itemsOf(node, name).forEach((item, index) => {
    if (typeof item === "string") {
      if (item !== "") texts.push(item);
    } else {
      problems.add(`${path}.${name}[${String(index)}]`, "the element holds elements, not a text");
    }
  });
  return texts;
}

/** This function reads the objects of an element that can occur more than one time. */
function objectsOf(node: XmlObject, name: string, path: string, problems: Problems): { readonly node: XmlObject; readonly path: string }[] {
  const objects: { node: XmlObject; path: string }[] = [];
  itemsOf(node, name).forEach((item, index) => {
    const at = `${path}.${name}[${String(index)}]`;
    if (isObject(item)) objects.push({ node: item, path: at });
    else problems.add(at, "the element holds a text, not elements");
  });
  return objects;
}

/** This function reads the pairs of a name and a value. */
function pairsOf(node: XmlObject, name: string, path: string, problems: Problems): CapPair[] {
  return objectsOf(node, name, path, problems).map((pair) => {
    checkKnown(pair.node, KNOWN.pair, pair.path, problems);
    return { valueName: requiredOf(pair.node, "valueName", pair.path, problems), value: textOf(pair.node, "value", pair.path, problems) ?? "" };
  });
}

/** The type of an object after `present`: each field that can be `undefined` is optional. */
type Present<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** This function removes the fields with the value `undefined` from an object. */
function present<T extends object>(value: T): Present<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Present<T>;
}

/** This function reads the references: entries `sender,identifier,sent` with spaces between them. */
function referencesOf(text: string | undefined, path: string, problems: Problems): CapReference[] {
  const references: CapReference[] = [];
  for (const entry of text === undefined ? [] : text.trim().split(/\s+/)) {
    if (entry === "") continue;
    const parts = entry.split(",");
    if (parts.length !== 3 || parts.some((part) => part === "")) {
      problems.add(path, `the reference ${JSON.stringify(entry)} is not "sender,identifier,sent"`);
      continue;
    }
    const [sender, identifier, sent] = parts as [string, string, string];
    references.push({ sender, identifier, sent });
  }
  return references;
}

function resourceOf(node: XmlObject, path: string, problems: Problems): CapResource {
  checkKnown(node, KNOWN.resource, path, problems);
  return present({
    resourceDesc: requiredOf(node, "resourceDesc", path, problems),
    mimeType: requiredOf(node, "mimeType", path, problems),
    size: textOf(node, "size", path, problems),
    uri: textOf(node, "uri", path, problems),
    digest: textOf(node, "digest", path, problems),
  });
}

function areaOf(node: XmlObject, path: string, problems: Problems): CapArea {
  checkKnown(node, KNOWN.area, path, problems);
  return present({
    areaDesc: requiredOf(node, "areaDesc", path, problems),
    polygons: textsOf(node, "polygon", path, problems),
    circles: textsOf(node, "circle", path, problems),
    geocodes: pairsOf(node, "geocode", path, problems),
    altitude: textOf(node, "altitude", path, problems),
    ceiling: textOf(node, "ceiling", path, problems),
  });
}

function infoOf(node: XmlObject, path: string, problems: Problems): CapInfo {
  checkKnown(node, KNOWN.info, path, problems);
  const categories = textsOf(node, "category", path, problems);
  if (categories.length === 0) problems.add(`${path}.category`, "the required element is absent");
  return present({
    language: textOf(node, "language", path, problems) ?? "en-US",
    categories,
    event: requiredOf(node, "event", path, problems),
    responseTypes: textsOf(node, "responseType", path, problems),
    urgency: requiredOf(node, "urgency", path, problems),
    severity: requiredOf(node, "severity", path, problems),
    certainty: requiredOf(node, "certainty", path, problems),
    audience: textOf(node, "audience", path, problems),
    eventCodes: pairsOf(node, "eventCode", path, problems),
    effective: textOf(node, "effective", path, problems),
    onset: textOf(node, "onset", path, problems),
    expires: textOf(node, "expires", path, problems),
    senderName: textOf(node, "senderName", path, problems),
    headline: textOf(node, "headline", path, problems),
    description: textOf(node, "description", path, problems),
    instruction: textOf(node, "instruction", path, problems),
    web: textOf(node, "web", path, problems),
    contact: textOf(node, "contact", path, problems),
    parameters: pairsOf(node, "parameter", path, problems),
    resources: objectsOf(node, "resource", path, problems).map((item) => resourceOf(item.node, item.path, problems)),
    areas: objectsOf(node, "area", path, problems).map((item) => areaOf(item.node, item.path, problems)),
  });
}

/**
 * This function reads one CAP message. The text is a CAP document, or the text of one `alert` element
 * from `splitAlerts`.
 *
 * The reader refuses a text with a DOCTYPE, because CAP has no DTD and a DTD can declare entities. It
 * refuses a text that is not well formed, so a cut message does not look whole at any time. A root
 * element with no declaration of its namespace is a problem, and the reader takes CAP 1.2.
 */
export function readCap(xml: string): CapRead {
  if (xml.includes("<!DOCTYPE")) return { ok: false, reason: "the text has a DOCTYPE: a CAP message has no DTD" };
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    const { msg, line, col } = valid.err;
    return { ok: false, reason: `the XML is not well formed: ${msg} (line ${String(line)}, column ${String(col)})` };
  }
  const root = nextTag(xml, 0);
  if (root === undefined || localName(root.name) !== "alert") {
    return { ok: false, reason: `the root element is ${root === undefined ? "absent" : root.name}, not a CAP alert` };
  }
  const problems = new Problems();
  const namespace = declaredNamespace(xml, root, prefixOf(root.name));
  let version: CapVersion = "1.2";
  if (namespace === undefined) {
    problems.add("alert", "the alert does not declare its namespace: the reader takes CAP 1.2");
  } else {
    const known = CAP_NAMESPACES[namespace];
    if (known === undefined) return { ok: false, reason: `the namespace ${namespace} is not CAP 1.1 or CAP 1.2` };
    version = known;
  }
  const document: unknown = parser.parse(xml);
  const alert = isObject(document) ? document["alert"] : undefined;
  if (!isObject(alert)) return { ok: false, reason: "the alert element holds no elements" };
  const path = "alert";
  checkKnown(alert, KNOWN.alert, path, problems);
  const result: CapAlert = present({
    version,
    identifier: requiredOf(alert, "identifier", path, problems),
    sender: requiredOf(alert, "sender", path, problems),
    sent: requiredOf(alert, "sent", path, problems),
    status: requiredOf(alert, "status", path, problems),
    msgType: requiredOf(alert, "msgType", path, problems),
    source: textOf(alert, "source", path, problems),
    scope: requiredOf(alert, "scope", path, problems),
    restriction: textOf(alert, "restriction", path, problems),
    addresses: capList(textOf(alert, "addresses", path, problems)),
    codes: textsOf(alert, "code", path, problems),
    note: textOf(alert, "note", path, problems),
    references: referencesOf(textOf(alert, "references", path, problems), `${path}.references`, problems),
    incidents: capList(textOf(alert, "incidents", path, problems)),
    infos: objectsOf(alert, "info", path, problems).map((item) => infoOf(item.node, item.path, problems)),
  });
  return { ok: true, alert: result, problems: problems.list };
}
