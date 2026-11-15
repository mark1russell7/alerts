import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseInfo } from "./info.ts";
import { readCap, type CapInfo } from "./read.ts";

const infosOf = (xml: string): readonly CapInfo[] => {
  const read = readCap(xml);
  if (!read.ok) throw new Error(read.reason);
  return read.alert.infos;
};

/** The IPAWS copy of an NWS warning: one info block in en-US, then one in es-US. */
const INFOS = infosOf(readFileSync(new URL("../fixtures/pairs/kewx-ff-w-0108-new.ipaws.xml", import.meta.url), "utf8"));

/** This function gives info blocks in the languages of the list, with the fields of the fixture. */
const inLanguages = (...languages: string[]): CapInfo[] => languages.map((language) => ({ ...(INFOS[0] as CapInfo), language }));

describe("chooseInfo", () => {
  it("chooses en-US when the configuration gives no language", () => {
    expect(chooseInfo(INFOS)).toMatchObject({ index: 0, sameLanguage: 1, info: { language: "en-US" } });
  });

  it("chooses the first language of the list that a block has", () => {
    expect(chooseInfo(INFOS, ["fr-CA", "es-US", "en-US"])?.index).toBe(1);
    expect(chooseInfo(INFOS, ["ES-us"])?.index).toBe(1);
  });

  it("matches the first part of a language when no language matches in full", () => {
    expect(chooseInfo(inLanguages("fr-CA", "en-GB"), ["en-US"])?.index).toBe(1);
    expect(chooseInfo(inLanguages("fr-CA", "en-GB"), ["en"])?.index).toBe(1);
  });

  it("prefers a part match of an earlier language to a full match of a later language", () => {
    expect(chooseInfo(inLanguages("fr-CA", "en-GB"), ["en-US", "fr-CA"])?.index).toBe(1);
    expect(chooseInfo(inLanguages("en-GB", "en-US"), ["en-US"])?.index).toBe(1);
  });

  it("chooses the first block when no language matches", () => {
    expect(chooseInfo(INFOS, ["de-DE"])?.index).toBe(0);
  });

  it("counts the blocks in the language of the chosen block", () => {
    expect(chooseInfo(inLanguages("en-US", "es-US", "en-US"))?.sameLanguage).toBe(2);
  });

  it("gives no block for a message with no info block", () => {
    expect(chooseInfo([])).toBeUndefined();
  });

  it("gives the same block for each order of the same list of languages with one match", () => {
    for (const languages of [["en-US", "de-DE"], ["de-DE", "en-US"]]) expect(chooseInfo(INFOS, languages)?.index).toBe(0);
  });
});
