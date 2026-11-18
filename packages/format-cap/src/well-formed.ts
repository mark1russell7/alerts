import { XMLValidator, type XMLParser } from "fast-xml-parser";

/**
 * This function gives the fault of an XML text that is not well formed, or `undefined` for a well-formed text.
 *
 * The validator of `fast-xml-parser` can throw on a text. This function gives a fault for such a text too, so a
 * reader does not throw.
 */
export function xmlFault(xml: string): string | undefined {
  let valid: ReturnType<typeof XMLValidator.validate>;
  try {
    valid = XMLValidator.validate(xml);
  } catch (error) {
    return `the XML is not well formed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (valid === true) return undefined;
  const { msg, line, col } = valid.err;
  return `the XML is not well formed: ${msg} (line ${String(line)}, column ${String(col)})`;
}

/** The result of `parseXml`: the document, or the fault of a text that the parser cannot read. */
export type XmlParse = { readonly ok: true; readonly document: unknown } | { readonly ok: false; readonly fault: string };

/**
 * This function parses an XML text, and it does not throw.
 *
 * The validator accepts some texts on which the parser throws, for example `<:/`. Thus a reader parses with this function after `xmlFault`.
 */
export function parseXml(parser: XMLParser, xml: string): XmlParse {
  try {
    return { ok: true, document: parser.parse(xml) as unknown };
  } catch (error) {
    return { ok: false, fault: `the XML is not well formed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
