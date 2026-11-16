import { describe, expect, it } from "vitest";
import { KIND_PREFIXES } from "@mark1russell7/alerts-format-nws";
import { HostScheduler } from "polite-crawler/politeness";
import { createNwsSource, NWS_BASE_URL, NWS_DESCRIPTOR, SOURCE_ID } from "./index.ts";

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
    expect(NWS_DESCRIPTOR.uses).toEqual(["internet", "dns", "power"]);
    expect(NWS_DESCRIPTOR.slowAfter).toBeLessThan(NWS_DESCRIPTOR.interval);
  });

  it("covers the kinds of its tables", () => {
    expect(KIND_PREFIXES).toEqual(["cbrne", "env", "fire", "geo", "infra", "met", "safety", "security", "system"]);
    expect(NWS_DESCRIPTOR.kinds).toBe(KIND_PREFIXES);
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(NWS_BASE_URL).host, 60_000);
    let sent = 0;
    const parkedSource = createNwsSource({
      pace: { scheduler, now: parked.now },
      transport: async () => {
        sent += 1;
        return { status: 200, statusText: "OK", headers: {}, body: "" };
      },
      userAgent: "alerts-tests",
    });
    const controller = new AbortController();
    const pending = parkedSource.fetch({ watch: { places: [] } }, controller.signal);
    controller.abort(new Error("The fetch ended at its limit."));
    await expect(pending).rejects.toThrow("The fetch ended at its limit.");
    expect(sent).toBe(0);
  });
});
