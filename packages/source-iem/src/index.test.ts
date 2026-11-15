import { NWS_ORIGIN, VTEC_KIND_PREFIXES } from "@mark1russell7/alerts-format-nws";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createIemSource, IEM_DESCRIPTOR, SOURCE_ID } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

describe("createIemSource", () => {
  it("gives the procedures of the source contract, with no check and no locate", () => {
    const source = createIemSource({
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "" }),
      userAgent: "alerts-tests",
    });
    expect(source.describe()).toBe(IEM_DESCRIPTOR);
    expect(source.check).toBeUndefined();
    expect(source.locate).toBeUndefined();
    expect(source.map({ observation: { id: "o" as never, source: SOURCE_ID, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } } }).reports).toEqual([]);
  });

  it("describes a national poll source of NWS copies, with no key and no dependence on the NWS API", () => {
    expect(IEM_DESCRIPTOR).toMatchObject({
      id: "iem",
      origins: [NWS_ORIGIN],
      dependsOn: ["provider:iem"],
      transport: "poll",
      interval: 120_000,
      auth: "none",
      uses: ["internet", "power"],
    });
    expect(IEM_DESCRIPTOR.kinds).toEqual(VTEC_KIND_PREFIXES);
    expect(IEM_DESCRIPTOR.maxQuiet).toBeUndefined();
    expect(IEM_DESCRIPTOR.canary).toBeUndefined();
  });
});
