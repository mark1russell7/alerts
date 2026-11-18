import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createGcpSource, dashboardDescriptor, FIREBASE_DASHBOARD, FIREBASE_DESCRIPTOR, GCP_BASE, GCP_DESCRIPTOR, GOOGLE_DASHBOARDS, regionId } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };
const reply = async () => ({ status: 200, statusText: "OK", headers: {}, body: "[]" });

describe("createGcpSource", () => {
  it("gives the procedures of the source contract, with no check and no locate", () => {
    const source = createGcpSource({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport: reply, userAgent: "alerts-tests" });
    expect(source.describe()).toBe(GCP_DESCRIPTOR);
    expect(source.locate).toBeUndefined();
    expect(source.check).toBeUndefined();
    const observation = { id: "o" as never, source: GCP_DESCRIPTOR.id, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("describes a snapshot poll each 2 minutes, with no key, no canary and the whole Earth as its coverage", () => {
    expect(GCP_DESCRIPTOR).toEqual({
      id: "gcp-status",
      title: "Google Cloud Service Health: the incidents of the public cloud",
      origins: ["google"],
      dependsOn: ["provider:google-cloud"],
      uses: ["internet", "dns", "power"],
      kinds: ["infra.cloud.outage"],
      coverage: "global",
      transport: "poll",
      interval: 120_000,
      slowAfter: 15_000,
      auth: "none",
      listing: "snapshot",
    });
  });

  it("makes the source of the Firebase dashboard: the descriptor of Google Cloud with its own id and title", () => {
    const source = createGcpSource({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport: reply, userAgent: "alerts-tests", dashboard: FIREBASE_DASHBOARD });
    expect(source.describe()).toBe(FIREBASE_DESCRIPTOR);
    expect(dashboardDescriptor(FIREBASE_DASHBOARD)).toBe(FIREBASE_DESCRIPTOR);
    expect(FIREBASE_DESCRIPTOR).toEqual({ ...GCP_DESCRIPTOR, id: "firebase-status", title: "Firebase Status Dashboard: the incidents of Firebase" });
  });

  it("holds dashboards with unique ids, bases and domains, and keys with unique ids and the domains of other endpoints", () => {
    expect(GOOGLE_DASHBOARDS.map((dashboard) => dashboard.id)).toEqual(["gcp-status", "firebase-status"]);
    for (const field of ["id", "base", "domain"] as const) expect(new Set(GOOGLE_DASHBOARDS.map((dashboard) => dashboard[field])).size, field).toBe(GOOGLE_DASHBOARDS.length);
    for (const dashboard of GOOGLE_DASHBOARDS) {
      expect(dashboard.base, dashboard.id).toMatch(/^https:\/\/[a-z0-9.-]+$/);
      expect(new Set(dashboard.products.map((key) => key.id)).size, dashboard.id).toBe(dashboard.products.length);
      for (const key of dashboard.products) {
        expect(key.domain, key.id).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
        expect(key.domain, key.id).not.toBe(dashboard.domain);
        expect(key.name.trim(), key.id).not.toBe("");
      }
    }
  });

  it("gives the id of a region as the provider, a slash and the id of the location", () => {
    expect(regionId("europe-west1")).toBe("gcp/europe-west1");
    expect(regionId("global")).toBe("gcp/global");
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(GCP_BASE).host, 60_000);
    let sent = 0;
    const source = createGcpSource({
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
