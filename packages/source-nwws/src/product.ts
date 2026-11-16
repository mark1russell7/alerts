/**
 * The products of the NWWS-OI stream. Each message of the room of NWWS-OI holds one product of the NWS in an element
 * `x` of the namespace `nwws-oi`. The element has five attributes and the text of the product. The functions of this
 * file are pure, and they do not throw.
 */

import type { Instant } from "@mark1russell7/alerts";

/** The namespace of the element that holds a product. */
export const PRODUCT_NAMESPACE = "nwws-oi";

/** One product of the stream. */
export interface NwwsProduct {
  /** The id of the product on the stream, for example `nwws_processor.3192`. */
  readonly id: string;
  /** The processor of the stream: the part of the id before the last dot. */
  readonly processor: string;
  /** The sequence number of the product at its processor: the part of the id after the last dot. */
  readonly serial: number;
  /** The issue time of the product. */
  readonly issue: Instant;
  /** The data type and the area of the WMO heading, for example `XOUS55`. */
  readonly ttaaii: string;
  /** The office of the WMO heading, for example `KWBC`. */
  readonly cccc: string;
  /** The AWIPS id, for example `CAPTOP`. The stream pads a short id with spaces. This field has no space. */
  readonly awipsid: string;
  /** The text of the product: the WMO heading, the AWIPS id and the body. */
  readonly text: string;
}

/** The result of the read of a product. */
export type ProductRead = { readonly ok: true; readonly product: NwwsProduct } | { readonly ok: false; readonly reason: string };

const ID = /^(.+)\.(\d{1,15})$/;
const ISSUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TTAAII = /^[A-Z]{4}\d{2}$/;
const CCCC = /^[A-Z]{4}$/;
const AWIPSID = /^[A-Z0-9]{0,6}$/;

/**
 * This function reads a product from the attributes of its element and from the text of the element. It gives the
 * reason when an attribute is absent or has a bad form.
 */
export function readProduct(attributes: Readonly<Record<string, string | undefined>>, text: string): ProductRead {
  const id = attributes["id"] ?? "";
  const parts = ID.exec(id);
  if (parts === null) return { ok: false, reason: `the id "${id}" is not a processor and a sequence number` };
  const issueText = attributes["issue"] ?? "";
  const issue = ISSUE.test(issueText) ? Date.parse(issueText) : Number.NaN;
  if (Number.isNaN(issue)) return { ok: false, reason: `the issue time "${issueText}" is not a time in UTC` };
  const ttaaii = attributes["ttaaii"] ?? "";
  if (!TTAAII.test(ttaaii)) return { ok: false, reason: `the attribute ttaaii "${ttaaii}" is not a WMO data type and area` };
  const cccc = attributes["cccc"] ?? "";
  if (!CCCC.test(cccc)) return { ok: false, reason: `the attribute cccc "${cccc}" is not an office of four letters` };
  const awipsid = (attributes["awipsid"] ?? "").trim();
  if (!AWIPSID.test(awipsid)) return { ok: false, reason: `the AWIPS id "${awipsid}" is not six letters or digits` };
  return { ok: true, product: { id, processor: parts[1]!, serial: Number(parts[2]), issue, ttaaii, cccc, awipsid, text } };
}

/**
 * This function tells if a product is a CAP message of the NWS. The NWS sends each CAP message with the data type `XO`
 * and an AWIPS id that starts with `CAP`.
 */
export function isCapProduct(product: NwwsProduct): boolean {
  return product.ttaaii.startsWith("XO") && product.awipsid.startsWith("CAP");
}

/**
 * This function gives the XML of a CAP product: the text from the XML declaration or from the element `alert` to the
 * end. A text with no XML gives `undefined`.
 */
export function capXml(text: string): string | undefined {
  const declaration = text.indexOf("<?xml");
  const start = declaration >= 0 ? declaration : text.search(/<alert[\s>]/);
  return start < 0 ? undefined : text.slice(start).trim();
}
