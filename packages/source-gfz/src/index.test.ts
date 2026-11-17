import { knownKind } from "@mark1russell7/alerts";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createGfzSource, GFZ_BASE_URL, GFZ_DESCRIPTOR, GFZ_KINDS, GFZ_ORIGIN, SOURCE_ID } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

describe("createGfzSource", () => {
  it("gives the procedures of the source contract, with the canary check and no locate", () => {
    const source = createGfzSource({
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "{}" }),
      userAgent: "alerts-tests",
    });
    expect(source.describe()).toEqual(GFZ_DESCRIPTOR);
    expect(source.locate).toBeUndefined();
    expect(source.check?.({ observations: [] }).pass).toBe(false);
    const observation = { id: "o" as never, source: SOURCE_ID, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("describes a snapshot poll each 10 minutes, with no key, a canary and the whole Earth as its coverage", () => {
    expect(GFZ_DESCRIPTOR).toMatchObject({
      id: SOURCE_ID,
      origins: [GFZ_ORIGIN],
      dependsOn: ["provider:gfz"],
      kinds: GFZ_KINDS,
      coverage: "global",
      transport: "poll",
      interval: 600_000,
      auth: "none",
      uses: ["internet", "dns", "power"],
      listing: "snapshot",
    });
    expect(GFZ_DESCRIPTOR.maxQuiet).toBeUndefined();
    expect(GFZ_DESCRIPTOR.canary).toBeTypeOf("string");
    for (const kind of GFZ_KINDS) expect(knownKind(kind), kind).toBe(true);
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(GFZ_BASE_URL).host, 60_000);
    let sent = 0;
    const source = createGfzSource({
      pace: { scheduler, now: parked.now },
      transport: async () => {
        sent += 1;
        return { status: 200, statusText: "OK", headers: {}, body: "{}" };
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
