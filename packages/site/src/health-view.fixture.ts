/**
 * Made-up health payloads for the tests and the screenshots of the local page. Each source, channel, provider and copy
 * is made up. The places are the made-up places of the map fixture, and the time is the time of that fixture.
 */

import { HEALTH_FORMAT, type ChannelId, type Coverage, type HealthPayload, type PlaceId, type ReportId, type SourceId } from "@mark1russell7/alerts";

/** The time of the read of each fixture: the time of the map fixture. */
export const HEALTH_AT: number = Date.parse("2026-11-15T21:00:00Z");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const FEED = "weather-feed" as SourceId;
const RELAY = "weather-relay" as SourceId;
const GAUGE = "river-gauge" as SourceId;
const AIR = "air-sensor" as SourceId;
const ROADS = "road-notices" as SourceId;
const QUAKES = "quake-feed" as SourceId;
const COUNTY = "county-page" as SourceId;

const FARM = "place:farm" as PlaceId;
const SHOP = "place:shop" as PlaceId;
const CABIN = "place:cabin" as PlaceId;

const covered = (place: PlaceId, kind: string, required: number, ...sources: SourceId[]): Coverage => ({
  place,
  kind,
  sources,
  independent: sources.length,
  proven: true,
  faults: [],
  commonResources: [],
  required,
});

const passed = (source: SourceId, age: number): HealthPayload["sources"][number] => ({
  source,
  state: "healthy",
  since: HEALTH_AT - 6 * HOUR,
  lastSuccess: HEALTH_AT - age,
  reason: "The last fetch passed.",
});

/** A health with each source healthy, a quota and a balance with no stage, and a copy with no stage. */
export const HEALTHY_FIXTURE: HealthPayload = {
  format: HEALTH_FORMAT,
  at: HEALTH_AT - 20_000,
  now: HEALTH_AT,
  sources: [passed(FEED, 40_000), passed(RELAY, 2 * MINUTE), passed(GAUGE, 4 * MINUTE), passed(ROADS, 9 * MINUTE)],
  lateness: [{ expectation: "relay-carries-warnings", from: FEED, to: RELAY, state: "met", limit: { delay: 5 * MINUTE, misses: 2 }, missed: [] }],
  coverage: [covered(FARM, "met.tornado", 2, FEED, RELAY), covered(FARM, "met.flood.flash", 1, FEED, GAUGE), covered(SHOP, "met.flood.flash", 1, GAUGE), covered(CABIN, "met.wind", 1, FEED, ROADS)],
  copies: [{ copy: "cabin-copy", stages: [], read: { at: HEALTH_AT - MINUTE, skew: 300, sameConfig: true } }],
  quotas: [{ quota: { channel: "text" as ChannelId, limit: 100, reserve: 10, used: 12, resetAt: HEALTH_AT + 3 * HOUR, unit: "messages" }, stages: [] }],
  balances: [
    {
      balance: { provider: "provider:voice-co", title: "Voice Co", channels: ["voice" as ChannelId], floor: 5, maxAge: DAY, since: HEALTH_AT - 30 * DAY, read: { balance: 18.4, currency: "USD", at: HEALTH_AT - HOUR } },
      stages: [],
    },
  ],
};

/**
 * A health with a source in each state. One source is late, one quota is in its reserve, one balance is empty, and
 * the runtime cannot read the other copy. The flash flood at the shop has no source that is up.
 */
export const HEALTH_FIXTURE: HealthPayload = {
  format: HEALTH_FORMAT,
  at: HEALTH_AT - 20_000,
  now: HEALTH_AT,
  sources: [
    passed(FEED, 40_000),
    passed(RELAY, 2 * MINUTE),
    {
      source: GAUGE,
      state: "failing",
      since: HEALTH_AT - 10 * MINUTE,
      lastSuccess: HEALTH_AT - 12 * MINUTE,
      lastFailure: { at: HEALTH_AT - 40_000, kind: "timeout" },
      reason: "The last 3 fetches failed: timeout.",
    },
    { source: AIR, state: "silent", since: HEALTH_AT - HOUR, lastSuccess: HEALTH_AT - 3 * MINUTE, reason: "No fresh observation in 2 h, and the limit is 1 h." },
    { source: ROADS, state: "slow", since: HEALTH_AT - 5 * MINUTE, lastSuccess: HEALTH_AT - MINUTE, reason: "The last fetch took 12 s, and the limit is 8 s." },
    { source: QUAKES, state: "unknown", since: HEALTH_AT - 2 * MINUTE, reason: "No fetch passed yet." },
    {
      source: COUNTY,
      state: "changed",
      since: HEALTH_AT - 3 * DAY,
      lastSuccess: HEALTH_AT - 3 * DAY,
      lastFailure: { at: HEALTH_AT - 9 * MINUTE, kind: "refused" },
      reason: "The canary failed: the page has no table of notices.",
    },
  ],
  lateness: [
    {
      expectation: "relay-carries-warnings",
      from: FEED,
      to: RELAY,
      state: "late",
      limit: { delay: 5 * MINUTE, misses: 2 },
      missed: ["a".padEnd(64, "0") as ReportId, "b".padEnd(64, "0") as ReportId],
      since: HEALTH_AT - 20 * MINUTE,
    },
  ],
  coverage: [covered(FARM, "met.tornado", 2, FEED, RELAY), covered(FARM, "met.flood.flash", 1, FEED), covered(SHOP, "met.flood.flash", 1), covered(CABIN, "met.wind", 1, FEED, ROADS), covered(CABIN, "geo.earthquake", 1)],
  copies: [{ copy: "cabin-copy", stages: ["unread"], read: { at: HEALTH_AT - 3 * HOUR, skew: 300, sameConfig: true } }],
  quotas: [
    { quota: { channel: "text" as ChannelId, limit: 100, reserve: 10, used: 93, resetAt: HEALTH_AT + 3 * HOUR, unit: "messages" }, stages: ["low", "reserve"] },
    { quota: { channel: "push" as ChannelId, limit: 10_000, reserve: 500, used: 1200 }, stages: [] },
  ],
  balances: [
    {
      balance: { provider: "provider:voice-co", title: "Voice Co", channels: ["voice" as ChannelId], floor: 5, maxAge: DAY, since: HEALTH_AT - 30 * DAY, read: { balance: 0, currency: "USD", at: HEALTH_AT - HOUR } },
      stages: ["low", "empty"],
    },
  ],
};

/** A health before the first pass of the runtime: each source has no read, and the runtime watches no quota and no balance. */
export const FIRST_FIXTURE: HealthPayload = {
  format: HEALTH_FORMAT,
  at: null,
  now: HEALTH_AT,
  sources: [FEED, GAUGE].map((source): HealthPayload["sources"][number] => ({ source, state: "unknown", since: HEALTH_AT - 5000, reason: "No fetch passed yet." })),
  lateness: [],
  coverage: [],
  copies: [],
  quotas: [],
  balances: [],
};
