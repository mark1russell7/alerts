/**
 * The schedule of the reads of a watch: the balance and the spend of a provider, and the replies of the texts. The runtime
 * starts `check` of each watch in each pass. A watch reads only when it is due.
 */
import type { Duration, Instant } from "@mark1russell7/alerts";
import type { WallClock } from "@mark1russell7/algebra/clock";
import { errorMessage } from "@mark1russell7/text";
import { limited } from "./limit.ts";

/** A failed read of a watch. A reader gives it, and the schedule gives it for a throw or for a read past its limit. */
export interface ReadFailure {
  readonly ok: false;
  readonly message: string;
}

/** The options of the schedule of the reads of a watch. */
export interface ReadScheduleOptions<R> {
  /** The thing that the watch reads, in a message: for example `balance`. */
  readonly what: string;
  readonly every: Duration;
  readonly retry: Duration;
  readonly limit: Duration;
  /** This function reads once, from the time `at`. It stops at the abort of the signal. */
  readonly read: (signal: AbortSignal, at: Instant) => Promise<R | ReadFailure>;
  /**
   * This function uses the reading of a read that started at `startedAt` and ended at `at`. It gives the message of a
   * failure, or `undefined` when it took the reading.
   */
  readonly use: (reading: R | ReadFailure, at: Instant, startedAt: Instant) => string | undefined;
}

/** A watch that reads on a schedule. The runtime starts `check` in each pass, and moves its times at a step of the wall clock. */
export interface ReadWatch {
  /** This method reads when the read is due, and gives no result. It starts one read for two checks at the same time. It does not throw. */
  check(clock: WallClock, stop?: AbortSignal): Promise<void>;
  /** This method gives the time of the next read, or `undefined` before the first check. */
  nextReadAt(): Instant | undefined;
  /** This method moves the times of the watch by a step of the wall clock. */
  shift(size: Duration): void;
}

/** The schedule of the reads of a watch. */
export interface ReadSchedule extends ReadWatch {
  /** This method gives the message of the failure of the last read, or `undefined` when the last read passed. */
  failure(): string | undefined;
}

/**
 * This function makes the schedule of a watch. It reads at the first check. After a read that the watch took, it reads
 * again after `every`. After a failure, it reads again after `retry`. A read longer than `limit` is a failure. A read
 * that the stop ended is not a failure, and the next check reads again.
 */
export function readSchedule<R>(options: ReadScheduleOptions<R>): ReadSchedule {
  const { what, every, retry, limit } = options;
  let next: Instant | undefined;
  let failed: string | undefined;
  let running: Promise<void> | undefined;

  const once = async (clock: WallClock, stop?: AbortSignal): Promise<void> => {
    const own = new AbortController();
    let stopped = false;
    const onStop = (): void => {
      stopped = true;
      own.abort(stop?.reason);
    };
    if (stop?.aborted === true) return;
    stop?.addEventListener("abort", onStop, { once: true });
    const startedAt = clock.now();
    const work = Promise.resolve().then(() => options.read(own.signal, startedAt));
    const late = (): ReadFailure => ({ ok: false, message: `The read of the ${what} took longer than ${limit} ms.` });
    const thrown = (error: unknown): ReadFailure => ({ ok: false, message: `The read of the ${what} failed: ${errorMessage(error)}` });
    const reading = await limited<R | ReadFailure>(work, limit, clock, late, thrown);
    stop?.removeEventListener("abort", onStop);
    own.abort(new Error(`The read of the ${what} ended.`));
    // A read that the stop ended is not a fault of the provider. The next start reads again.
    if (stopped) return;
    const at = clock.now();
    failed = options.use(reading, at, startedAt);
    next = at + (failed === undefined ? every : retry);
  };

  return {
    check(clock, stop) {
      if (running !== undefined) return running;
      if (next !== undefined && clock.now() < next) return Promise.resolve();
      running = once(clock, stop).finally(() => {
        running = undefined;
      });
      return running;
    },
    nextReadAt: () => next,
    failure: () => failed,
    shift(size) {
      if (next !== undefined) next += size;
    },
  };
}
