/**
 * This module holds the time limit of one call, on the clock of the runtime.
 *
 * This module is local until `within` of `@mark1russell7/service` accepts the wall clock of the runtime.
 * `within` of 0.8.16 reads only the timers of its clock, and its type accepts only a monotonic clock.
 * The request went to the owner of `systems` on 2026-11-15. Then the runtime uses `within`.
 */
import type { WallClock } from "@mark1russell7/algebra/clock";
import type { Duration } from "@mark1russell7/alerts";

/**
 * This function gives the value of `work`, or `late()` when the work takes longer than `limit`, or
 * `failed(error)` when the work rejects. It does not reject. The work continues after the limit, and
 * the function ignores its value.
 */
export function limited<T>(work: Promise<T>, limit: Duration, clock: WallClock, late: () => T, failed: (error: unknown) => T): Promise<T> {
  return new Promise((resolve) => {
    const cancel = clock.after(limit, () => resolve(late()));
    work.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        resolve(failed(error));
      },
    );
  });
}
