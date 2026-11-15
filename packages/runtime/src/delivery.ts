/**
 * This module holds the delivery step of a pass. The step polls each open receipt for an
 * acknowledgment, and it writes the start of each new escalation. Then it sends each step that is due,
 * and it cancels the repeats of each escalation that is over. The core decides each of these. The step does the
 * calls of the channels, and it writes each result to the log after the call.
 */
import type { Clock } from "@mark1russell7/algebra/clock";
import {
  acknowledgmentOf,
  incidents,
  messageKey,
  messageOf,
  route,
  type Acknowledgment,
  type AssessPolicy,
  type ChannelDescriptor,
  type ChannelId,
  type ChannelProcedures,
  type Delivery,
  type DeliveryStatus,
  type Duration,
  type Instant,
  type Recipient,
  type Route,
  type SendOutcome,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { envelope, type RuntimeEvent } from "./events.ts";
import { limited } from "./limit.ts";
import type { RuntimeState } from "./state.ts";
import { earliest } from "./view.ts";

/** The options of the delivery. The private configuration gives the recipients and the addresses. */
export interface DeliveryOptions {
  readonly recipients: readonly Recipient[];
  /** The procedures of each channel. A step of a channel that is not here fails, and the escalation goes on. */
  readonly channels: readonly ChannelProcedures[];
  /** The policy of the assessment. The default is the policy of the core. */
  readonly assess?: AssessPolicy;
  /** The time between two polls of one receipt. */
  readonly pollEvery: Duration;
  /** The wait before a failed call goes again, when the channel tells no wait. */
  readonly retry: Duration;
  /** The longest time of one call of a channel. */
  readonly callLimit: Duration;
  /** The rank of this copy of the system, and the wait of each rank. */
  readonly rank?: number;
  readonly rankDelay?: Duration;
}

/** A call of a channel that failed. The decision stays, thus the call goes again at `retryAt` or later. */
export interface DeliveryFailure {
  readonly call: "send" | "status" | "cancel";
  /** The delivery key of the call. */
  readonly key: string;
  readonly channel: ChannelId;
  readonly kind: string;
  readonly message: string;
  readonly retryAt: Instant;
}

/** The result of one delivery step. */
export interface DeliveryStep {
  /** The escalations after the polls of the step. */
  readonly routes: readonly Route[];
  readonly sent: readonly Delivery[];
  readonly acknowledged: readonly Acknowledgment[];
  /** The delivery keys that the step cancelled. */
  readonly cancelled: readonly string[];
  readonly failures: readonly DeliveryFailure[];
  /** The ids of the events that are different from the events of the log with the same ids. */
  readonly conflicts: readonly string[];
  /** The next time of a step of an escalation, of a poll or of a call that goes again. */
  readonly wakeAt?: Instant;
}

/** What the delivery reads and writes in the runtime. */
export interface DeliveryContext {
  readonly clock: Clock;
  readonly places: readonly WatchedPlace[];
  state(): RuntimeState;
  /**
   * This function writes events to the log and folds them. It gives the ids of the events that are
   * different from the events of the log with the same ids. It throws when the write fails.
   */
  append(events: readonly RuntimeEvent[]): readonly string[];
}

/** The dispatcher of the deliveries: one step for each pass. */
export interface Dispatcher {
  step(at: Instant): Promise<DeliveryStep>;
}

/**
 * This function makes the dispatcher. Each call of a channel goes through a time limit. A failed call
 * changes nothing in the log, thus the next step decides it again. The times of the polls and of the
 * waits are in memory only. After a restart, each receipt gets a poll at once.
 */
export function createDispatcher(options: DeliveryOptions, context: DeliveryContext): Dispatcher {
  const { clock } = context;
  const byId = new Map<string, ChannelProcedures>();
  const descriptors: ChannelDescriptor[] = [];
  for (const channel of options.channels) {
    const descriptor = channel.describe();
    if (byId.has(descriptor.id)) throw new Error(`Two channels have the id ${descriptor.id}.`);
    byId.set(descriptor.id, channel);
    descriptors.push(descriptor);
  }
  const polling = new Set(descriptors.filter((descriptor) => descriptor.ack === "poll").map((descriptor) => descriptor.id as string));
  const recipients = new Map(options.recipients.map((recipient) => [recipient.watch.person as string, recipient]));
  const polled = new Map<string, Instant>();
  const waits = new Map<string, Instant>();
  const later = (call: string, key: string): string => `${call} ${key}`;

  return {
    async step(at) {
      // A wait that is over keeps nothing. Thus the map holds only the waits of the last retry time.
      for (const [call, until] of waits) if (until <= at) waits.delete(call);
      const found = incidents(context.state().merge, at);
      const routesNow = (): Route[] => {
        const state = context.state();
        return route({
          state: state.merge,
          incidents: found,
          recipients: options.recipients,
          places: context.places,
          assess: options.assess,
          starts: state.starts,
          cancelled: new Set(state.cancelled),
          channels: descriptors,
          rank: options.rank,
          rankDelay: options.rankDelay,
          now: at,
        });
      };
      const failures: DeliveryFailure[] = [];
      const conflicts: string[] = [];
      const write = (events: readonly RuntimeEvent[]): void => {
        if (events.length > 0) conflicts.push(...context.append(events));
      };
      const fail = (call: DeliveryFailure["call"], delivery: { readonly key: string; readonly channel: ChannelId }, kind: string, message: string, after?: Duration): void => {
        const retryAt = at + Math.max(options.retry, after ?? 0);
        waits.set(later(call, delivery.key), retryAt);
        failures.push({ call, key: delivery.key, channel: delivery.channel, kind, message, retryAt });
      };
      // The end of each wait that keeps a call from this step. The next pass comes at the earliest one.
      const waiting: Instant[] = [];
      const ready = (call: string, key: string): boolean => {
        const until = waits.get(later(call, key));
        if (until === undefined) return true;
        if (until <= at) {
          waits.delete(later(call, key));
          return true;
        }
        waiting.push(until);
        return false;
      };

      // 1. The polls. An acknowledgment changes the escalations, thus the routes come again after it.
      const first = routesNow();
      const due = first.flatMap((entry) => entry.polls).filter((delivery) => (polled.get(delivery.key) ?? Number.NEGATIVE_INFINITY) + options.pollEvery <= at && ready("status", delivery.key));
      const statuses = await Promise.all(due.map((delivery) => poll(delivery)));
      const acks = statuses.flatMap((status, index) => {
        const delivery = due[index]!;
        polled.set(delivery.key, at);
        if (!status.ok) {
          fail("status", delivery, status.kind, status.message);
          return [];
        }
        const acknowledgment = acknowledgmentOf(delivery, status.status);
        return acknowledgment === undefined ? [] : [{ ...envelope("acknowledgment", `ack:${delivery.key}`, at), acknowledgment }];
      });
      write(acks);
      const acknowledged = acks.map((event) => event.acknowledgment);
      const routes = acknowledged.length === 0 ? first : routesNow();

      // 2. The start of each new escalation, before its first send.
      write(routes.filter((entry) => entry.fresh).map((entry) => ({ ...envelope("escalation", startId(entry), at), start: entry.start })));

      // 3. The sends and the cancels. Each result goes to the log at once, thus a crash loses the fewest results.
      const sent: Delivery[] = [];
      const cancelled: string[] = [];
      const work: Promise<void>[] = [];
      for (const entry of routes) {
        for (const send of entry.plan.sends) {
          const key = messageKey(send);
          if (!ready("send", key)) continue;
          work.push(
            (async () => {
              const target = { key, channel: send.channel };
              const channel = byId.get(send.channel);
              const address = recipients.get(send.person)?.addresses[send.channel];
              if (channel === undefined || address === undefined) {
                fail("send", target, "refused", channel === undefined ? `The system has no channel ${send.channel}.` : `The person has no address on the channel ${send.channel}.`);
                return;
              }
              const message = messageOf(entry.incident, context.state().merge.reports, send);
              const outcome = await limited<SendOutcome>(
                Promise.resolve().then(() => channel.send({ message, address })),
                options.callLimit,
                clock,
                () => ({ ok: false, kind: "timeout", message: `The send took longer than ${options.callLimit} ms.` }),
                (error) => ({ ok: false, kind: "network", message: `The send threw: ${errorMessage(error)}` }),
              );
              if (!outcome.ok) {
                fail("send", target, outcome.kind, outcome.message, outcome.retryAfter);
                return;
              }
              const delivery: Delivery = { key: message.key, incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: outcome.accepted, receipt: outcome.receipt };
              write([{ ...envelope("delivery", `delivery:${delivery.key}`, clock.now()), delivery }]);
              // A new delivery gets its first poll after one interval.
              polled.set(delivery.key, at);
              sent.push(delivery);
            })(),
          );
        }
        for (const delivery of entry.plan.cancels) {
          if (!ready("cancel", delivery.key)) continue;
          work.push(
            (async () => {
              const channel = byId.get(delivery.channel);
              if (delivery.receipt !== undefined) {
                if (channel === undefined) {
                  fail("cancel", delivery, "refused", `The system has no channel ${delivery.channel}.`);
                  return;
                }
                const receipt = delivery.receipt;
                const error = await limited<unknown>(
                  Promise.resolve().then(() => channel.cancel({ receipt })).then(() => undefined),
                  options.callLimit,
                  clock,
                  () => new Error(`The cancel took longer than ${options.callLimit} ms.`),
                  (thrown) => thrown ?? new Error("The cancel failed."),
                );
                if (error !== undefined) {
                  fail("cancel", delivery, "network", errorMessage(error));
                  return;
                }
              }
              write([{ ...envelope("cancelled", `cancelled:${delivery.key}`, clock.now()), delivery: delivery.key }]);
              cancelled.push(delivery.key);
            })(),
          );
        }
      }
      // Each call ends before the step ends. A write that failed throws after all of them.
      const settled = await Promise.allSettled(work);
      const broken = settled.find((result) => result.status === "rejected");
      if (broken !== undefined) throw broken.reason;

      const after = routesNow();
      const open = after.flatMap((entry) => entry.polls);
      // Only an open receipt needs the time of its last poll. Each other entry goes, thus the map grows with the open receipts only.
      const keep = new Set(open.map((delivery) => delivery.key));
      for (const key of polled.keys()) if (!keep.has(key)) polled.delete(key);
      const polls = open.map((delivery) => (polled.get(delivery.key) ?? at) + options.pollEvery);
      const wakeAt = earliest([...after.map((entry) => entry.plan.wakeAt), ...polls, ...failures.map((failure) => failure.retryAt), ...waiting]);
      return { routes: after, sent, acknowledged, cancelled, failures, conflicts, ...(wakeAt === undefined ? {} : { wakeAt }) };
    },
  };

  async function poll(delivery: Delivery): Promise<{ readonly ok: true; readonly status: DeliveryStatus } | { readonly ok: false; readonly kind: string; readonly message: string }> {
    const channel = byId.get(delivery.channel);
    const receipt = delivery.receipt;
    if (channel === undefined || receipt === undefined || !polling.has(delivery.channel)) return { ok: false, kind: "refused", message: `The channel ${delivery.channel} gives no status here.` };
    return limited(
      Promise.resolve()
        .then(() => channel.status({ receipt }))
        .then((status) => ({ ok: true as const, status })),
      options.callLimit,
      clock,
      () => ({ ok: false as const, kind: "timeout", message: `The status took longer than ${options.callLimit} ms.` }),
      (error) => ({ ok: false as const, kind: "network", message: `The status threw: ${errorMessage(error)}` }),
    );
  }
}

// The id of the event of a start: one start for each anchor, level and person.
function startId(entry: Route): string {
  return `escalation:${entry.start.incident}:${entry.start.level}:${entry.start.person}`;
}
