import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { ChannelId } from "@mark1russell7/alerts";
import { memoryQuotaStore, quotaGate } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import { balanceWatch, spendQuota, spendUnits, type BalanceReading, type BalanceWatchOptions } from "./balance.ts";

const T0 = Date.UTC(2026, 10, 15, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CALL = "twilio-call" as ChannelId;

function watchOf(read: BalanceWatchOptions["read"], extra: Partial<BalanceWatchOptions> = {}) {
  return balanceWatch({ provider: "provider:twilio", title: "Twilio", channels: [CALL], floor: 5, read, ...extra });
}

// A reader that gives the next answer of a list, and counts its reads.
function scripted(answers: readonly (BalanceReading | Error)[]) {
  let reads = 0;
  const read = async (): Promise<BalanceReading> => {
    const answer = answers[Math.min(reads, answers.length - 1)]!;
    reads += 1;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, reads: () => reads };
}

const ok = (balance: number): BalanceReading => ({ ok: true, balance, currency: "USD" });

describe("the balance watch", () => {
  it("reads at the first check, then once a day, and gives the watch as data of the core", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([ok(12.5), ok(3)]);
    const watch = watchOf(reader.read);
    expect(watch.balance()).toBeUndefined();
    expect(watch.nextReadAt()).toBeUndefined();
    await watch.check(clock);
    expect(watch.balance()).toEqual({ provider: "provider:twilio", title: "Twilio", channels: [CALL], floor: 5, maxAge: 2 * DAY, since: T0, read: { balance: 12.5, currency: "USD", at: T0 } });
    expect(watch.nextReadAt()).toBe(T0 + DAY);
    await clock.advance(DAY - 1);
    await watch.check(clock);
    expect(reader.reads()).toBe(1);
    await clock.advance(1);
    await watch.check(clock);
    expect(reader.reads()).toBe(2);
    expect(watch.balance()?.read).toEqual({ balance: 3, currency: "USD", at: T0 + DAY });
  });

  it("keeps the last read after a failure, a throw, a bad answer or a timeout, and reads again after the retry", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([ok(9), { ok: false, message: "The key is not valid." }, new Error("The network is down."), { ok: true, balance: Number.NaN, currency: "USD" }, { ok: true, balance: 1, currency: "usd" }, ok(8)]);
    const watch = watchOf(reader.read);
    await watch.check(clock);
    const failures: (string | undefined)[] = [];
    for (let day = 1; day <= 5; day += 1) {
      await clock.advance(day === 1 ? DAY : HOUR);
      await watch.check(clock);
      failures.push(watch.failure());
      expect(watch.balance()?.read?.balance).toBe(day === 5 ? 8 : 9);
    }
    expect(failures).toEqual([
      "The key is not valid.",
      "The read of the balance failed: The network is down.",
      "The read of the balance gave no finite balance or no currency code.",
      "The read of the balance gave no finite balance or no currency code.",
      undefined,
    ]);
    expect(reader.reads()).toBe(6);

    const hanging = watchOf((signal) => new Promise<BalanceReading>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, message: "aborted" }))), { limit: 5_000 });
    const running = hanging.check(clock);
    await clock.advance(5_000);
    await running;
    expect(hanging.failure()).toBe("The read of the balance took longer than 5000 ms.");
    expect(hanging.nextReadAt()).toBe(clock.now() + HOUR);
  });

  it("aborts the read at the stop, and keeps no failure of it", async () => {
    const clock = fakeWallClock(T0);
    let seen: AbortSignal | undefined;
    const watch = watchOf((signal) => {
      seen = signal;
      return new Promise<BalanceReading>((resolve) => {
        if (signal.aborted) resolve({ ok: false, message: "aborted" });
        signal.addEventListener("abort", () => resolve({ ok: false, message: "aborted" }));
      });
    });
    const stop = new AbortController();
    const running = watch.check(clock, stop.signal);
    stop.abort(new Error("shutdown"));
    await running;
    expect(seen?.aborted).toBe(true);
    expect(watch.failure()).toBeUndefined();
    expect(watch.nextReadAt()).toBeUndefined();
  });

  it("starts one read for two checks at the same time", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([ok(9)]);
    const watch = watchOf(reader.read);
    await Promise.all([watch.check(clock), watch.check(clock)]);
    expect(reader.reads()).toBe(1);
  });

  it("refuses a watch with no channel, a floor that is not a number or a time that is not valid", () => {
    const read = scripted([ok(1)]).read;
    expect(() => watchOf(read, { channels: [] })).toThrow("has no channel");
    expect(() => watchOf(read, { floor: Number.NaN })).toThrow("not a number");
    for (const extra of [{ every: 0 }, { retry: -1 }, { maxAge: 1.5 }, { limit: Number.POSITIVE_INFINITY }]) expect(() => watchOf(read, extra), JSON.stringify(extra)).toThrow("whole count");
  });
});

describe("the quota of the spend", () => {
  it("counts cents in the calendar month, and keeps the reserve for life-safety", () => {
    const quota = spendQuota({ name: "Twilio spend", monthlyUsd: 20, reserveUsd: 5, timeZone: "America/Chicago" });
    expect(quota).toEqual({ name: "Twilio spend", limit: 2_000, reserve: 500, window: { kind: "calendar", unit: "month", timeZone: "America/Chicago" } });
    // A gate of polite-crawler takes the quota: 1500 cents before the reserve, so 375 calls at 4 cents.
    const gate = quotaGate(quota, { key: "twilio:account", store: memoryQuotaStore(), now: () => T0 });
    for (let call = 0; call < 375; call += 1) gate.take(spendUnits(0.04));
    expect(gate.state()).toMatchObject({ used: 1_500, left: 0 });
    expect(() => gate.take(spendUnits(0.04))).toThrow();
  });

  it("rounds the cost of a send up to whole cents, after a round to a millionth of a dollar", () => {
    expect([0, 0.0075, 0.01, 0.04, 0.07, 0.1, 0.123, 1.5].map(spendUnits)).toEqual([0, 1, 1, 4, 7, 10, 13, 150]);
    for (const cost of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => spendUnits(cost)).toThrow();
  });

  it("refuses a cap of 0 or less, and a reserve that is not below the cap", () => {
    const cap = { name: "Twilio spend", monthlyUsd: 20, timeZone: "UTC" };
    expect(spendQuota(cap).reserve).toBe(0);
    for (const extra of [{ monthlyUsd: 0 }, { monthlyUsd: -5 }, { monthlyUsd: Number.NaN }, { reserveUsd: 20 }, { reserveUsd: -1 }]) {
      expect(() => spendQuota({ ...cap, ...extra }), JSON.stringify(extra)).toThrow();
    }
  });
});
