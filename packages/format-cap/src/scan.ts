/**
 * A scanner of the tags of an XML text. It finds the tags in order and skips comments, CDATA sections,
 * processing instructions and declarations. It does not check the XML: the reader does that.
 */

/** One tag of an XML text: its place, its name and its kind. */
export interface Tag {
  /** The index of the `<` of the tag. */
  readonly start: number;
  /** The index after the `>` of the tag. */
  readonly end: number;
  /** The name of the element, with its prefix. */
  readonly name: string;
  /** `open` is a start tag, `close` is an end tag, `empty` is a tag that ends with `/>`. */
  readonly kind: "open" | "close" | "empty";
}

/** The ends of the parts of an XML text that hold no tag. */
const SKIPS: readonly (readonly [begin: string, end: string])[] = [
  ["<!--", "-->"],
  ["<![CDATA[", "]]>"],
  ["<?", "?>"],
  ["<!", ">"],
];

const isNameEnd = (char: string): boolean => char === ">" || char === "/" || char.trim() === "";

/**
 * This function finds the next tag at or after the index `from`. A text that stops in a tag gives
 * `undefined`. A `>` in a quoted value of an attribute does not end the tag.
 */
export function nextTag(xml: string, from: number): Tag | undefined {
  let at = xml.indexOf("<", from);
  scan: while (at >= 0) {
    for (const [begin, end] of SKIPS) {
      if (!xml.startsWith(begin, at)) continue;
      const close = xml.indexOf(end, at + begin.length);
      if (close < 0) return undefined;
      at = xml.indexOf("<", close + end.length);
      continue scan;
    }
    const closing = xml[at + 1] === "/";
    const nameStart = at + (closing ? 2 : 1);
    let index = nameStart;
    while (index < xml.length && !isNameEnd(xml[index] as string)) index += 1;
    const name = xml.slice(nameStart, index);
    let quote: string | undefined;
    for (; index < xml.length; index += 1) {
      const char = xml[index] as string;
      if (quote !== undefined) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        const kind = closing ? "close" : xml[index - 1] === "/" ? "empty" : "open";
        return { start: at, end: index + 1, name, kind };
      }
    }
    return undefined;
  }
  return undefined;
}

/** This function gives the name of an element without its prefix: `cap:alert` gives `alert`. */
export function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

/** This function gives the prefix of the name of an element, or `undefined` for a name with no prefix. */
export function prefixOf(name: string): string | undefined {
  const colon = name.indexOf(":");
  return colon < 0 ? undefined : name.slice(0, colon);
}

/**
 * This function gives the namespace that a start tag declares for a prefix, or for no prefix. A tag
 * that does not declare it gives `undefined`.
 */
export function declaredNamespace(xml: string, tag: Tag, prefix: string | undefined): string | undefined {
  const text = xml.slice(tag.start, tag.end);
  const attribute = prefix === undefined ? "xmlns" : `xmlns:${prefix}`;
  let at = text.indexOf(attribute);
  while (at >= 0) {
    const before = text[at - 1] ?? "";
    let index = at + attribute.length;
    while (text[index] !== undefined && (text[index] as string).trim() === "") index += 1;
    if (before.trim() === "" && text[index] === "=") {
      index += 1;
      while (text[index] !== undefined && (text[index] as string).trim() === "") index += 1;
      const quote = text[index];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, index + 1);
        if (close > index) return text.slice(index + 1, close);
      }
    }
    at = text.indexOf(attribute, at + attribute.length);
  }
  return undefined;
}
