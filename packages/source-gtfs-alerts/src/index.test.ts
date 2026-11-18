import { describe, expect, it } from "vitest";
import { createGtfsSource, gtfsDescriptor, type GtfsFeed } from "./index.ts";

const FEED: GtfsFeed = { id: "mdb-1967", title: "ZDiTM Szczecin", url: "https://transit.example.test/alerts.pb", origin: "zditm-szczecin", box: { west: 14.4, south: 53.3, east: 14.8, north: 53.6 } };

describe("createGtfsSource", () => {
  it("gives the procedures of one feed: its descriptor, a fetch, a map and a canary check", async () => {
    const source = createGtfsSource({
      feed: FEED,
      pace: { scheduler: { schedule: async () => undefined } as never, now: () => 0 },
      transport: async () => ({ status: 503, statusText: "Unavailable", headers: {}, body: "" }),
      userAgent: "alerts-tests",
    });
    expect(source.describe()).toEqual(gtfsDescriptor(FEED));
    expect(source.check?.({ observations: [] })).toMatchObject({ pass: false });
    expect(typeof source.map).toBe("function");
    expect(source.locate).toBeUndefined();
  });
});
