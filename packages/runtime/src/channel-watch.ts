// The runs of failed calls of the channels of this copy, and the probes of its down channels (AL-65, `docs/CONTRACTS.md`).

import type { WallClock } from "@mark1russell7/algebra/clock";
import { channelRuns, runOpens, type ChannelDownPolicy, type ChannelId, type ChannelProcedures, type ChannelRun, type ChannelSnapshot, type Duration, type HealthTrack, type Instant, type ProbeOutcome } from "@mark1russell7/alerts";
import { backoffDelay, type Backoff } from "@mark1russell7/service/backoff";
import { errorMessage } from "@mark1russell7/text";
import type { DeliveryStep } from "./delivery.ts";
import { limited } from "./limit.ts";

/** The backoff of the probes of a down channel: the first probe 1 minute after the open line, then 2, 4 and up to 30 minutes. */
export const PROBE_BACKOFF: Backoff = { base: 60_000, factor: 2, cap: 1_800_000 };

/** The options of the watch of the channels. */
export interface ChannelWatchOptions {
  /** The id of this copy. Each copy has its own runs and lines. */
  readonly copy: string;
  readonly channels: readonly ChannelProcedures[];
  /** The policy of the lines. The watch uses it only to wake the next pass when a run opens a line. */
  readonly policy: ChannelDownPolicy;
  readonly clock: WallClock;
  /** The longest time that one probe waits. A probe past it is a `timeout`. */
  readonly callLimit: Duration;
  /** The backoff of the probes. The default is `PROBE_BACKOFF`. */
  readonly backoff?: Backoff;
}

/** The watch of the channels of this copy. It keeps its runs in memory, thus a restart empties them. */
export interface ChannelWatch {
  /** This function gives the channels for the system view: the run and the time of the last good call of each channel. */
  snapshots(): ChannelSnapshot[];
  /**
   * This function calls the probe of each down channel when its time comes. It gives true when a probe passed. A pass is a
   * good call: it ends the run and, in the next view, the line. A failed probe does not count in a run.
   */
  probe(down: readonly ChannelId[], at: Instant): Promise<boolean>;
  /**
   * This function adds the calls of one delivery step to the runs. It gives true when a run starts to open a line, or when
   * a down channel got an accepted send. Then the next view changes a line, and the runtime wakes at once.
   */
  step(delivery: DeliveryStep, at: Instant, down: readonly ChannelId[], lastSuccess?: Instant): boolean;
  /** The time of the next probe. */
  wakeAt(): Instant | undefined;
}

/** This function gives the time of the last passed fetch of any source of this copy. It shows that the network of the copy works. */
export function lastFetchSuccess(health: Readonly<Record<string, HealthTrack>>): Instant | undefined {
  let last: Instant | undefined;
  for (const track of Object.values(health)) if (track.passed !== undefined && (last === undefined || track.passed.at > last)) last = track.passed.at;
  return last;
}

/** This function makes the watch of the channels of this copy. */
export function channelWatch(options: ChannelWatchOptions): ChannelWatch {
  const { clock, policy } = options;
  const backoff = options.backoff ?? PROBE_BACKOFF;
  const entries = options.channels.map((procedures) => ({ procedures, descriptor: procedures.describe() }));
  const probeOf = new Map<ChannelId, () => Promise<ProbeOutcome>>();
  for (const { procedures, descriptor } of entries) {
    const probe = procedures.probe?.bind(procedures);
    if (probe !== undefined) probeOf.set(descriptor.id, probe);
  }
  let runs: ChannelRun[] = [];
  const good = new Map<ChannelId, Instant>();
  // The next probe of each down channel with a probe. The first probe of a line comes one backoff after the first view of it.
  const probes = new Map<ChannelId, { readonly attempt: number; readonly next: Instant }>();

  const noteGood = (channel: ChannelId, at: Instant): void => {
    const last = good.get(channel);
    if (last === undefined || at > last) good.set(channel, at);
  };

  const schedule = (down: readonly ChannelId[], at: Instant): void => {
    const open = new Set<string>(down);
    for (const channel of [...probes.keys()]) if (!open.has(channel)) probes.delete(channel);
    for (const channel of down) if (probeOf.has(channel) && !probes.has(channel)) probes.set(channel, { attempt: 1, next: at + backoffDelay(backoff, 1) });
  };

  const timedOut = (): ProbeOutcome => ({ ok: false, kind: "timeout", message: `The probe did not end in ${options.callLimit} ms.` });
  const threw = (error: unknown): ProbeOutcome => ({ ok: false, kind: "network", message: errorMessage(error) });

  return {
    snapshots: () =>
      entries.map(({ descriptor }) => {
        const run = runs.find((entry) => entry.channel === descriptor.id);
        const last = good.get(descriptor.id);
        return {
          copy: options.copy,
          channel: descriptor.id,
          title: descriptor.title,
          ...(descriptor.api === undefined ? {} : { api: descriptor.api }),
          ...(run === undefined ? {} : { run }),
          ...(last === undefined ? {} : { good: last }),
        };
      }),

    async probe(down, at) {
      schedule(down, at);
      const due = [...probes].filter(([, entry]) => entry.next <= at);
      const outcomes = await Promise.all(
        due.map(async ([channel, entry]) => {
          const probe = probeOf.get(channel);
          const outcome = probe === undefined ? timedOut() : await limited(probe(), options.callLimit, clock, timedOut, threw);
          return { channel, entry, outcome };
        }),
      );
      let passed = false;
      for (const { channel, entry, outcome } of outcomes) {
        if (outcome.ok) {
          noteGood(channel, outcome.at);
          runs = runs.filter((run) => run.channel !== channel);
          probes.delete(channel);
          passed = true;
        } else {
          probes.set(channel, { attempt: entry.attempt + 1, next: clock.now() + backoffDelay(backoff, entry.attempt + 1) });
        }
      }
      return passed;
    },

    step(delivery, at, down, lastSuccess) {
      const accepted = [...new Set(delivery.sent.map((sent) => sent.channel))];
      const opening = new Set(runs.filter((run) => runOpens(run, policy)).map((run) => run.channel));
      const failures = delivery.failures.map((failure) => ({ channel: failure.channel, call: failure.call, kind: failure.kind }));
      runs = channelRuns(runs, { at, failures, good: accepted, ...(lastSuccess === undefined ? {} : { lastSuccess }) });
      for (const sent of delivery.sent) noteGood(sent.channel, sent.at);
      const open = new Set<string>(down);
      const opened = runs.some((run) => runOpens(run, policy) && !opening.has(run.channel) && !open.has(run.channel));
      const ended = accepted.some((channel) => open.has(channel));
      return opened || ended;
    },

    wakeAt: () => {
      let next: Instant | undefined;
      for (const entry of probes.values()) if (next === undefined || entry.next < next) next = entry.next;
      return next;
    },
  };
}
