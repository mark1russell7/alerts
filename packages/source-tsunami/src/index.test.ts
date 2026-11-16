import { knownKind } from "@mark1russell7/alerts";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createTsunamiSource, descriptorOf, TSUNAMI_BASE_URL, TSUNAMI_CENTERS, TSUNAMI_KIND } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };
const CENTERS = [TSUNAMI_CENTERS.ntwc, TSUNAMI_CENTERS.ptwc] as const;

describe("createTsunamiSource", () => {
  it("gives the procedures of the source contract for each center, with no check and no locate", () => {
    for (const center of CENTERS) {
      const source = createTsunamiSource({
        center,
        pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
        transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "" }),
        userAgent: "alerts-tests",
      });
      expect(source.describe()).toEqual(descriptorOf(center));
      expect(source.check).toBeUndefined();
      expect(source.locate).toBeUndefined();
      const observation = { id: "o" as never, source: center.id, fetched: 0, contentType: "text/xml", body: "", transport: { latency: 0 } };
      expect(source.map({ observation }).reports).toEqual([]);
    }
  });

  it("describes a stream poll of the site each minute, with no key, for each center", () => {
    for (const center of CENTERS) {
      const descriptor = descriptorOf(center);
      expect(descriptor).toMatchObject({
        id: center.id,
        origins: ["nws"],
        dependsOn: ["provider:tsunami-gov"],
        kinds: [TSUNAMI_KIND],
        transport: "poll",
        interval: 60_000,
        auth: "none",
        uses: ["internet", "power"],
      });
      expect(descriptor.listing).toBeUndefined();
      expect(descriptor.maxQuiet).toBeUndefined();
      expect(descriptor.canary).toBeUndefined();
      expect(descriptor.coverage).toContainEqual({ type: "code", system: "iso3166", code: "US" });
    }
    expect(knownKind(TSUNAMI_KIND)).toBe(true);
    expect(descriptorOf(TSUNAMI_CENTERS.ntwc).coverage).toContainEqual({ type: "code", system: "iso3166", code: "CA" });
    expect(descriptorOf(TSUNAMI_CENTERS.ptwc).coverage).toContainEqual({ type: "code", system: "iso3166", code: "PR" });
    // Each center has its own source and its own file.
    expect(new Set(CENTERS.map((center) => center.id)).size).toBe(2);
    expect(new Set(CENTERS.map((center) => center.path)).size).toBe(2);
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(TSUNAMI_BASE_URL).host, 60_000);
    let sent = 0;
    const source = createTsunamiSource({
      center: TSUNAMI_CENTERS.ntwc,
      pace: { scheduler, now: parked.now },
      transport: async () => {
        sent += 1;
        return { status: 200, statusText: "OK", headers: {}, body: "" };
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
