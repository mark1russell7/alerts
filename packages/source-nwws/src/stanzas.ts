/**
 * The stanzas of a room of NWWS-OI as XML text, for a scripted XMPP server of a test. The room tells a join with a
 * presence that has the status code 110. It sends each product in a message of the type `groupchat`. A product of the
 * history of the room has an element `delay` (XEP-0203).
 *
 * A value of the form `{{token}}` stays as it is, so that the server of the test can put a value in its place.
 */

import { escapeAttribute } from "@mark1russell7/text";
import { PRODUCT_NAMESPACE } from "./product.ts";

const MUC_USER = "http://jabber.org/protocol/muc#user";
const DELAY = "urn:xmpp:delay";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";

/** The fields of the message of one product. */
export interface ProductStanza {
  /** The bare JID of the room. */
  readonly room: string;
  /** The full JID of the session. */
  readonly to: string;
  /** The id of the product: the processor, a dot and the sequence number. */
  readonly id: string;
  /** The issue time of the product, in UTC, for example `2026-11-17T12:00:00Z`. */
  readonly issue: string;
  readonly ttaaii: string;
  readonly cccc: string;
  readonly awipsid: string;
  /** The text of the product: the WMO heading, the AWIPS id and the body. */
  readonly text: string;
  /** The time of the product in the history of the room. With this field, the message comes from the history. */
  readonly delayed?: string;
}

/** This function gives the message of the room with one product. */
export function productStanza(product: ProductStanza): string {
  const a = escapeAttribute;
  const delay = product.delayed === undefined ? "" : `<delay xmlns='${DELAY}' from='${a(product.room)}' stamp='${a(product.delayed)}'/>`;
  const element =
    `<x xmlns='${PRODUCT_NAMESPACE}' cccc='${a(product.cccc)}' ttaaii='${a(product.ttaaii)}' issue='${a(product.issue)}' ` +
    `awipsid='${a(product.awipsid)}' id='${a(product.id)}'>${a(product.text)}</x>`;
  return `<message from='${a(product.room)}/nwws-oi' to='${a(product.to)}' type='groupchat'><body>${a(product.awipsid)}</body>${element}${delay}</message>`;
}

/** This function gives the presence of the room that tells the session of its join. `from` is the room and the nickname. */
export function selfPresence(from: string, to: string): string {
  return `<presence from='${escapeAttribute(from)}' to='${escapeAttribute(to)}'><x xmlns='${MUC_USER}'><item affiliation='none' role='participant'/><status code='110'/></x></presence>`;
}

/** This function gives the presence of the room that refuses a join, with a condition of RFC 6120, for example `not-allowed`. */
export function joinRefusal(from: string, to: string, condition: string): string {
  return `<presence from='${escapeAttribute(from)}' to='${escapeAttribute(to)}' type='error'><error type='cancel'><${condition} xmlns='${STANZAS}'/></error></presence>`;
}
