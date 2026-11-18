import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { capXml, isCapProduct, readProduct, type NwwsProduct } from "./product.ts";
import type { RoomProduct } from "./session.ts";

// The six real products of the fixture.
const PRODUCTS: readonly (RoomProduct & { readonly received: number })[] = JSON.parse(readFileSync(new URL("../fixtures/products-20261116T2002Z.json", import.meta.url), "utf8"));

function product(index: number): NwwsProduct {
  const entry = PRODUCTS[index]!;
  const read = readProduct(entry.attributes, entry.text);
  if (!read.ok) throw new Error(read.reason);
  return read.product;
}

describe("readProduct", () => {
  it("reads each real product of the fixture", () => {
    expect(PRODUCTS.map((entry) => readProduct(entry.attributes, entry.text).ok)).toEqual([true, true, true, true, true, true]);
    expect(product(2)).toMatchObject({
      id: "nwws_processor.3243",
      processor: "nwws_processor",
      serial: 3243,
      issue: Date.parse("2026-11-16T20:04:00Z"),
      ttaaii: "XOUS55",
      cccc: "KWBC",
      awipsid: "CAPWBC",
    });
  });

  it("removes the space that pads a short AWIPS id, and keeps an empty id", () => {
    expect(PRODUCTS[0]!.attributes["awipsid"]).toBe("RWRIL ");
    expect(product(0).awipsid).toBe("RWRIL");
    expect(product(1).awipsid).toBe("");
  });

  it("gives the reason for an absent or bad attribute", () => {
    const good = PRODUCTS[2]!.attributes;
    const bad = (change: Record<string, string | undefined>) => readProduct({ ...good, ...change }, "");
    expect(bad({ id: undefined })).toEqual({ ok: false, reason: 'the id "" is not a processor and a sequence number' });
    expect(bad({ id: "nwws_processor" })).toMatchObject({ ok: false });
    expect(bad({ issue: "2026-11-16T20:04:00-05:00" })).toEqual({ ok: false, reason: 'the issue time "2026-11-16T20:04:00-05:00" is not a time in UTC' });
    expect(bad({ issue: "2026-13-40T20:04:00Z" })).toMatchObject({ ok: false });
    expect(bad({ ttaaii: "XOUS5" })).toMatchObject({ ok: false });
    expect(bad({ cccc: "KWB" })).toMatchObject({ ok: false });
    expect(bad({ awipsid: "CAPWBC1" })).toMatchObject({ ok: false });
  });

  it("does not throw for any attributes and any text", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom("id", "issue", "ttaaii", "cccc", "awipsid", "other"), fc.string()), fc.string(), (attributes, text) => {
        const read = readProduct(attributes, text);
        expect(typeof read.ok).toBe("boolean");
      }),
    );
  });

  it("reads the processor and the sequence number of each valid id", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z_.]{1,20}$/), fc.nat({ max: 1e12 }), (processor, serial) => {
        const read = readProduct({ ...PRODUCTS[2]!.attributes, id: `${processor}.${String(serial)}` }, "");
        expect(read.ok && read.product.processor === processor && read.product.serial === serial).toBe(true);
      }),
    );
  });
});

describe("isCapProduct", () => {
  it("keeps the CAP messages of the NWS and no text product", () => {
    expect(PRODUCTS.map((_, index) => isCapProduct(product(index)))).toEqual([false, false, true, true, true, true]);
  });
});

describe("capXml", () => {
  it("gives the XML of a CAP product, from the declaration to the end of the alert", () => {
    const xml = capXml(product(3).text);
    expect(xml?.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
    expect(xml?.endsWith("</alert>")).toBe(true);
    expect(xml).toContain("<event>Special Marine Warning</event>");
  });

  it("gives the XML from the element alert when the text has no declaration", () => {
    expect(capXml('\n\nXOUS55 KWBC 162004\n\n<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"></alert>\n\n')).toBe('<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"></alert>');
  });

  it("gives undefined for a text with no XML", () => {
    expect(capXml(product(1).text)).toBeUndefined();
    expect(capXml("an <alerted> word")).toBeUndefined();
  });
});
