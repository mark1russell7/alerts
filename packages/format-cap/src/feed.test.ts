import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readFeed, type FeedRead } from "./feed.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

/** The real feeds (`fixtures/index/README.md`). */
const NIUE = fixture("index/nu-gov-en.rss.xml");
const DWD = fixture("index/dwd-en.atom.xml");

const rss = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title> The feed </title>${items}</channel></rss>`;
const atom = (entries: string): string => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>${entries}</feed>`;

const entriesOf = (read: FeedRead) => (read.ok ? read.entries : []);

describe("readFeed", () => {
  it("reads each item of an RSS feed: the guid, the title, the link, the time and the text, also in CDATA", () => {
    const read = readFeed(
      rss(`<item><title><![CDATA[Service disruption: Errors]]></title><link>https://example.org/</link><pubDate>Tue, 15 Sep 2026 03:27:10 PDT</pubDate>
        <guid isPermaLink="false">https://example.org/#ec2-eu-west-1_1789468030</guid><description><![CDATA[We are <b>working</b> on it.\n\nNext line.]]></description></item><item><title>Only a title</title></item>`),
    );
    expect(read).toEqual({
      ok: true,
      format: "rss",
      title: "The feed",
      problems: [],
      entries: [
        { id: "https://example.org/#ec2-eu-west-1_1789468030", title: "Service disruption: Errors", link: "https://example.org/", updated: "Tue, 15 Sep 2026 03:27:10 PDT", summary: "We are <b>working</b> on it.\n\nNext line." },
        { title: "Only a title" },
      ],
    });
  });

  it("reads each entry of an Atom feed: the alternate link, the time updated, else published, and the summary, else the content", () => {
    const read = readFeed(
      atom(`<entry><id>urn:a</id><title>A</title><link rel="related" href="https://example.org/r"/><link href="https://example.org/a"/><updated>2026-11-16T19:02:00Z</updated><summary type="text">S</summary></entry>
        <entry><id>urn:b</id><published>2026-11-16T19:03:00Z</published><content>C</content></entry>`),
    );
    expect(entriesOf(read)).toEqual([
      { id: "urn:a", title: "A", link: "https://example.org/a", updated: "2026-11-16T19:02:00Z", summary: "S" },
      { id: "urn:b", updated: "2026-11-16T19:03:00Z", summary: "C" },
    ]);
  });

  it("reads the real feeds of Niue and the DWD", () => {
    const niue = entriesOf(readFeed(NIUE));
    expect(niue).toHaveLength(5);
    expect(niue[0]).toMatchObject({ id: "urn:oid:2.49.0.1.570.0.2026.10.23.0.31.33", title: "STRONG WIND WARNING FOR NIUE LAND AREAS AND COASTAL WATERS", updated: "Fri, 23 Oct 2026 00:31:33 +0000" });
    const dwd = readFeed(DWD);
    expect(dwd).toMatchObject({ ok: true, format: "atom", title: "Official Warnings", problems: [] });
    expect(entriesOf(dwd)).toHaveLength(36);
    for (const entry of entriesOf(dwd)) expect(entry.summary, entry.id).toBeDefined();
  });

  it("gives a lossy problem for an empty item, and a note for a version that is not RSS 2.0", () => {
    const read = readFeed(`<rss version="0.91"><channel><item></item><item><title>T</title></item></channel></rss>`);
    expect(entriesOf(read)).toEqual([{ title: "T" }]);
    expect(read.ok ? read.problems.map((problem) => [problem.path, problem.lossy === true]) : []).toEqual([
      ["rss", false],
      ["item[0]", true],
    ]);
  });

  it("refuses a DOCTYPE and a document that is not a feed, and marks only a text that is not well formed as malformed", () => {
    expect(readFeed(`<!DOCTYPE rss [<!ENTITY e "x">]>${rss("")}`)).toMatchObject({ ok: false, reason: expect.stringContaining("DOCTYPE"), malformed: false });
    expect(readFeed(NIUE.slice(0, NIUE.indexOf("</channel>")))).toMatchObject({ ok: false, reason: expect.stringContaining("not well formed"), malformed: true });
    expect(readFeed("<html><body/></html>")).toEqual({ ok: false, reason: "the root element is html, not rss or an Atom feed", malformed: false });
    expect(readFeed('<rss version="2.0"></rss>')).toEqual({ ok: false, reason: "the rss element has no channel", malformed: false });
  });

  it("does not throw for any text", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(typeof readFeed(text).ok).toBe("boolean");
      }),
    );
  });
});
