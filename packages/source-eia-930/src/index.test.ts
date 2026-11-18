import { checkWith, DEFAULT_BASELINE, sourceDescriptorSchema } from "@mark1russell7/alerts";
import { kindOf } from "@mark1russell7/quantity";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import {
  BACKFILL_MS,
  createEia930Source,
  DEMAND,
  EIA_930_DESCRIPTOR,
  EIA_930_MEASURES,
  EIA_BASE_URL,
  EIA_ORIGIN,
  FETCH_INTERVAL_MS,
  HOUR_MS,
  MEASURE_DELAY_MS,
  MIN_INTERVAL_MS,
  NEWEST_MAX_AGE_MS,
  SOURCE_ID,
} from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };

describe("createEia930Source", () => {
  it("gives the procedures of the source contract, with the canary check and no locate", () => {
    const source = createEia930Source({
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "{}" }),
      userAgent: "alerts-tests",
      apiKey: "k",
    });
    expect(source.describe()).toEqual(EIA_930_DESCRIPTOR);
    expect(source.locate).toBeUndefined();
    expect(source.check?.({ observations: [] })?.pass).toBe(false);
    const observation = { id: "o" as never, source: SOURCE_ID, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("describes a poll each 15 minutes with a key, no kind and one measure of the demand, and passes the schema of the core", () => {
    expect(checkWith(sourceDescriptorSchema, EIA_930_DESCRIPTOR).tag).toBe("ok");
    expect(EIA_930_DESCRIPTOR).toMatchObject({
      id: SOURCE_ID,
      origins: [EIA_ORIGIN],
      dependsOn: ["provider:eia", "provider:api-data-gov"],
      kinds: [],
      coverage: [],
      transport: "poll",
      interval: FETCH_INTERVAL_MS,
      auth: "key",
      uses: ["internet", "dns", "power"],
      maxQuiet: NEWEST_MAX_AGE_MS,
    });
    expect(EIA_930_DESCRIPTOR.listing).toBeUndefined();
    expect(EIA_930_DESCRIPTOR.canary).toBeTypeOf("string");
    expect(EIA_930_DESCRIPTOR.measures).toEqual(EIA_930_MEASURES);
    expect(EIA_930_MEASURES.map((measure) => [measure.id, measure.dimension, measure.moves, measure.area, measure.baseline, measure.cadence])).toEqual([[DEMAND, "power-demand", "both", "zone", "expected", HOUR_MS]]);
    for (const measure of EIA_930_MEASURES) expect(kindOf(measure.unit)).toBe("energy");
    // The history covers the window of the baseline of the core, and the delay is shorter than the canary limit.
    expect(BACKFILL_MS).toBeGreaterThan(DEFAULT_BASELINE.window);
    expect(MEASURE_DELAY_MS).toBeLessThan(NEWEST_MAX_AGE_MS);
    // A fetch sends at most 10 requests: 5 pages of the past hours and 5 pages of one day of history.
    // At one fetch each 15 minutes, that is 40 requests each hour, far below the published limit of 9,000.
    expect(FETCH_INTERVAL_MS).toBeGreaterThanOrEqual(10 * MIN_INTERVAL_MS);
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(EIA_BASE_URL).host, 60_000);
    let sent = 0;
    const source = createEia930Source({
      pace: { scheduler, now: parked.now },
      transport: async () => {
        sent += 1;
        return { status: 200, statusText: "OK", headers: {}, body: "{}" };
      },
      userAgent: "alerts-tests",
      apiKey: "k",
    });
    const controller = new AbortController();
    const pending = source.fetch({ watch: { places: [] } }, controller.signal);
    controller.abort(new Error("The fetch ended at its limit."));
    await expect(pending).rejects.toThrow("The fetch ended at its limit.");
    expect(sent).toBe(0);
  });
});
