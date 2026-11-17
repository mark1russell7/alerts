import { describe, expect, it } from "vitest";
import type { ChannelDescriptor, ChannelId, PersonId, QuietWindow } from "./contracts.ts";
import { drillDue, drillProblems, drillVerdict, joinRuns, lastRun, nextDrillAt, type DrillConfig, type DrillRun } from "./drill.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const pushover = "pushover" as ChannelId;
const person = "person-1" as PersonId;

// A public time zone of Texas. In November 2026, Chicago is 6 hours behind UTC.
const ZONE = "America/Chicago";
// Saturday 21 November 2026, 11:00 in Chicago.
const SATURDAY = Date.UTC(2026, 10, 21, 17);
// Wednesday 18 November 2026, 06:00 in Chicago.
const WEDNESDAY = Date.UTC(2026, 10, 18, 12);

const WEEKLY: DrillConfig = {
  id: "push-weekly",
  person,
  path: { kind: "channel", channel: pushover },
  every: 6 * DAY,
  window: { zone: ZONE, start: "11:00", end: "17:00", days: [6] },
  ackWithin: 30 * MINUTE,
};

const run = (at: number, extra: Partial<DrillRun> = {}): DrillRun => ({ drill: WEEKLY.id, at, ...extra });

function channel(ack: ChannelDescriptor["ack"]): ChannelDescriptor {
  return { id: pushover, title: "Pushover", dependsOn: [], uses: ["internet", "dns", "power"], breaksThrough: true, repeats: true, ack, maxTitle: 250, maxBody: 1024 };
}

describe("joinRuns and lastRun", () => {
  const variants: DrillRun[] = [run(SATURDAY), run(SATURDAY, { acked: SATURDAY + 5 * MINUTE }), run(SATURDAY, { acked: SATURDAY + 9 * MINUTE }), run(SATURDAY, { acked: SATURDAY - MINUTE })];

  it("is idempotent, commutative and associative over each set of variants", () => {
    for (const a of variants) {
      expect(joinRuns(a, a)).toEqual(a);
      for (const b of variants) {
        expect(joinRuns(a, b)).toEqual(joinRuns(b, a));
        for (const c of variants) expect(joinRuns(joinRuns(a, b), c)).toEqual(joinRuns(a, joinRuns(b, c)));
      }
    }
  });

  it("keeps the earlier acknowledgment", () => {
    expect(joinRuns(variants[1]!, variants[2]!)).toEqual(run(SATURDAY, { acked: SATURDAY + 5 * MINUTE }));
    expect(joinRuns(variants[0]!, variants[2]!)).toEqual(run(SATURDAY, { acked: SATURDAY + 9 * MINUTE }));
  });

  it("gives the run of the latest start of the drill, joined, in any order", () => {
    const runs = [run(SATURDAY - 7 * DAY, { acked: SATURDAY - 7 * DAY + MINUTE }), run(SATURDAY), { drill: "other", at: SATURDAY + DAY }, run(SATURDAY, { acked: SATURDAY + 2 * MINUTE }), run(Number.NaN)];
    expect(lastRun(runs, WEEKLY.id)).toEqual(run(SATURDAY, { acked: SATURDAY + 2 * MINUTE }));
    expect(lastRun([...runs].reverse(), WEEKLY.id)).toEqual(run(SATURDAY, { acked: SATURDAY + 2 * MINUTE }));
    expect(lastRun(runs, "none")).toBeUndefined();
  });
});

describe("drillVerdict", () => {
  it("waits for the acknowledgment until the end of its time, then fails", () => {
    expect(drillVerdict(WEEKLY, run(SATURDAY), SATURDAY + 29 * MINUTE)).toEqual({ state: "pending", until: SATURDAY + 30 * MINUTE });
    expect(drillVerdict(WEEKLY, run(SATURDAY), SATURDAY + 30 * MINUTE)).toEqual({ state: "failed", why: "no-ack" });
  });

  it("passes with an acknowledgment in its time, and fails with a late one", () => {
    expect(drillVerdict(WEEKLY, run(SATURDAY, { acked: SATURDAY + 30 * MINUTE }), SATURDAY + HOUR)).toEqual({ state: "passed", after: 30 * MINUTE });
    expect(drillVerdict(WEEKLY, run(SATURDAY, { acked: SATURDAY - MINUTE }), SATURDAY)).toEqual({ state: "passed", after: 0 });
    expect(drillVerdict(WEEKLY, run(SATURDAY, { acked: SATURDAY + 31 * MINUTE }), SATURDAY + HOUR)).toEqual({ state: "failed", why: "late-ack" });
  });
});

