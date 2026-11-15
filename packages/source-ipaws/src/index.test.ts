import { KIND_PREFIXES } from "@mark1russell7/alerts-format-nws";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createIpawsSource, IPAWS_DESCRIPTOR, SOURCE_ID } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

describe("createIpawsSource", () => {
  it("gives the procedures of the source contract, with no check and no locate", () => {
    const source = createIpawsSource({
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "" }),
      userAgent: "alerts-tests",
    });
    expect(source.describe()).toBe(IPAWS_DESCRIPTOR);
    expect(source.check).toBeUndefined();
    expect(source.locate).toBeUndefined();
    expect(source.map({ observation: { id: "o" as never, source: SOURCE_ID, fetched: 0, contentType: "application/xml", body: "", transport: { latency: 0 } } }).reports).toEqual([]);
  });

  it("describes a national poll source with two origins and no key", () => {
    expect(IPAWS_DESCRIPTOR).toMatchObject({
      id: "ipaws",
      origins: ["nws", "ipaws-authority"],
      transport: "poll",
      interval: 60_000,
      auth: "none",
      uses: ["internet", "power"],
    });
    expect(IPAWS_DESCRIPTOR.kinds).toEqual(KIND_PREFIXES);
    expect(IPAWS_DESCRIPTOR.dependsOn).not.toContain("provider:nws-api");
    expect(IPAWS_DESCRIPTOR.maxQuiet).toBeUndefined();
    expect(IPAWS_DESCRIPTOR.canary).toBeUndefined();
  });
});
