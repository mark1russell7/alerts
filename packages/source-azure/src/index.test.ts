import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { AZURE_BASE, AZURE_DESCRIPTOR, AZURE_REGIONS, categoriesOf, createAzureSource, isNonRegional, isRegion, regionId } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };
const reply = async () => ({ status: 200, statusText: "OK", headers: {}, body: "" });

describe("createAzureSource", () => {
  it("gives the procedures of the source contract, with no check and no locate", () => {
    const source = createAzureSource({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport: reply, userAgent: "alerts-tests" });
    expect(source.describe()).toBe(AZURE_DESCRIPTOR);
    expect(source.locate).toBeUndefined();
    expect(source.check).toBeUndefined();
    const observation = { id: "o" as never, source: AZURE_DESCRIPTOR.id, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("describes a snapshot poll each 5 minutes, with no key, no canary and the whole Earth as its coverage", () => {
    expect(AZURE_DESCRIPTOR).toEqual({
      id: "azure-status",
      title: "Azure Status: the widespread incidents of the public cloud",
      origins: ["microsoft"],
      dependsOn: ["provider:azure", "cdn:akamai"],
      uses: ["internet", "dns", "power"],
      kinds: ["infra.cloud.outage"],
      coverage: "global",
      transport: "poll",
      interval: 300_000,
      slowAfter: 15_000,
      auth: "none",
      listing: "snapshot",
    });
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(AZURE_BASE).host, 60_000);
    let sent = 0;
    const source = createAzureSource({
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

describe("the regions of Azure", () => {
  it("gives the id of a region: the name in lower case with no spaces", () => {
    expect(regionId("West Europe")).toBe("azure/westeurope");
    expect(regionId("South Central US")).toBe("azure/southcentralus");
    expect(regionId("US Gov Virginia")).toBe("azure/usgovvirginia");
    expect(regionId("Australia Central 2")).toBe("azure/australiacentral2");
  });

  it("has each name one time, and a different id for each name", () => {
    const names = Object.values(AZURE_REGIONS).flat();
    expect(names.length).toBe(74);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names.map(regionId)).size).toBe(names.length);
    for (const name of names) expect(name, name).toMatch(/^[A-Z][A-Za-z]*( [A-Za-z0-9]+)*$/);
  });

  it("splits the categories of an item into regions and services, with no category of the services with no region", () => {
    expect(categoriesOf(["Storage Accounts", "Virtual Machines", "South Central US", "Public Non-Regional", "US Gov Non-Regional", "Storage Accounts"])).toEqual({
      regions: ["South Central US"],
      services: ["Storage Accounts", "Virtual Machines"],
    });
    expect(categoriesOf([])).toEqual({ regions: [], services: [] });
    expect(isRegion("West Europe")).toBe(true);
    expect(isRegion("west europe")).toBe(false);
    expect(isNonRegional("Public Non-Regional")).toBe(true);
    expect(isNonRegional("China Non-Regional")).toBe(true);
    expect(isNonRegional("Non-Regional")).toBe(true);
    expect(isNonRegional("Non-Regional Storage")).toBe(false);
  });
});
