/**
 * This module holds the frame clock of the runtime. A frame starts at a mark. In a frame, the time is the wall time at
 * the mark and the monotonic time since the mark. Thus each instant of a pass is in one frame, also when the wall clock
 * steps during the pass. At the next mark, `step` gives the change of the wall clock against the monotonic clock.
 *
 * TODO(AL-49): the home of the frame clock is `@mark1russell7/algebra/clock` in `mark1russell7/systems`. A pull request
 * of that repository adds it. After its release, the runtime imports it, and this copy goes.
 */
import type { Cancel, Clock, WallClock } from "@mark1russell7/algebra/clock";
import { CLOCK_STEP_ABOVE, type Duration } from "@mark1russell7/alerts";

/** A wall clock in frames. Its `now()` is a whole count of milliseconds, and it does not go back in a frame. */
export interface FrameClock extends WallClock {
  /**
   * This method gives the step of the wall clock since the last mark, in whole milliseconds. The step is the change of
   * the wall time against the monotonic time. A change of `above` or less is a drift, and the method gives 0 for it.
   */
  step(): Duration;
  /** This method starts a new frame. The time of the frame is then the wall time again. */
  mark(): void;
}

/** This function tells if a wall clock is a frame clock: a clock that also gives the steps of the wall clock. */
export function isFrameClock(clock: WallClock): clock is FrameClock {
  const frame = clock as Partial<FrameClock>;
  return typeof frame.step === "function" && typeof frame.mark === "function";
}

/**
 * This function makes a frame clock on a wall clock and a monotonic clock. The first frame starts at once. Its timers
 * are the timers of the wall clock, thus they wait monotonic time.
 *
 * @throws Error when `above` is not a finite number of 0 or more.
 */
export function frameClock(wall: WallClock, monotonic: Clock, above: Duration = CLOCK_STEP_ABOVE): FrameClock {
  if (!(Number.isFinite(above) && above >= 0)) throw new Error(`The drift limit of the frame clock is ${above}, not a finite number of 0 or more.`);
  let wallAt = wall.now();
  let monotonicAt = monotonic.now();
  return {
    time: "wall",
    now: () => wallAt + Math.floor(monotonic.now() - monotonicAt),
    after: (ms: number, run: () => void): Cancel => wall.after(ms, run),
    step() {
      const size = Math.round(wall.now() - monotonic.now() - (wallAt - monotonicAt));
      return Math.abs(size) > above ? size : 0;
    },
    mark() {
      wallAt = wall.now();
      monotonicAt = monotonic.now();
    },
  };
}
