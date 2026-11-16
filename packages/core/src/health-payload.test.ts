import { describe, expect, it } from "vitest";
import type { ChannelId, ChannelQuota, CopyWatch, Coverage, PlaceId, ProviderBalance, ReportId, SourceHealth, SourceId } from "./contracts.ts";
import { HEALTH_FORMAT, healthPayload, sourceHealthView, type HealthPayloadInput } from "./health-payload.ts";
import type { Lateness } from "./lateness.ts";
import { healthPayloadSchema, sourceHealthViewSchema } from "./schemas.ts";
import { balanceStages, copyStages, quotaStages } from "./system-reports.ts";

const START = 1_800_000_000_000;
const NOW = START + 120_000;
const API = "api" as SourceId;
const FEED = "feed" as SourceId;
const CALL = "call" as ChannelId;
const PUSH = "push" as ChannelId;
// A made-up key in the message of a failure. The payload must not hold it.
const KEY = "key-5f1c9a";

const healthy: SourceHealth = { source: API, state: "healthy", since: START, lastSuccess: START + 60_000, reason: "The last fetch passed." };
const failing: SourceHealth = {
  source: FEED,
  state: "failing",
  since: START + 30_000,
  lastSuccess: START,
  lastFailure: { at: START + 90_000, failure: { kind: "server", message: `The fetch of /feed?key=${KEY} gave 503.` } },
  reason: "The last 3 fetches failed: server.",
};
const late: Lateness = { expectation: "feed after api", from: API, to: FEED, state: "late", limit: { delay: 600_000, misses: 1 }, missed: ["r1" as ReportId], since: START + 100_000 };
const covered: Coverage = { place: "place:a" as PlaceId, kind: "met", sources: [API], independent: 1, proven: true, faults: ["provider:a"], commonResources: [], required: 1 };
// One copy read 10 s ago with a clock skew past its limit, and one copy with no read past its maximum age.
const skewed: CopyWatch = { copy: "copy-b", skewLimit: 2_000, maxAge: 60_000, since: START, read: { at: NOW - 10_000, skew: 5_000, sameConfig: true } };
const unread: CopyWatch = { copy: "copy-c", skewLimit: 2_000, maxAge: 60_000, since: START };
const reserve: ChannelQuota = { channel: PUSH, limit: 100, reserve: 10, used: 95, resetAt: START + 86_400_000 };
const low: ProviderBalance = { provider: "provider:call", title: "Calls", channels: [CALL], floor: 5, maxAge: 3_600_000, since: START, read: { balance: 3, currency: "USD", at: START + 1_000 } };

const input: HealthPayloadInput = {
  at: START + 110_000,
  now: NOW,
  sources: [healthy, failing],
  lateness: [late],
  coverage: [covered],
  copies: [skewed, unread],
  quotas: [reserve],
  balances: [low],
};

describe("sourceHealthView", () => {
  it("keeps the time and the kind of the last failure, and not its message", () => {
    expect(sourceHealthView(failing)).toEqual({ ...failing, lastFailure: { at: START + 90_000, kind: "server" } });
    expect(JSON.stringify(sourceHealthView(failing))).not.toContain(KEY);
  });

  it("keeps a health with no failure as it is", () => {
    expect(sourceHealthView(healthy)).toEqual(healthy);
    expect(sourceHealthViewSchema.safeParse(sourceHealthView(healthy)).success).toBe(true);
  });
});

describe("healthPayload", () => {
  const payload = healthPayload(input);

  it("gives the format, the two times and each list in the order of its input", () => {
    expect(payload.format).toBe(HEALTH_FORMAT);
    expect(payload.at).toBe(START + 110_000);
    expect(payload.now).toBe(NOW);
    expect(payload.sources.map((entry) => entry.source)).toEqual([API, FEED]);
    expect(payload.lateness).toEqual([late]);
    expect(payload.coverage).toEqual([covered]);
    expect(payload.copies.map((entry) => entry.copy)).toEqual(["copy-b", "copy-c"]);
  });

  it("gives the stages of the core at the time of the read, thus the page and the system reports agree", () => {
    expect(payload.copies).toEqual([
      { copy: "copy-b", stages: copyStages(skewed, NOW), read: skewed.read },
      { copy: "copy-c", stages: copyStages(unread, NOW) },
    ]);
    expect(payload.copies.map((entry) => entry.stages)).toEqual([["skew"], ["unread"]]);
    expect(payload.quotas).toEqual([{ quota: reserve, stages: quotaStages(reserve) }]);
    expect(payload.quotas[0]?.stages).toEqual(["low", "reserve"]);
    expect(payload.balances).toEqual([{ balance: low, stages: balanceStages(low, NOW) }]);
    expect(payload.balances[0]?.stages).toEqual(["low"]);
  });

  it("passes its schema after a JSON round trip, and holds no message of a failure", () => {
    const text = JSON.stringify(payload);
    expect(text).not.toContain(KEY);
    expect(healthPayloadSchema.safeParse(JSON.parse(text))).toMatchObject({ success: true });
  });

  it("gives a payload before the first pass, with empty lists", () => {
    const empty = healthPayload({ at: null, now: START, sources: [], lateness: [], coverage: [], copies: [], quotas: [], balances: [] });
    expect(empty).toEqual({ format: HEALTH_FORMAT, at: null, now: START, sources: [], lateness: [], coverage: [], copies: [], quotas: [], balances: [] });
    expect(healthPayloadSchema.safeParse(empty).success).toBe(true);
  });

  it("refuses a payload with a message of a failure, of another format or with an unknown field", () => {
    const withMessage = { ...payload, sources: [failing] };
    expect(healthPayloadSchema.safeParse(withMessage).success).toBe(false);
    expect(healthPayloadSchema.safeParse({ ...payload, format: "alerts-health/0" }).success).toBe(false);
    expect(healthPayloadSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
  });
});
