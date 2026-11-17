import { readFileSync } from "node:fs";
import { observationId, type Observation, type SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import type { CapFeed } from "./feed.ts";
import { mapObservation } from "./map.ts";

const fixture = (name: string): string => readFileSync(new URL(`../../format-cap/fixtures/${name}`, import.meta.url), "utf8");

const FEED: CapFeed = {
  id: "cap-feed-nu" as SourceId,
  title: "Niue Meteorological Service",
  url: "https://cap-sources.s3.amazonaws.com/nu-gov-en/rss.xml",
  origin: "nu-met",
  coverage: ["NU"],
  kinds: ["met"],
  dependsOn: ["provider:wmo-cap-hub"],
};

const observationOf = (body: string, url: string): Observation => ({
  id: observationId({ source: FEED.id, contentType: "application/cap+xml", url, body }),
  source: FEED.id,
  fetched: Date.parse("2026-11-16T18:00:00Z"),
  contentType: "application/cap+xml",
  body,
  transport: { url, status: 200, latency: 0 },
});

describe("mapObservation", () => {
  it("maps a real wind warning of the Niue feed to one report, with the source and the origin of the feed", () => {
    const observation = observationOf(fixture("hub/oet-wind.xml"), "https://cap-sources.s3.amazonaws.com/nu-gov-en/2026-10-23-00-31-33.xml");
    const { reports, problems } = mapObservation(observation, FEED);
    expect(problems.filter((problem) => problem.fatal)).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ source: FEED.id, origin: "nu-met", observation: observation.id, kind: { code: "met.wind" }, op: "update" });
    expect(reports[0]?.areas.length).toBeGreaterThan(0);
  });

  it("maps a real drought update with its reference, and the kind of its OASIS event code", () => {
    const observation = observationOf(fixture("hub/nu-gov-en/2026-10-16-01-37-10.xml"), "https://cap-sources.s3.amazonaws.com/nu-gov-en/2026-10-16-01-37-10.xml");
    const { reports, problems } = mapObservation(observation, FEED);
    expect(problems.filter((problem) => problem.fatal)).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: { code: "met.drought" }, op: "update", severity: "severe" });
    expect(reports[0]?.references).toHaveLength(1);
  });

  it("gives each real message of the feed a report, with no fatal problem", () => {
    for (const name of ["2026-10-15-23-02-27", "2026-10-09-02-38-33", "2026-10-08-23-18-03"]) {
      const { reports, problems } = mapObservation(observationOf(fixture(`hub/nu-gov-en/${name}.xml`), `https://cap-sources.s3.amazonaws.com/nu-gov-en/${name}.xml`), FEED);
      expect(problems.filter((problem) => problem.fatal)).toEqual([]);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.origin).toBe("nu-met");
    }
  });

  it("gives a fatal problem and no report for a body that is not a CAP message", () => {
    const { reports, problems } = mapObservation(observationOf(fixture("index/nu-gov-en.rss.xml"), "https://cap-sources.s3.amazonaws.com/nu-gov-en/rss.xml"), FEED);
    expect(reports).toEqual([]);
    expect(problems).toEqual([{ path: "", message: expect.stringContaining("the body is not a CAP message"), fatal: true }]);
  });
});
