import { fakeWallClock } from "@mark1russell7/algebra/clock";
import type { OptInChange, OptInRecord } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { REPLY_READ_FAILED, replyNotes, replyWatch, type ReplyReading, type ReplyWatchOptions } from "./replies.ts";

// Fake numbers: the country code +999 has no country.
const FIRST = "+99900000002";
const SECOND = "+99900000004";
const STRANGER = "+99900000009";
const MINUTE = 60_000;
const YES = Date.UTC(2026, 10, 17, 21, 30);
const LATER_YES = Date.UTC(2026, 10, 17, 22, 0);
const T0 = Date.UTC(2026, 10, 18, 12);

const RECORDS: readonly OptInRecord[] = [
  { number: FIRST, at: "2026-11-17T21:30:00Z", way: "written", words: "texts-consent/1" },
  { number: SECOND, at: "2026-11-17T22:00:00Z", way: "spoken", words: "texts-consent/1" },
];

const stop = (number: string, at: number): OptInChange => ({ number, kind: "stop", at });
const start = (number: string, at: number): OptInChange => ({ number, kind: "start", at });
const changes = (...list: OptInChange[]): ReplyReading => ({ ok: true, changes: list });

// A reader that gives the next answer of a list, and records the start time of each read.
function scripted(answers: readonly (ReplyReading | Error)[]) {
  const since: number[] = [];
  const read = async (from: number): Promise<ReplyReading> => {
    const answer = answers[Math.min(since.length, answers.length - 1)]!;
    since.push(from);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, since };
}

const watchOf = (read: ReplyWatchOptions["read"], extra: Partial<ReplyWatchOptions> = {}) => replyWatch({ records: RECORDS, read, ...extra });

