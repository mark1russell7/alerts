import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { ANSS_ORIGIN, createEmscSource, EARTHQUAKE_KIND, EMSC_DESCRIPTOR, EMSC_ORIGIN, SOURCE_ID } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

describe("createEmscSource", () => {
  it("gives the procedures of the source contract, with no check and no locate", () => {
    const source = createEmscSource({
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "" }),
      userAgent: "alerts-tests",
    });
    expect(source.describe()).toBe(EMSC_DESCRIPTOR);
    expect(source.check).toBeUndefined();
    expect(source.locate).toBeUndefined();
    expect(source.map({ observation: { id: "o" as never, source: SOURCE_ID, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } } }).reports).toEqual([]);
  });

  it("describes a snapshot poll of EMSC each minute, with no key, that depends on EMSC and the USGS", () => {
    expect(EMSC_DESCRIPTOR).toMatchObject({
      id: "emsc",
      origins: [EMSC_ORIGIN, ANSS_ORIGIN],
      dependsOn: ["provider:emsc", "provider:usgs"],
      kinds: [EARTHQUAKE_KIND],
      transport: "poll",
      interval: 60_000,
      auth: "none",
      uses: ["internet", "power"],
      listing: "snapshot",
    });
    expect(EMSC_DESCRIPTOR.coverage).toContainEqual({ type: "code", system: "iso3166", code: "US" });
    expect(EMSC_DESCRIPTOR.maxQuiet).toBeUndefined();
    expect(EMSC_DESCRIPTOR.canary).toBeUndefined();
  });
});
