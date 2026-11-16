/**
 * The retirement of old incidents in the runtime (AL-47). The pass looks for incidents to retire at most once in each
 * interval `every`, and it writes one `retired` event for them. The core gives the rules: `retirements` and the tombstones
 * of the merge state. Thus the cost of a pass follows the recent incidents, not the age of the instance.
 */
import { incidents, retirements, RETENTION_HORIZON, TOMBSTONE_LIFE, type Duration, type Instant, type LinkRule } from "@mark1russell7/alerts";
import { envelope, frameTag, type RetiredEvent } from "./events.ts";
import type { RuntimeState } from "./state.ts";

/** The default interval between two searches for retirements: one hour. */
export const RETIRE_EVERY: Duration = 3_600_000;

/** The options of the retention of the runtime. */
export interface RetentionOptions {
  /** The time after the last change of an incident before it retires. The default is `RETENTION_HORIZON` of the core. */
  readonly horizon?: Duration;
  /** The life of a tombstone. The default is `TOMBSTONE_LIFE` of the core. */
  readonly life?: Duration;
  /** The least time between two searches for retirements. The default is `RETIRE_EVERY`. */
  readonly every?: Duration;
}

/**
 * This function gives the options with each default.
 *
 * @throws Error when the horizon or the life is not a finite number of 0 or more, or when the interval is not above 0.
 */
export function retention(options: RetentionOptions = {}): Required<RetentionOptions> {
  const every = options.every ?? RETIRE_EVERY;
  if (!Number.isFinite(every) || every <= 0) throw new Error(`The interval of the retirements is ${every}, not a finite number above 0.`);
  return { horizon: checked("horizon", options.horizon ?? RETENTION_HORIZON), life: checked("life", options.life ?? TOMBSTONE_LIFE), every };
}

/**
 * This function gives the event that retires each old incident and old orphan key of the state at a time. It gives
 * `undefined` when nothing retires. The incidents come from the merge state of each copy. `link` is the link rule of the
 * delivery step and the view, thus the retirement removes only whole incidents of the delivery step.
 *
 * - An orphan key is a cancelled key with no delivery in the merge. A new read of the log of another copy can bring back an old cancel.
 * - The delivery of an own retired incident does not come back with it. Thus the orphan goes at the horizon after its time of entry.
 * - A key with no time of entry stays. Only a cancel that folds before the first own event has no entry: the state has no time then.
 * - A tombstone keeps each retired orphan key cancelled for the routes. Thus a late delivery of the key gives no repeat.
 */
export function retiredEvent(state: RuntimeState, at: Instant, link: LinkRule, { horizon, life }: Required<RetentionOptions>): RetiredEvent | undefined {
  const found = incidents(state.merge, at, { link });
  const reports = retirements(state.merge, found, at, horizon);
  const gone = new Set(reports);
  // A delivery key does not name its incident, thus the event names the cancelled keys of the deliveries of the incidents.
  const keys = new Set(state.merge.deliveries.filter((delivery) => gone.has(delivery.incident)).map((delivery) => delivery.key));
  const known = new Set(state.merge.deliveries.map((delivery) => delivery.key));
  const cancelled = state.cancelled.filter((key) => keys.has(key) || (!known.has(key) && isOld(state, key, at - horizon)));
  if (reports.length === 0 && cancelled.length === 0) return undefined;
  return { ...envelope("retired", `retired:${at}${frameTag(state.steps.length)}`, at), reports, until: at + life, cancelled };
}

// The cancelled key has a time of entry at or before old.
function isOld(state: RuntimeState, key: string, old: Instant): boolean {
  const since = Object.hasOwn(state.cancelledSince, key) ? state.cancelledSince[key] : undefined;
  return since !== undefined && since <= old;
}

// A time of the options: a finite number of 0 or more.
function checked(name: string, value: Duration): Duration {
  if (!Number.isFinite(value) || value < 0) throw new Error(`The ${name} of the retention is ${value}, not a finite number of 0 or more.`);
  return value;
}
