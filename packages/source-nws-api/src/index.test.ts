import { describe, expect, it } from "vitest";
import { KIND_PREFIXES } from "@mark1russell7/alerts-format-nws";
import { createNwsSource, NWS_DESCRIPTOR, SOURCE_ID } from "./index.ts";

describe("the NWS API source", () => {
  const source = createNwsSource({
    pace: { scheduler: { run: () => Promise.reject(new Error("no request in this test")), store: { record: () => ({}) as never, stop: () => undefined } }, now: () => 0 },
    transport: () => Promise.reject(new Error("no request in this test")),
    userAgent: "alerts-tests",
  });

  it("gives the four procedures of the contract, and no locate", () => {
    expect(source.describe()).toBe(NWS_DESCRIPTOR);
    expect(typeof source.fetch).toBe("function");
    expect(typeof source.map).toBe("function");
    expect(typeof source.check).toBe("function");
    expect(source.locate).toBeUndefined();
  });

  it("describes itself as the source nws-api", () => {
    expect(NWS_DESCRIPTOR).toMatchObject({ id: SOURCE_ID, origins: ["nws"], transport: "poll", auth: "none" });
    expect(NWS_DESCRIPTOR.dependsOn).toEqual(["provider:nws-api", "cdn:akamai"]);
    expect(NWS_DESCRIPTOR.uses).toEqual(["internet", "power"]);
    expect(NWS_DESCRIPTOR.slowAfter).toBeLessThan(NWS_DESCRIPTOR.interval);
  });

  it("covers the kinds of its tables", () => {
    expect(KIND_PREFIXES).toEqual(["cbrne", "env", "fire", "geo", "infra", "met", "safety", "security", "system"]);
    expect(NWS_DESCRIPTOR.kinds).toBe(KIND_PREFIXES);
  });
});
