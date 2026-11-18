import { sourceDescriptorSchema, type SourceId } from "@mark1russell7/alerts";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createCapFeedSource, DEFAULT_INTERVAL, DEFAULT_SLOW_AFTER, descriptorOf, feedProblems, type CapFeed } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

const FEED: CapFeed = {
  id: "cap-feed-de-dwd" as SourceId,
  title: "Deutscher Wetterdienst",
  url: "https://www.dwd.de/DWD/warnungen/cap-feed/en/atom.xml",
  origin: "dwd",
  coverage: ["DE"],
  kinds: ["met"],
  dependsOn: ["provider:dwd"],
};

describe("createCapFeedSource", () => {
  it("gives the procedures of the source contract, with no check and no locate", () => {
    const source = createCapFeedSource({
      feed: FEED,
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "" }),
      userAgent: "alerts-tests",
    });
    expect(source.describe()).toEqual(descriptorOf(FEED));
    expect(source.check).toBeUndefined();
    expect(source.locate).toBeUndefined();
    const observation = { id: "o" as never, source: FEED.id, fetched: 0, contentType: "application/cap+xml", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("describes a stream poll of the index each minute, with no key, from the facts of the config", () => {
    const descriptor = descriptorOf(FEED);
    expect(sourceDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(descriptor).toEqual({
      id: FEED.id,
      title: "Deutscher Wetterdienst: the CAP feed",
      origins: ["dwd"],
      dependsOn: ["provider:dwd"],
      uses: ["internet", "dns", "power"],
      kinds: ["met"],
      coverage: [{ type: "code", system: "iso3166", code: "DE" }],
      transport: "poll",
      interval: DEFAULT_INTERVAL,
      slowAfter: DEFAULT_SLOW_AFTER,
      auth: "none",
    });
    const snapshot = descriptorOf({ ...FEED, listing: "snapshot", interval: 120_000, slowAfter: 20_000 });
    expect(snapshot).toMatchObject({ listing: "snapshot", interval: 120_000, slowAfter: 20_000 });
    expect(sourceDescriptorSchema.parse(snapshot)).toEqual(snapshot);
  });
});

describe("feedProblems", () => {
  it("accepts a good config and names each problem of a bad one", () => {
    expect(feedProblems(FEED)).toEqual([]);
    expect(feedProblems({ ...FEED, messageBases: ["https://alerts.example.org"], perFetch: 4, coverage: ["DE", "US-AK"] })).toEqual([]);
    expect(
      feedProblems({
        ...FEED,
        id: " " as SourceId,
        title: "",
        url: "https://user:secret@www.dwd.de/atom.xml",
        origin: "",
        coverage: ["de"],
        kinds: [],
        messageBases: ["https://alerts.example.org/cap"],
        perFetch: 1.5,
      }),
    ).toEqual([
      "the id is empty",
      "the title is empty",
      "the URL of the index is not an https URL with no user",
      "the origin is empty",
      "the coverage code de is not an ISO 3166 code",
      "the list of kinds is empty",
      "the message base 0 is not the base of an https URL with no user, for example https://alerts.example.org",
      "the count of messages for each fetch is not an integer of 1 or more: 1.5",
    ]);
    expect(feedProblems({ ...FEED, coverage: [] })).toEqual(["the coverage is empty"]);
  });
});
