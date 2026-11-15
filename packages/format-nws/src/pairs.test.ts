import { readFileSync } from "node:fs";
import type { CorrelationKey } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { mainVtec, parseVtec, vtecKey, type Vtec } from "./vtec.ts";

/**
 * Each pair is one NWS product, as the NWS API and FEMA IPAWS gave it. The two copies have different
 * CAP identifiers and different references. Only the VTEC key links them.
 */
const PAIRS = [
  { name: "kewx-ff-w-0108-new", key: "KEWX.FF.W.0108.2026" },
  { name: "kewx-ff-w-0108-ext", key: "KEWX.FF.W.0108.2026" },
];

const fixture = (file: string): string => readFileSync(new URL(`../fixtures/pairs/${file}`, import.meta.url), "utf8");

function keyOf(vtecTexts: readonly string[], sent: string): CorrelationKey | undefined {
  const vtec = mainVtec(vtecTexts.map((text) => parseVtec(text)).filter((value): value is Vtec => value !== undefined));
  return vtec === undefined ? undefined : vtecKey(vtec, Date.parse(sent));
}

/** The key of the NWS API copy: the VTEC parameter and the sent time of the feature. */
function apiKey(text: string): { key: CorrelationKey | undefined; id: string } {
  const { properties } = JSON.parse(text) as { properties: { id: string; sent: string; parameters: { VTEC?: string[] } } };
  return { key: keyOf(properties.parameters.VTEC ?? [], properties.sent), id: properties.id };
}

/**
 * The key of the IPAWS copy. The test reads the CAP elements with patterns, because the CAP reader
 * is in another package. The copy has one info block for each language, so each VTEC occurs twice.
 */
function capKey(xml: string): { key: CorrelationKey | undefined; id: string } {
  const sent = /<sent>([^<]+)<\/sent>/.exec(xml)?.[1] ?? "";
  const id = /<identifier>([^<]+)<\/identifier>/.exec(xml)?.[1] ?? "";
  const vtec = [...xml.matchAll(/<valueName>VTEC<\/valueName>\s*<value>([^<]+)<\/value>/g)].map((match) => match[1] ?? "");
  return { key: keyOf([...new Set(vtec)], sent), id };
}

describe("one NWS product through two sources", () => {
  for (const { name, key } of PAIRS) {
    it(`gives one VTEC key for the NWS API copy and the IPAWS copy (${name})`, () => {
      const api = apiKey(fixture(`${name}.nws-api.json`));
      const cap = capKey(fixture(`${name}.ipaws.xml`));
      expect(api.key).toEqual({ system: "vtec", id: key });
      expect(cap.key).toEqual(api.key);
      // The identifiers differ: IPAWS adds a suffix to the identifier of the NWS.
      expect(cap.id).toBe(`${api.id}.IPAWS`);
    });
  }
});
