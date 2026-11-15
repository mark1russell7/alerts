import type { ChannelId } from "@mark1russell7/alerts";
import { PUSHOVER_QUOTA } from "@mark1russell7/alerts-channel-pushover";
import { quotaGate } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import { channelQuota, quotaNote } from "./quota.ts";

const T0 = Date.UTC(2026, 10, 15, 12, 0);
// Midnight in America/Chicago on 1 December.
const RESET = Date.UTC(2026, 11, 1, 6);
const PUSHOVER = "pushover" as ChannelId;
const gateAt = () => quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", now: () => T0 });

describe("the quota of a channel", () => {
  it("gives the state of the gate as data of the core", () => {
    const gate = gateAt();
    gate.note({ remaining: 7_000 });
    expect(channelQuota(PUSHOVER, gate)).toEqual({ channel: PUSHOVER, limit: 10_000, reserve: 1_000, used: 3_000, resetAt: RESET });
    gate.note({ remaining: 0, resetAt: RESET });
    expect(channelQuota(PUSHOVER, gate)).toMatchObject({ used: 10_000, blockedUntil: RESET });
  });
});

describe("the note of a quota", () => {
  it("gives the units used and left before the reserve, the reserve with its end, and the block of the provider", () => {
    const gate = gateAt();
    expect(quotaNote(channelQuota(PUSHOVER, gate))).toBe("pushover: 0 of 10000 units are used, and 9000 are left before the reserve of 1000.");
    gate.note({ remaining: 1_000 });
    expect(quotaNote(channelQuota(PUSHOVER, gate))).toBe(`pushover: 9000 of 10000 units are used. The channel keeps the last 1000 units for life-safety until ${new Date(RESET).toISOString()}.`);
    gate.note({ remaining: 0, resetAt: RESET });
    expect(quotaNote(channelQuota(PUSHOVER, gate))).toBe(`pushover: the provider refuses each message until ${new Date(RESET).toISOString()}.`);
  });

  it("gives the end of a window with each unit used, and no end when the quota has none", () => {
    expect(quotaNote({ channel: PUSHOVER, limit: 100, reserve: 10, used: 100, resetAt: RESET })).toBe(`pushover: all 100 units of the window are used until ${new Date(RESET).toISOString()}.`);
    expect(quotaNote({ channel: PUSHOVER, limit: 100, reserve: 10, used: 95 })).toBe("pushover: 95 of 100 units are used. The channel keeps the last 10 units for life-safety.");
  });
});
