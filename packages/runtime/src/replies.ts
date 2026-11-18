/**
 * The watch of the STOP and START replies of the texts (AL-56). The text channel sends only to the numbers of the
 * opt-in list. A STOP reply removes the number, and a START reply puts it back.
 *
 * - The watch reads all the replies from the time of the first record of the list, each 5 minutes. The last read that
 *   passed gives the changes. Thus the watch keeps no record, and after a restart the first check reads again.
 * - Twilio keeps its own STOP block. When Twilio refuses a text to a number that replied STOP, the channel tells the
 *   watch (`stopped`). Such a STOP counts until the next read that passed, because that read has the reply.
 * - Thus a watch whose reads fail gives the old changes and the STOP blocks of Twilio. A START after a failed read
 *   counts at the next read that passed.
 * - The watch holds the numbers only in memory. Its read and its health give counts, and no number.
 */
import { optedIn, optInTime, type Duration, type Instant, type OptInChange, type OptInRecord, type ReadHealth } from "@mark1russell7/alerts";
import type { TextOptIn } from "@mark1russell7/alerts-channel-twilio";
import { readHealth, readSchedule, type ReadWatch } from "./schedule.ts";

const MINUTE = 60_000;

/** The answer of a reader of the replies: the changes of the opt-in, or the reason of the failure. A throw is a failure too. */
export type ReplyReading = { readonly ok: true; readonly changes: readonly OptInChange[] } | { readonly ok: false; readonly message: string };

/** The options of the watch of the replies. */
export interface ReplyWatchOptions {
  /** The opt-in list of the configuration. It has one record or more. */
  readonly records: readonly OptInRecord[];
  /**
   * This function reads the replies from the instant `since` to the time of the read, and gives all their changes.
   * `since` is the time of the first record of the list. The function stops at the abort of the signal.
   */
  readonly read: (since: Instant, signal: AbortSignal) => Promise<ReplyReading>;
  /** The time from a read that passed to the next read. The default is 5 minutes. */
  readonly every?: Duration;
  /** The time from a failed read to the next read. The default is 5 minutes. */
  readonly retry?: Duration;
  /** The time limit of one read, with all its pages. The default is 2 minutes. */
  readonly limit?: Duration;
}

/** The last read of the replies that passed: its end and the count of its changes. */
export interface ReplyRead {
  readonly at: Instant;
  readonly changes: number;
}

/** The watch of the replies of the texts. */
export interface ReplyWatch extends ReadWatch {
  /** The opt-in of the numbers, for the text channel. */
  readonly optIn: TextOptIn;
  /** This method gives the last read that passed, or `undefined` before it. */
  read(): ReplyRead | undefined;
  /** This method gives the message of the failure of the last read, or `undefined` when the last read passed. */
  failure(): string | undefined;
  /** This method gives the health of the watch for the health route. It holds no number and no message. */
  health(): ReadHealth;
}

/** The words of the watch of the replies in the health route. */
export const REPLY_READ_WHAT = "replies of the texts";

/**
 * This function makes the watch of the replies. It throws when the list has no record with a time in UTC: `loadConfig`
 * refuses such a list before.
 */
export function replyWatch(options: ReplyWatchOptions): ReplyWatch {
  const { records } = options;
  const every = options.every ?? 5 * MINUTE;
  const retry = options.retry ?? 5 * MINUTE;
  const limit = options.limit ?? 2 * MINUTE;
  for (const [name, value] of [["every", every], ["retry", retry], ["limit", limit]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`The ${name} of the watch of the replies is not a time above 0.`);
  }
  const times = records.map((record) => optInTime(record)).filter((time) => time !== undefined);
  if (times.length === 0) throw new Error("The opt-in list has no record with a time in UTC. The watch of the replies has no start.");
  const since = Math.min(...times);

  let changes: readonly OptInChange[] = [];
  // The STOP blocks of Twilio since the start of the last read that passed: the last block of each number.
  const blocks = new Map<string, Instant>();
  let last: ReplyRead | undefined;

  const reads = readSchedule<{ readonly ok: true; readonly changes: readonly OptInChange[] }>({
    what: REPLY_READ_WHAT,
    every,
    retry,
    limit,
    read: (signal) => options.read(since, signal),
    use(reading, at, startedAt) {
      if (!reading.ok) return reading.message;
      changes = reading.changes;
      // The read has each reply before its start. Thus a block before the start is in the read, or a START came after it.
      for (const [number, blocked] of blocks) if (blocked < startedAt) blocks.delete(number);
      last = { at, changes: reading.changes.length };
      return undefined;
    },
  });

  const all = (): readonly OptInChange[] => (blocks.size === 0 ? changes : [...changes, ...[...blocks].map(([number, at]): OptInChange => ({ number, kind: "stop", at }))]);

  return {
    optIn: {
      has: (number, at) => optedIn(records, all(), number, at),
      stopped(number, at) {
        const before = blocks.get(number);
        if (before === undefined || at > before) blocks.set(number, at);
      },
    },
    check: (clock, stop) => reads.check(clock, stop),
    nextReadAt: () => reads.nextReadAt(),
    failure: () => reads.failure(),
    read: () => last,
    health: () => readHealth(REPLY_READ_WHAT, reads, last?.at),
    shift(size) {
      reads.shift(size);
      if (last !== undefined) last = { ...last, at: last.at + size };
    },
  };
}

/** The note of a failed read of the replies, in the body of each ping of the heartbeat. It holds no number and no message of Twilio. */
export const REPLY_READ_FAILED = "The last read of the replies of the texts failed. A STOP or START reply counts at the next read that passed.";

/** This function gives the notes of the watch of the replies for the heartbeat: one note after a failed read, or none. */
export function replyNotes(watch: Pick<ReplyWatch, "failure"> | undefined): readonly string[] {
  return watch?.failure() === undefined ? [] : [REPLY_READ_FAILED];
}
