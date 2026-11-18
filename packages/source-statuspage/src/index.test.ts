import type { SourceId } from "@mark1russell7/alerts";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createStatusPageSource, descriptorOf, registeredPage, STATUS_PAGES } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };
const GITHUB = registeredPage("statuspage-github")!;

describe("createStatusPageSource", () => {
  it("gives the procedures of the source contract, with no check and no locate", () => {
    const source = createStatusPageSource({
      page: GITHUB,
      pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
      transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "{}" }),
      userAgent: "alerts-tests",
    });
    expect(source.describe()).toEqual(descriptorOf(GITHUB));
    expect(source.locate).toBeUndefined();
    expect(source.check).toBeUndefined();
    const observation = { id: "o" as never, source: GITHUB.id, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("throws for a config with problems", () => {
    const options = { page: { ...GITHUB, id: "Bad Id" as SourceId }, pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: "{}" }), userAgent: "alerts-tests" };
    expect(() => createStatusPageSource(options)).toThrow("the config of the status page Bad Id has problems: the id is not lower-case letters, digits and hyphens");
  });

  it("describes a snapshot poll each 2 minutes, with no key, no canary and the whole Earth as its coverage", () => {
    for (const page of STATUS_PAGES) {
      expect(descriptorOf(page)).toMatchObject({
        id: page.id,
        origins: [page.origin],
        dependsOn: page.dependsOn,
        kinds: [page.kind],
        coverage: "global",
        transport: "poll",
        interval: 120_000,
        slowAfter: 15_000,
        auth: "none",
        uses: ["internet", "dns", "power"],
        listing: "snapshot",
      });
      expect(descriptorOf(page).canary).toBeUndefined();
    }
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(GITHUB.base).host, 60_000);
    let sent = 0;
    const source = createStatusPageSource({
      page: GITHUB,
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
