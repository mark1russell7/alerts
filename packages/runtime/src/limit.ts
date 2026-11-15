/**
 * This module holds the time limit of one call, on the clock of the runtime.
 *
 * This module is local until `@mark1russell7/service` has a time limit of a promise that cancels its
 * timer. The request went to the owner of `systems` on 2026-11-15. Then the runtime uses that function.
 */
import type { Clock } from "@mark1russell7/algebra/clock";
import type { Duration } from "@mark1russell7/alerts";

/**
 * This function gives the value of `work`, or `late()` when the work takes longer than `limit`, or
 * `failed(error)` when the work rejects. It does not reject. The work continues after the limit, and
 * the function ignores its value.
 */
export function limited<T>(work: Promise<T>, limit: Duration, clock: Clock, late: () => T, failed: (error: unknown) => T): Promise<T> {
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
