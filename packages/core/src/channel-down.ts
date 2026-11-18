// The runs of failed calls of the channels and the policy of a down channel (AL-65, `docs/CONTRACTS.md`).

import { compareCodeUnits } from "@mark1russell7/text/order";
import type { ChannelFailureKind, ChannelId, Duration, Instant, NodeKey } from "./contracts.ts";

/**
 * The kinds of a failed call that count in the run of a channel. The other kinds are facts of a person, a message or a
 * quota: `consent`, `quiet`, `expired`, `refused`, `reserved` and `rate-limited`. The quota lines tell of a limit.
 */
export const COUNTED_FAILURES: readonly ChannelFailureKind[] = ["network", "timeout", "server", "auth"];

/**
 * The calls of a channel whose failures count in its run. A failed probe counts too. Thus the probe of a quiet channel
 * finds an outage before the next message.
 */
export const COUNTED_CALLS: readonly string[] = ["send", "status", "probe"];

// The kinds of a failed call that got an answer from the provider. Such a call tells that the network of the copy works.
const ANSWERED: readonly ChannelFailureKind[] = ["server", "auth"];

/** The policy of a down channel: the run of failed calls that opens a line. */
export interface ChannelDownPolicy {
  /** The fewest failed calls in a run that open a line. */
  readonly failures: number;
  /** The shortest time from the first to the last failed call of a run that opens a line. Thus one burst opens no line. */
  readonly span: Duration;
}

/** The policy of a down channel when the configuration gives no value: 3 failed calls in at least 60 s. */
export const DEFAULT_CHANNEL_DOWN: ChannelDownPolicy = { failures: 3, span: 60_000 };

/** The policy of a down channel in the configuration. Each absent field has its value of `DEFAULT_CHANNEL_DOWN`. */
export interface ChannelDownConfig {
  readonly failures?: number;
  readonly span?: Duration;
}

/** This function gives the policy of a down channel from the configuration, with the defaults for the absent fields. */
export function channelDownPolicy(config?: ChannelDownConfig): ChannelDownPolicy {
  return { failures: config?.failures ?? DEFAULT_CHANNEL_DOWN.failures, span: config?.span ?? DEFAULT_CHANNEL_DOWN.span };
}

/** The run of failed calls of one channel of a copy since its last good call. The runtime keeps it in memory. */
export interface ChannelRun {
  readonly channel: ChannelId;
  /** The count of the failed calls of the run. */
  readonly failures: number;
  /** The time of the first failed call. A line of the run has this onset. */
  readonly first: Instant;
  /** The time of the last failed call. */
  readonly last: Instant;
  /** The kind of the last failed call. */
  readonly kind: ChannelFailureKind;
  /**
   * True when the network of the copy worked during the run. Then a call of the run got an answer from the provider. Or a
   * source fetched with success after the first failed call, and a later call failed. A run with no such fact opens no
   * line, because the copy can be offline. The outside check of the copy tells of that.
   */
  readonly reached: boolean;
}

/** One failed call of a channel in a step of the delivery. */
export interface ChannelCallFailure {
  readonly channel: ChannelId;
  /** The call: `send`, `status`, `probe`, `cancel` or another call. Only the calls of `COUNTED_CALLS` count. */
  readonly call: string;
  readonly kind: string;
}

/** The calls of the channels in one step of the delivery of a copy. */
export interface ChannelRunStep {
  /** The time of the step. Each failed call of the step has this time. */
  readonly at: Instant;
  readonly failures: readonly ChannelCallFailure[];
  /** The channels with a good call in the step: an accepted send or a probe success. */
  readonly good: readonly ChannelId[];
  /** The time of the last fetch of a source with success, at the time of the step. */
  readonly lastSuccess?: Instant;
}

/**
 * This function adds one step of the delivery to the runs of the channels. It is pure, and it gives the runs in the order
 * of their channels.
 *
 * - A good call of a channel in the step ends its run. The failed calls of the same step then start no run, because the
 *   provider took a call.
 * - Each failed call of a counted call and a counted kind adds to the run of its channel, or starts a run.
 * - The other failed calls change nothing.
 */
export function channelRuns(runs: readonly ChannelRun[], step: ChannelRunStep): ChannelRun[] {
  const { at, lastSuccess } = step;
  const good = new Set<string>(step.good);
  const next = new Map<string, ChannelRun>(runs.filter((run) => !good.has(run.channel)).map((run) => [run.channel, run]));
  for (const failure of step.failures) {
    if (good.has(failure.channel) || !COUNTED_CALLS.includes(failure.call)) continue;
    const kind = failure.kind as ChannelFailureKind;
    if (!COUNTED_FAILURES.includes(kind)) continue;
    const run = next.get(failure.channel);
    const first = run?.first ?? at;
    const online = ANSWERED.includes(kind) || (run !== undefined && lastSuccess !== undefined && lastSuccess >= run.first && lastSuccess <= at);
    next.set(failure.channel, { channel: failure.channel, failures: (run?.failures ?? 0) + 1, first, last: at, kind, reached: (run?.reached ?? false) || online });
  }
  return [...next.values()].sort((a, b) => compareCodeUnits(a.channel, b.channel));
}

/** This function tells if a run opens a line under a policy. */
export function runOpens(run: ChannelRun, policy: ChannelDownPolicy): boolean {
  return run.reached && run.failures >= policy.failures && run.last - run.first >= policy.span;
}

/** One channel of a copy in a snapshot of the system. */
export interface ChannelSnapshot {
  /** The id of the copy whose calls the run holds. Each copy has its own lines, because each copy has its own network path. */
  readonly copy: string;
  readonly channel: ChannelId;
  /** The title of the channel. The headline names it. */
  readonly title: string;
  /** The endpoints of the channel (`ChannelDescriptor.api`). The report names them, so the layer `delivery` routes it. */
  readonly api?: readonly NodeKey[];
  /** The run of failed calls since the last good call. A restart empties it, and an empty run ends no open line. */
  readonly run?: ChannelRun;
  /** The time of the last good call of the channel in the copy: an accepted send or a probe success. */
  readonly good?: Instant;
}
