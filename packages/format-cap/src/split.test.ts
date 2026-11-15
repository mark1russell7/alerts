import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readCap } from "./read.ts";
import { splitAlerts, splitFeed } from "./split.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const FIRST = fixture("pairs/kewx-ff-w-0108-new.ipaws.xml");
const UPDATE = fixture("pairs/kewx-ff-w-0108-ext.ipaws.xml");

/** The envelope of an answer of the IPAWS feed. An answer with no alert is this envelope with nothing in it. */
const feed = (...alerts: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns1:alerts xmlns:ns1="http://gov.fema.ipaws.services/feed">${alerts.join("")}</ns1:alerts>`;

describe("splitAlerts", () => {
  it("gives no alert for an answer of the IPAWS feed with no alert", () => {
    expect(splitAlerts(feed())).toEqual([]);
  });

  it("gives the text of each alert of a feed as the feed has it", () => {
    expect(splitAlerts(feed(FIRST, UPDATE))).toEqual([FIRST, UPDATE]);
  });

  it("gives alerts that the reader reads with no problem", () => {
    for (const alert of splitAlerts(feed(FIRST, UPDATE))) {
      const read = readCap(alert);
      expect(read.ok && read.problems).toEqual([]);
    }
  });

  it("finds alerts with a prefix, and does not take the envelope alerts for an alert", () => {
    const prefixed = '<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"><cap:identifier>P-1</cap:identifier></cap:alert>';
    expect(splitAlerts(`<feed>${prefixed}<alerts></alerts></feed>`)).toEqual([prefixed]);
  });

  it("skips an alert in a comment and a close tag in a CDATA section", () => {
    const cdata = `<alert><note><![CDATA[a text with </alert> in it]]></note></alert>`;
    expect(splitAlerts(`<feed><!-- <alert>old</alert> -->${cdata}</feed>`)).toEqual([cdata]);
  });

  it("does not end a tag at a > in a quoted value", () => {
    const alert = `<alert data-x="a>b"><identifier>Q-1</identifier></alert>`;
    expect(splitAlerts(`<feed>${alert}</feed>`)).toEqual([alert]);
  });

  it("gives the rest of a cut feed as the last alert, and the reader refuses it", () => {
    const cut = feed(FIRST, UPDATE).slice(0, -2000);
    const alerts = splitAlerts(cut);
    expect(alerts[0]).toBe(FIRST);
    expect(alerts).toHaveLength(2);
    expect(readCap(alerts[1] as string).ok).toBe(false);
  });
});

describe("splitFeed", () => {
  const NAMESPACE = "http://gov.fema.ipaws.services/feed";

  it("reads the root, its namespace and the alerts of a whole feed", () => {
    expect(splitFeed(feed(FIRST, UPDATE))).toEqual({ root: "ns1:alerts", namespace: NAMESPACE, alerts: [FIRST, UPDATE], whole: true });
    expect(splitFeed(feed())).toEqual({ root: "ns1:alerts", namespace: NAMESPACE, alerts: [], whole: true });
  });

  it("takes blanks, comments and processing instructions after the root", () => {
    expect(splitFeed(`${feed()}\r\n <!-- end --> <?done?>\n`).whole).toBe(true);
    expect(splitFeed('<alerts xmlns="urn:x"/>  ')).toEqual({ root: "alerts", namespace: "urn:x", alerts: [], whole: true });
  });

  it("finds no whole feed in a text with no element, or with text after the root", () => {
    expect(splitFeed("")).toEqual({ alerts: [], whole: false });
    expect(splitFeed("no xml")).toEqual({ alerts: [], whole: false });
    expect(splitFeed(`${feed()}<more/>`).whole).toBe(false);
    expect(splitFeed(`${feed()} text`).whole).toBe(false);
    expect(splitFeed(`${feed()}<!-- no end`).whole).toBe(false);
  });

  it("finds each cut of a feed: a cut feed is not whole at any cut point", () => {
    const whole = feed(FIRST, UPDATE);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: whole.length - 1 }), (cut) => !splitFeed(whole.slice(0, cut)).whole),
      { numRuns: 300 },
    );
    // The edges: a cut of the last character, and a cut of the last close tag
    expect(splitFeed(whole.slice(0, -1)).whole).toBe(false);
    expect(splitFeed(whole.slice(0, -"</ns1:alerts>".length)).whole).toBe(false);
  });

  it("does not end the root at a close tag in a comment or a CDATA section", () => {
    const text = `<ns1:alerts xmlns:ns1="${NAMESPACE}"><!-- </ns1:alerts> --><x><![CDATA[</ns1:alerts>]]></x>`;
    expect(splitFeed(text).whole).toBe(false);
    expect(splitFeed(`${text}</ns1:alerts>`).whole).toBe(true);
  });
});