describe("nextDrillAt and drillDue", () => {
  it("starts at the next opening of the window, and at once in the window", () => {
    expect(nextDrillAt(WEEKLY, [], WEDNESDAY)).toBe(SATURDAY);
    expect(nextDrillAt(WEEKLY, [], SATURDAY + HOUR)).toBe(SATURDAY + HOUR);
    expect(drillDue(WEEKLY, [], SATURDAY + HOUR)).toBe(true);
    expect(drillDue(WEEKLY, [], WEDNESDAY)).toBe(false);
  });

  it("waits the least time after the last start, also after a run with no acknowledgment", () => {
    const last = [run(SATURDAY + 5 * MINUTE)];
    expect(nextDrillAt(WEEKLY, last, SATURDAY + HOUR)).toBe(SATURDAY + 7 * DAY);
    expect(drillDue(WEEKLY, last, SATURDAY + HOUR)).toBe(false);
    // Six days after the start is a Friday, so the drill waits for the window of the next Saturday.
    expect(nextDrillAt(WEEKLY, [run(SATURDAY + 5 * MINUTE)], SATURDAY + 6 * DAY + 10 * MINUTE)).toBe(SATURDAY + 7 * DAY);
    // A least time that ends in the window starts the drill at that time.
    const daily: DrillConfig = { ...WEEKLY, every: DAY, window: { zone: ZONE, start: "11:00", end: "17:00" } };
    expect(nextDrillAt(daily, [run(SATURDAY + 2 * HOUR)], SATURDAY + 3 * HOUR)).toBe(SATURDAY + DAY + 2 * HOUR);
  });

  it("follows the clock of the zone when daylight saving time starts", () => {
    // Daylight saving time starts in Chicago at 02:00 on Sunday 8 March 2026. Then 09:00 is 14:00 UTC, not 15:00.
    const sunday: DrillConfig = { ...WEEKLY, window: { zone: ZONE, start: "09:00", end: "10:00", days: [0] } };
    expect(nextDrillAt(sunday, [], Date.UTC(2026, 2, 7, 18))).toBe(Date.UTC(2026, 2, 8, 14));
  });

  it("does not start in the quiet window of the person", () => {
    const morning: DrillConfig = { ...WEEKLY, every: DAY, window: { zone: ZONE, start: "06:00", end: "12:00" } };
    const quiet: QuietWindow = { zone: ZONE, start: "22:00", end: "08:00" };
    // 06:00 on Wednesday is in the quiet window, so the drill starts at 08:00.
    expect(nextDrillAt(morning, [], WEDNESDAY, quiet)).toBe(WEDNESDAY + 2 * HOUR);
    expect(drillDue(morning, [], WEDNESDAY, quiet)).toBe(false);
    // The quiet window ends at 13:00, before the end of the window of the drill at 14:00, so the drill starts at 13:00.
    const late: QuietWindow = { zone: ZONE, start: "22:00", end: "13:00" };
    expect(nextDrillAt({ ...morning, window: { zone: ZONE, start: "06:00", end: "14:00" } }, [], WEDNESDAY, late)).toBe(WEDNESDAY + 7 * HOUR);
  });

  it("gives no start for a window in the quiet window, a quiet full day or a bad window", () => {
    const quiet: QuietWindow = { zone: ZONE, start: "22:00", end: "08:00" };
    expect(nextDrillAt({ ...WEEKLY, window: { zone: ZONE, start: "23:00", end: "05:00" } }, [], WEDNESDAY, quiet)).toBeUndefined();
    expect(nextDrillAt(WEEKLY, [], WEDNESDAY, { zone: ZONE, start: "00:00", end: "00:00" })).toBeUndefined();
    expect(nextDrillAt({ ...WEEKLY, window: { zone: "Mars/Olympus", start: "11:00", end: "17:00" } }, [], WEDNESDAY)).toBeUndefined();
    expect(nextDrillAt({ ...WEEKLY, window: { zone: ZONE, start: "25:00", end: "17:00" } }, [], WEDNESDAY)).toBeUndefined();
    expect(nextDrillAt(WEEKLY, [], Number.NaN)).toBeUndefined();
    expect(drillDue(WEEKLY, [], Number.NaN)).toBe(false);
  });
});

describe("drillProblems", () => {
  it("finds no problem in a good drill", () => {
    expect(drillProblems(WEEKLY, [channel("poll")])).toEqual([]);
  });

  it("finds bad times, a bad window, an unknown channel and a channel with no acknowledgment", () => {
    expect(drillProblems({ ...WEEKLY, ackWithin: 0, every: Number.NaN, window: { zone: "Mars/Olympus", start: "11:00", end: "17:00" } }, [])).toEqual([
      "The drill push-weekly has the time of the acknowledgment 0. It is a finite number above 0.",
      "The drill push-weekly has the least time between two starts NaN. It is above the time of the acknowledgment.",
      expect.stringMatching(/^The drill push-weekly: the window: /u),
      "The drill push-weekly uses the channel pushover, and the instance has no such channel.",
    ]);
    expect(drillProblems({ ...WEEKLY, every: 30 * MINUTE }, [channel("none")])).toEqual([
      "The drill push-weekly has the least time between two starts 1800000. It is above the time of the acknowledgment.",
      "The drill push-weekly uses the channel pushover, and the channel does not tell of an acknowledgment. The drill cannot pass.",
    ]);
  });
});
