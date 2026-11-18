import { knownKind } from "@mark1russell7/alerts";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import {
  ANOMALIES_DESCRIPTOR,
  ANOMALIES_SOURCE,
  createRadarAnomaliesSource,
  createRadarOutagesSource,
  OUTAGES_DESCRIPTOR,
  OUTAGES_SOURCE,
  RADAR_KINDS,
  RADAR_ORIGIN,
} from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };
const options = {
  pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
  transport: async () => ({ status: 200, statusText: "OK", headers: {}, body: '{"success":true,"errors":[],"result":{"annotations":[],"trafficAnomalies":[]}}' }),
  userAgent: "alerts-tests",
  token: "test-token",
};

describe("the sources of Cloudflare Radar", () => {
  it("give the procedures of the source contract, with no canary and no locate", async () => {
    for (const [source, descriptor] of [
      [createRadarOutagesSource(options), OUTAGES_DESCRIPTOR],
      [createRadarAnomaliesSource(options), ANOMALIES_DESCRIPTOR],
    ] as const) {
      expect(source.describe()).toEqual(descriptor);
      expect(source.locate).toBeUndefined();
      expect(source.check).toBeUndefined();
      expect(await source.fetch({ watch: { places: [] } })).toMatchObject({ ok: true, observations: [], complete: true });
      const observation = { id: "o" as never, source: descriptor.id, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
      expect(source.map({ observation }).reports).toEqual([]);
    }
  });

  it("describe two snapshot polls each 10 minutes, with a key and the whole Earth as their coverage", () => {
    for (const descriptor of [OUTAGES_DESCRIPTOR, ANOMALIES_DESCRIPTOR]) {
      expect(descriptor).toMatchObject({
        origins: [RADAR_ORIGIN],
        dependsOn: ["provider:cloudflare"],
        coverage: "global",
        transport: "poll",
        interval: 600_000,
        auth: "key",
        uses: ["internet", "dns", "power"],
        listing: "snapshot",
      });
      expect(descriptor.canary).toBeUndefined();
      for (const kind of descriptor.kinds) expect(knownKind(kind), kind).toBe(true);
    }
    expect([OUTAGES_DESCRIPTOR.id, ANOMALIES_DESCRIPTOR.id]).toEqual([OUTAGES_SOURCE, ANOMALIES_SOURCE]);
    expect(OUTAGES_DESCRIPTOR.kinds).toEqual(RADAR_KINDS);
    expect(ANOMALIES_DESCRIPTOR.kinds).toEqual(["infra.internet.outage", "infra.cloud.outage"]);
  });
});
