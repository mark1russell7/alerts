import { checkWith, sourceDescriptorSchema } from "@mark1russell7/alerts";
import { kindOf } from "@mark1russell7/quantity";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createEnergyChartsSource, ENERGY_CHARTS_BASE_URL, ENERGY_CHARTS_DESCRIPTOR, ENERGY_CHARTS_MEASURES, ENERGY_CHARTS_ORIGIN, MIN_INTERVAL_MS, SOURCE_ID } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

describe("createEnergyChartsSource", () => {
  it("gives the procedures of the source contract, with the canary check and no locate", () => {
    const source = createEnergyChartsSource({
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "{}" }),
      userAgent: "alerts-tests",
    });
    expect(source.describe()).toEqual(ENERGY_CHARTS_DESCRIPTOR);
    expect(source.locate).toBeUndefined();
    expect(source.check?.({ observations: [] })?.pass).toBe(false);
    const observation = { id: "o" as never, source: SOURCE_ID, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("describes a poll each 2 minutes with no key, no kind and two measures of the grid frequency, and passes the schema of the core", () => {
    expect(checkWith(sourceDescriptorSchema, ENERGY_CHARTS_DESCRIPTOR).tag).toBe("ok");
    expect(ENERGY_CHARTS_DESCRIPTOR).toMatchObject({
      id: SOURCE_ID,
      origins: [ENERGY_CHARTS_ORIGIN],
      dependsOn: ["provider:energy-charts"],
      kinds: [],
      coverage: [],
      transport: "poll",
      interval: 120_000,
      auth: "none",
      uses: ["internet", "dns", "power"],
    });
    expect(ENERGY_CHARTS_DESCRIPTOR.listing).toBeUndefined();
    expect(ENERGY_CHARTS_DESCRIPTOR.canary).toBeTypeOf("string");
    expect(ENERGY_CHARTS_DESCRIPTOR.measures).toEqual(ENERGY_CHARTS_MEASURES);
    expect(ENERGY_CHARTS_MEASURES.map((measure) => [measure.id, measure.dimension, measure.moves, measure.area])).toEqual([
      ["frequency-min", "grid-frequency", "drop", "zone"],
      ["frequency-max", "grid-frequency", "rise", "zone"],
    ]);
    for (const measure of ENERGY_CHARTS_MEASURES) expect(kindOf(measure.unit)).toBe("frequency");
    // The interval keeps the fetches at a quarter of the published limit of 2 requests each minute.
    expect(ENERGY_CHARTS_DESCRIPTOR.interval).toBeGreaterThanOrEqual(2 * MIN_INTERVAL_MS);
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(ENERGY_CHARTS_BASE_URL).host, 60_000);
    let sent = 0;
    const source = createEnergyChartsSource({
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
