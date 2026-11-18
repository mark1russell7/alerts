import { knownKind } from "@mark1russell7/alerts";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { BOM_ORIGIN, BOM_SWS_BASE_URL, BOM_SWS_DESCRIPTOR, BOM_SWS_KINDS, createBomSwsSource, SOURCE_ID } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

describe("createBomSwsSource", () => {
  it("gives the procedures of the source contract, with the canary check and no locate", () => {
    const source = createBomSwsSource({
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: '{"data":[]}' }),
      userAgent: "alerts-tests",
      apiKey: "test-key",
    });
    expect(source.describe()).toEqual(BOM_SWS_DESCRIPTOR);
    expect(source.locate).toBeUndefined();
    expect(source.check?.({ observations: [] })?.pass).toBe(false);
    const observation = { id: "o" as never, source: SOURCE_ID, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("describes a snapshot poll each 10 minutes, with a key, a canary and the whole Earth as its coverage", () => {
    expect(BOM_SWS_DESCRIPTOR).toMatchObject({
      id: SOURCE_ID,
      origins: [BOM_ORIGIN],
      dependsOn: ["provider:bom-sws"],
      kinds: BOM_SWS_KINDS,
      coverage: "global",
      transport: "poll",
      interval: 600_000,
      auth: "key",
      uses: ["internet", "dns", "power"],
      listing: "snapshot",
    });
    expect(BOM_SWS_DESCRIPTOR.maxQuiet).toBeUndefined();
    expect(BOM_SWS_DESCRIPTOR.canary).toBeTypeOf("string");
    for (const kind of BOM_SWS_KINDS) expect(knownKind(kind), kind).toBe(true);
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(BOM_SWS_BASE_URL).host, 60_000);
    let sent = 0;
    const source = createBomSwsSource({
      pace: { scheduler, now: parked.now },
      transport: async () => {
        sent += 1;
        return { status: 200, statusText: "OK", headers: {}, body: '{"data":[]}' };
      },
      userAgent: "alerts-tests",
      apiKey: "test-key",
    });
    const controller = new AbortController();
    const pending = source.fetch({ watch: { places: [] } }, controller.signal);
    controller.abort(new Error("The fetch ended at its limit."));
    await expect(pending).rejects.toThrow("The fetch ended at its limit.");
    expect(sent).toBe(0);
  });
});