describe("the watch of the replies", () => {
  it("reads all the replies from the first yes of the list at the first check, then each 5 minutes", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([changes(), changes(stop(FIRST, T0 + MINUTE))]);
    const watch = watchOf(reader.read);
    expect(watch.read()).toBeUndefined();
    expect(watch.nextReadAt()).toBeUndefined();
    await watch.check(clock);
    expect(reader.since).toEqual([YES]);
    expect(watch.read()).toEqual({ at: T0, changes: 0 });
    expect(watch.nextReadAt()).toBe(T0 + 5 * MINUTE);
    await clock.advance(5 * MINUTE - 1);
    await watch.check(clock);
    expect(reader.since).toHaveLength(1);
    await clock.advance(1);
    await watch.check(clock);
    expect(reader.since).toEqual([YES, YES]);
    expect(watch.read()).toEqual({ at: T0 + 5 * MINUTE, changes: 1 });
  });

  it("gives the opt-in of each number from the list and the last read: a STOP removes it, and a START puts it back", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([changes(stop(FIRST, T0 - 10 * MINUTE)), changes(stop(FIRST, T0 - 10 * MINUTE), start(FIRST, T0 + 2 * MINUTE))]);
    const watch = watchOf(reader.read);
    expect(watch.optIn.has(FIRST, T0)).toBe(true);
    await watch.check(clock);
    expect(watch.optIn.has(FIRST, T0)).toBe(false);
    expect(watch.optIn.has(FIRST, T0 - 11 * MINUTE)).toBe(true);
    expect(watch.optIn.has(SECOND, T0)).toBe(true);
    expect(watch.optIn.has(SECOND, LATER_YES - 1)).toBe(false);
    expect(watch.optIn.has(STRANGER, T0)).toBe(false);
    await clock.advance(5 * MINUTE);
    await watch.check(clock);
    expect(watch.optIn.has(FIRST, T0 + 5 * MINUTE)).toBe(true);
  });

  it("does not add a number with a START reply: only a record of the list gives the opt-in", async () => {
    const clock = fakeWallClock(T0);
    const watch = watchOf(scripted([changes(start(STRANGER, T0 - MINUTE))]).read);
    await watch.check(clock);
    expect(watch.optIn.has(STRANGER, T0)).toBe(false);
  });

  it("counts a STOP block of Twilio until the next read that passed, because that read has the reply", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([changes(), changes(), changes(stop(FIRST, T0 + 4 * MINUTE))]);
    const watch = watchOf(reader.read);
    await watch.check(clock);
    watch.optIn.stopped(FIRST, T0 + 4 * MINUTE);
    watch.optIn.stopped(FIRST, T0 + 3 * MINUTE);
    expect(watch.optIn.has(FIRST, T0 + 4 * MINUTE)).toBe(false);
    expect(watch.optIn.has(FIRST, T0 + 3 * MINUTE)).toBe(true);
    // The read at T0 + 5 min has no STOP of the number: the block was in an Advanced Opt-Out, or the log of Twilio lost it.
    // The block goes, and Twilio blocks the next text again.
    await clock.advance(5 * MINUTE);
    await watch.check(clock);
    expect(watch.optIn.has(FIRST, T0 + 5 * MINUTE)).toBe(true);
    watch.optIn.stopped(FIRST, T0 + 6 * MINUTE);
    await clock.advance(5 * MINUTE);
    await watch.check(clock);
    expect(watch.optIn.has(FIRST, T0 + 10 * MINUTE)).toBe(false);
  });

  it("keeps a STOP block that comes during a read, because the read can miss its reply", async () => {
    const clock = fakeWallClock(T0);
    let release: (reading: ReplyReading) => void = () => undefined;
    const watch = watchOf(() => new Promise<ReplyReading>((resolve) => (release = resolve)));
    const running = watch.check(clock);
    await clock.advance(MINUTE);
    watch.optIn.stopped(SECOND, T0 + MINUTE);
    release(changes());
    await running;
    expect(watch.optIn.has(SECOND, T0 + MINUTE)).toBe(false);
  });

  it("keeps the last read after a failure, a throw or a timeout, and reads again after the retry", async () => {
    const clock = fakeWallClock(T0);
    const reader = scripted([changes(stop(FIRST, T0 - MINUTE)), { ok: false, message: "Twilio did not give page 1 of the replies (server)." }, new Error("The network is down."), changes()]);
    const watch = watchOf(reader.read);
    await watch.check(clock);
    const failures: (string | undefined)[] = [];
    for (let step = 1; step <= 3; step += 1) {
      await clock.advance(5 * MINUTE);
      await watch.check(clock);
      failures.push(watch.failure());
      expect(watch.optIn.has(FIRST, clock.now())).toBe(step === 3);
    }
    expect(failures).toEqual(["Twilio did not give page 1 of the replies (server).", "The read of the replies of the texts failed: The network is down.", undefined]);
    expect(watch.read()).toEqual({ at: T0 + 15 * MINUTE, changes: 0 });

    const hanging = watchOf((_since, signal) => new Promise<ReplyReading>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, message: "aborted" }))), { limit: 5_000 });
    const running = hanging.check(clock);
    await clock.advance(5_000);
    await running;
    expect(hanging.failure()).toBe("The read of the replies of the texts took longer than 5000 ms.");
    expect(hanging.nextReadAt()).toBe(clock.now() + 5 * MINUTE);
  });

  it("gives a note for the heartbeat after a failed read, with no number", async () => {
    const clock = fakeWallClock(T0);
    const watch = watchOf(scripted([{ ok: false, message: `The 'To' number [number] is not valid.` }, changes()]).read);
    expect(replyNotes(undefined)).toEqual([]);
    expect(replyNotes(watch)).toEqual([]);
    await watch.check(clock);
    expect(replyNotes(watch)).toEqual([REPLY_READ_FAILED]);
    expect(REPLY_READ_FAILED).not.toMatch(/\d/u);
    await clock.advance(5 * MINUTE);
    await watch.check(clock);
    expect(replyNotes(watch)).toEqual([]);
  });

  it("gives its health with no number and no message: the last read that passed, a failure and the next read", async () => {
    const clock = fakeWallClock(T0);
    const watch = watchOf(scripted([changes(stop(FIRST, T0 - MINUTE)), { ok: false, message: `The number ${FIRST} is not valid.` }]).read);
    expect(watch.health()).toEqual({ what: "replies of the texts", at: null, failed: false, next: null });
    await watch.check(clock);
    expect(watch.health()).toEqual({ what: "replies of the texts", at: T0, failed: false, next: T0 + 5 * MINUTE });
    await clock.advance(5 * MINUTE);
    await watch.check(clock);
    expect(watch.health()).toEqual({ what: "replies of the texts", at: T0, failed: true, next: T0 + 10 * MINUTE });
    expect(JSON.stringify(watch.health())).not.toContain(FIRST.slice(1));
  });

  it("moves the time of the next read and of the last read at a step of the wall clock", async () => {
    const clock = fakeWallClock(T0);
    const watch = watchOf(scripted([changes()]).read);
    await watch.check(clock);
    watch.shift(HOUR_STEP);
    expect(watch.nextReadAt()).toBe(T0 + 5 * MINUTE + HOUR_STEP);
    expect(watch.read()?.at).toBe(T0 + HOUR_STEP);
  });

  it("throws for a list with no record and for times that are not above 0", () => {
    const read = scripted([changes()]).read;
    expect(() => replyWatch({ records: [], read })).toThrow(/no record with a time/u);
    expect(() => replyWatch({ records: [{ ...RECORDS[0]!, at: "2026-02-30T00:00:00Z" }], read })).toThrow(/no record with a time/u);
    expect(() => watchOf(read, { every: 0 })).toThrow(/every/u);
    expect(() => watchOf(read, { retry: Number.NaN })).toThrow(/retry/u);
    expect(() => watchOf(read, { limit: -1 })).toThrow(/limit/u);
  });
});

const HOUR_STEP = 60 * MINUTE;
