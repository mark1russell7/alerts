import { knownKind } from "@mark1russell7/alerts";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createSwpcSource, SOURCE_ID, SWPC_BASE_URL, SWPC_DESCRIPTOR, SWPC_KINDS } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

describe("createSwpcSource", () => {
  it("gives the procedures of the source contract, with no check and no locate", () => {
    const source = createSwpcSource({
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "[]" }),
      userAgent: "alerts-tests",
    });
    expect(source.describe()).toEqual(SWPC_DESCRIPTOR);
    expect(source.check).toBeUndefined();
    expect(source.locate).toBeUndefined();
    const observation = { id: "o" as never, source: SOURCE_ID, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("describes a stream poll of the list each minute, with no key and the whole Earth as its coverage", () => {
    expect(SWPC_DESCRIPTOR).toMatchObject({
      id: SOURCE_ID,
      origins: ["nws"],
      dependsOn: ["provider:swpc", "cdn:cloudfront"],
      kinds: SWPC_KINDS,
      coverage: "global",
      transport: "poll",
      interval: 60_000,
      auth: "none",
      uses: ["internet", "power"],
    });
    expect(SWPC_DESCRIPTOR.listing).toBeUndefined();
    expect(SWPC_DESCRIPTOR.maxQuiet).toBeUndefined();
    expect(SWPC_DESCRIPTOR.canary).toBeUndefined();
    for (const kind of SWPC_KINDS) expect(knownKind(kind), kind).toBe(true);
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(SWPC_BASE_URL).host, 60_000);
    let sent = 0;
    const source = createSwpcSource({
      pace: { scheduler, now: parked.now },
      transport: async () => {
        sent += 1;
        return { status: 200, statusText: "OK", headers: {}, body: "[]" };
      },
      userAgent: "alerts-tests",
    });
    const controller = new AbortController();
    const pending = source.fetch({ watch: { places: [] } }, controller.signal);
    controller.abort(new Error("The fetch ended at its limit."));
    await expect(pending).rejects.toThrow("The fetch ended at its limit.");
    expect(sent).toBe(0);
  });
});
