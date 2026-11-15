/**
 * This module holds the delivery step of a pass. The step polls each open receipt for an
 * acknowledgment, and it writes the start of each new escalation. Then it sends each step that is due,
 * and it cancels the repeats of each escalation that is over. The core decides each of these. The step does the
 * calls of the channels, and it writes each result to the log after the call.
 */
import type { WallClock } from "@mark1russell7/algebra/clock";
import {
  COPY_ID,
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
import { envelope, type ChannelFailureKind, type RefusalKind, type RuntimeEvent } from "./events.ts";
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
  /** The longest time that a step waits for one call of a channel. */
  readonly callLimit: Duration;
  /**
   * The longest time that a send stays in flight. A send that passes `callLimit` goes on, and no second
   * send of its key starts until it ends or this time ends. A late send that the channel accepts gets
   * its delivery in the log. After this time, the step stops the copy of the send by its copy id, and a
   * new copy goes. It is not shorter than `callLimit`.
   */
  readonly flightLimit: Duration;
  /** The rank of this copy of the system, and the wait of each rank. */
  readonly rank?: number;
  readonly rankDelay?: Duration;
}

/** A call of a channel that failed. The decision stays, thus the call goes again at `retryAt` or later. */
export interface DeliveryFailure {
  /** The call. `copy` is the stop of one copy by its copy id. */
  readonly call: "send" | "status" | "cancel" | "copy";
  /** The delivery key of the call. */
  readonly key: string;
  /** The copy id of a `copy` call. */
  readonly copy?: string;
  readonly channel: ChannelId;
  readonly kind: string;
  readonly message: string;
  readonly retryAt: Instant;
}

/** The result of one delivery step. */
export interface DeliveryStep {
  /** The escalations after the polls of the step. */
  readonly routes: readonly Route[];
  /** The deliveries that the step wrote: the sends of the step, and the late sends of earlier steps. */
  readonly sent: readonly Delivery[];
  /**
   * The keys of the sends that the channel accepted when the log already had a delivery of the key.
   * A late send on a channel that does not repeat can cause this, after a second send. Another copy
   * of the system can also cause it. The log keeps the first delivery. The cancel by tag of the
   * channel stops the repeats of each copy.
   */
  readonly duplicates: readonly string[];
  /**
   * The copy ids that the step stopped. Each is a copy that the channel can repeat and that no poll reads:
   *
   * - a copy past its flight limit, or a copy whose send failed with no answer
   * - a copy of a key that the log already has
   * - a copy of an earlier run with no end in the log
   */
  readonly stopped: readonly string[];
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
  readonly clock: WallClock;
  /** The id of the run. Its characters match `COPY_ID`. Each copy id starts with it, thus two runs do not give the same copy id. */
  readonly run: string;
  readonly places: readonly WatchedPlace[];
  state(): RuntimeState;
  /**
   * This function writes events to the log and folds them. It gives the ids of the events that are
   * different from the events of the log with the same ids. It throws when the write fails.
   */
  append(events: readonly RuntimeEvent[]): readonly string[];
  /** The step starts this function when a late send ends with a delivery. The next pass then writes it soon. */
  readonly wake?: (() => void) | undefined;
}

/** The dispatcher of the deliveries: one step for each pass. */
export interface Dispatcher {
  step(at: Instant): Promise<DeliveryStep>;
}

/** A send in flight. A stale flight passed its flight limit on a channel that repeats. The log does not keep its copy. */
interface Flight {
  readonly since: Instant;
  readonly copy: string;
  stale: boolean;
}

/** A delivery that the next step writes, and the copy id of its send. */
interface Landed {
  readonly delivery: Delivery;
  readonly copy: string;
}

/**
 * The kinds of a failed send after which the channel can have the message: the answer did not come,
 * or the server failed. A refusal, a bad key and a full quota tell that the channel has no message.
 */
const UNSURE: ReadonlySet<string> = new Set(["network", "timeout", "server"]);

// This function tells if the channel refused a send. Then the channel has no message.
const refusal = (kind: ChannelFailureKind): kind is RefusalKind => !UNSURE.has(kind);

/** The kind and the text of a failed cancel or stop. */
interface CallFailure {
  readonly kind: "timeout" | "network";
  readonly message: string;
}

/** A cancel or a stop that threw is a failure of the kind `network`. */
const thrownFailure = (thrown: unknown, otherwise: string): CallFailure => ({ kind: "network", message: thrown === undefined ? otherwise : errorMessage(thrown) });

/**
 * This function makes the dispatcher. Each call of a channel goes through a time limit. A failed call
 * changes nothing in the log, thus the next step decides it again.
 *
 * - A send that passes its time limit stays in flight, thus it does not get a second send.
 * - The channel can have a copy that the log does not keep. Such a copy passed its flight limit, or its
 *   send failed with no answer. A copy of a key that the log already has is such a copy too. On a channel that repeats,
 *   the step stops that copy by its copy id. The new copy goes in parallel. A stop by the delivery key here can also stop the new copy.
 * - A failed stop goes again at a later step. A stale copy that the channel accepts writes no delivery,
 *   and its stop goes again.
 *
 * The times of the polls and the flights are in memory only. After a restart, each receipt gets a poll
 * at once. The log keeps each refused send, thus the wait of its retry holds after a restart. Before each send on a channel that repeats, the log keeps its copy. The log also
 * keeps the end of the copy: its delivery, a refusal or a stop. Thus the first step after a restart stops each copy of an
 * earlier run with no end.
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
  // Only a copy that the channel repeats needs a stop.
  const repeating = new Set(descriptors.filter((descriptor) => descriptor.repeats).map((descriptor) => descriptor.id as string));
  const recipients = new Map(options.recipients.map((recipient) => [recipient.watch.person as string, recipient]));
  if (!(options.flightLimit >= options.callLimit)) throw new Error(`The flight limit (${options.flightLimit} ms) is shorter than the call limit (${options.callLimit} ms).`);
  // Each copy id starts with the run id. A channel can put it in the path of a URL.
  if (!COPY_ID.test(context.run)) throw new Error(`The run id "${context.run}" has a character that a copy id cannot have. Use letters, digits, _ and -.`);
  const polled = new Map<string, Instant>();
  const waits = new Map<string, Instant>();
  // The send in flight of each key. Each flight is an object, thus a late end does not remove a later flight of the same key.
  const flying = new Map<string, Flight>();
  // The stale copies that the channel can repeat, by copy id. Each step stops them.
  const stopping = new Map<string, { readonly key: string; readonly channel: ChannelId }>();
  let copies = 0;
  // The copies whose send did not end. A stop of such a copy does not end it, because the channel can accept it later.
  const pending = new Set<string>();
  // The copies that need no stop and that the log does not tell yet: a refused send, or a stop after the end of the send.
  const closed = new Set<string>();
  // The first step stops the open copies of the log. Each of them is a copy of an earlier run.
  let restarted = true;
  // The deliveries of the sends that ended after their step. The next step writes them.
  const landed: Landed[] = [];
  const later = (call: string, key: string): string => `${call} ${key}`;
  // The channel accepted a copy, and the log keeps another delivery of its key. No poll reads the copy, thus it gets a stop.
  const duplicate = (delivery: Delivery, copy: string): void => {
    if (repeating.has(delivery.channel)) stopping.set(copy, { key: delivery.key, channel: delivery.channel });
  };

  return {
    async step(at) {
      if (restarted) {
        restarted = false;
        for (const [copy, target] of Object.entries(context.state().copies)) stopping.set(copy, target);
        // The wait of each refused send of the log holds, thus a quota of the channel holds across a restart.
        for (const [key, refused] of Object.entries(context.state().refusals)) if (refused.retryAt > at) waits.set(later("send", key), refused.retryAt);
      }
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
      const fail = (call: DeliveryFailure["call"], target: { readonly key: string; readonly channel: ChannelId; readonly copy?: string }, kind: string, message: string, after?: Duration): Instant => {
        const retryAt = at + Math.max(options.retry, after ?? 0);
        waits.set(later(call, target.copy ?? target.key), retryAt);
        failures.push({ call, key: target.key, ...(target.copy === undefined ? {} : { copy: target.copy }), channel: target.channel, kind, message, retryAt });
        return retryAt;
      };
      // The log keeps each refused send and its retry time. A refusal on a channel that repeats ends its copy.
      const refuse = (target: { readonly key: string; readonly channel: ChannelId }, kind: RefusalKind, retryAt: Instant, copy?: string): void => {
        write([{ ...envelope("refused", `refused:${target.key}@${at}`, clock.now()), key: target.key, channel: target.channel, kind, retryAt, ...(copy === undefined ? {} : { copy }) }]);
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

      // 0. The late sends that ended with a delivery. They go to the log first, thus the routes see them and send no second copy.
      const sent: Delivery[] = [];
      const duplicates: string[] = [];
      const arrived = landed.splice(0);
      // A key of the log, or a key of an earlier delivery of this batch, makes a duplicate.
      const logged = new Set(context.state().merge.deliveries.map((delivery) => delivery.key));
      const fresh: Landed[] = [];
      for (const item of arrived) {
        if (logged.has(item.delivery.key)) {
          duplicates.push(item.delivery.key);
          duplicate(item.delivery, item.copy);
          continue;
        }
        logged.add(item.delivery.key);
        fresh.push(item);
      }
      try {
        write(fresh.map(({ delivery, copy }) => deliveryEvent(delivery, copy, at)));
      } catch (error) {
        // The deliveries stay for the next step. The log has none of them.
        landed.unshift(...arrived);
        throw error;
      }
      for (const { delivery } of fresh) polled.set(delivery.key, at);
      sent.push(...fresh.map(({ delivery }) => delivery));

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
      const cancelled: string[] = [];
      const work: Promise<void>[] = [];
      for (const entry of routes) {
        for (const send of entry.plan.sends) {
          const key = messageKey(send);
          const flight = flying.get(key);
          if (flight !== undefined) {
            const ends = flight.since + options.flightLimit;
            if (at < ends) {
              waiting.push(ends);
              continue;
            }
            // The send hangs past its flight limit, and the channel can have its copy. The step stops that copy by its
            // copy id, and a new copy goes in parallel. A cancel by the delivery key here can also stop the new copy.
            flying.delete(key);
            if (repeating.has(send.channel)) {
              flight.stale = true;
              stopping.set(flight.copy, { key, channel: send.channel });
            }
          }
          if (!ready("send", key)) continue;
          work.push(
            (async () => {
              const target = { key, channel: send.channel };
              const channel = byId.get(send.channel);
              const address = recipients.get(send.person)?.addresses[send.channel];
              if (channel === undefined || address === undefined) {
                const retryAt = fail("send", target, "refused", channel === undefined ? `The system has no channel ${send.channel}.` : `The person has no address on the channel ${send.channel}.`);
                refuse(target, "refused", retryAt);
                return;
              }
              const message = messageOf(entry.incident, context.state().merge.reports, send);
              const deliveryOf = (accepted: Extract<SendOutcome, { ok: true }>): Delivery => ({ key: message.key, incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: accepted.accepted, receipt: accepted.receipt });
              copies += 1;
              const copy = `${context.run}-${copies}`;
              // The log keeps the copy before the send. A write that fails throws, and no send goes.
              if (repeating.has(send.channel)) write([{ ...envelope("attempt", `attempt:${copy}`, clock.now()), key, channel: send.channel, copy }]);
              // The send stays in flight until it ends, also after the time limit of the step.
              const flight: Flight = { since: at, copy, stale: false };
              flying.set(key, flight);
              pending.add(copy);
              let late = false;
              const call = Promise.resolve()
                .then(() => channel.send({ message, address, copy }))
                .then(
                  (result) => result,
                  (error): SendOutcome => ({ ok: false, kind: "network", message: `The send threw: ${errorMessage(error)}` }),
                );
              void call.then((result) => {
                if (flying.get(key) === flight) flying.delete(key);
                pending.delete(copy);
                // The channel can have this copy, and the log does not keep it: a stale copy, or a send with no answer. A stop
                // before the accept does not reach the copy, thus the stop of a stale copy goes again.
                const unkept = result.ok ? flight.stale : UNSURE.has(result.kind);
                if (repeating.has(send.channel)) {
                  if (unkept) {
                    stopping.set(copy, { key, channel: send.channel });
                    if (late) context.wake?.();
                  } else if (!result.ok && late) {
                    // The channel refused the send after its time limit, thus it has no copy to stop. The step writes an
                    // on-time refusal with its copy id.
                    closed.add(copy);
                  }
                }
                if (flight.stale || !late || !result.ok) return;
                landed.push({ delivery: deliveryOf(result), copy });
                context.wake?.();
              });
              const outcome = await limited<SendOutcome>(
                call,
                options.callLimit,
                clock,
                () => {
                  late = true;
                  return { ok: false, kind: "timeout", message: `The send took longer than ${options.callLimit} ms. It stays in flight for up to ${options.flightLimit} ms.` };
                },
                (error) => ({ ok: false, kind: "network", message: `The send threw: ${errorMessage(error)}` }),
              );
              if (!outcome.ok) {
                const retryAt = fail("send", target, outcome.kind, outcome.message, outcome.retryAfter);
                if (refusal(outcome.kind)) refuse(target, outcome.kind, retryAt, repeating.has(send.channel) ? copy : undefined);
                return;
              }
              const delivery = deliveryOf(outcome);
              let different: readonly string[];
              try {
                different = context.append([deliveryEvent(delivery, copy, clock.now())]);
              } catch (error) {
                // The channel has the message, and the log does not. The next step writes the delivery first, thus no second send goes.
                landed.push({ delivery, copy });
                context.wake?.();
                throw error;
              }
              conflicts.push(...different);
              if (different.length > 0) {
                duplicates.push(delivery.key);
                duplicate(delivery, copy);
                return;
              }
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
                const failure = await limited<CallFailure | undefined>(
                  Promise.resolve().then(() => channel.cancel({ receipt })).then(() => undefined),
                  options.callLimit,
                  clock,
                  () => ({ kind: "timeout", message: `The cancel took longer than ${options.callLimit} ms.` }),
                  (thrown) => thrownFailure(thrown, "The cancel failed."),
                );
                if (failure !== undefined) {
                  fail("cancel", delivery, failure.kind, failure.message);
                  return;
                }
              }
              write([{ ...envelope("cancelled", `cancelled:${delivery.key}`, clock.now()), delivery: delivery.key }]);
              cancelled.push(delivery.key);
            })(),
          );
        }
      }
      // 4. The stops of the stale copies, in parallel with the sends. A failed stop goes again at a later step.
      const stopped: string[] = [];
      for (const [copy, target] of stopping) {
        if (!ready("copy", copy)) continue;
        const channel = byId.get(target.channel);
        if (channel === undefined) {
          stopping.delete(copy);
          continue;
        }
        work.push(
          (async () => {
            const failure = await limited<CallFailure | undefined>(
              Promise.resolve()
                .then(() => channel.cancel({ copy }))
                .then(() => undefined),
              options.callLimit,
              clock,
              () => ({ kind: "timeout", message: `The stop of the copy took longer than ${options.callLimit} ms.` }),
              (thrown) => thrownFailure(thrown, "The stop of the copy failed."),
            );
            if (failure !== undefined) {
              fail("copy", { ...target, copy }, failure.kind, failure.message);
              return;
            }
            // A late accept during the stop puts a new entry, thus its stop goes again.
            if (stopping.get(copy) === target) stopping.delete(copy);
            stopped.push(copy);
            // A copy whose send did not end can still get an accept, thus the log does not end it yet.
            if (!pending.has(copy)) closed.add(copy);
          })(),
        );
      }

      // Each call ends before the step ends. A write that failed throws after all of them.
      const settled = await Promise.allSettled(work);
      const broken = settled.find((result) => result.status === "rejected");
      if (broken !== undefined) throw broken.reason;

      // 5. The ends of the open copies of the log. A copy with no entry in the state needs no event.
      const unended = context.state().copies;
      write([...closed].filter((copy) => Object.hasOwn(unended, copy)).map((copy) => ({ ...envelope("settled", `settled:${copy}`, clock.now()), copy })));
      closed.clear();

      const after = routesNow();
      const open = after.flatMap((entry) => entry.polls);
      // Only an open receipt needs the time of its last poll. Each other entry goes, thus the map grows with the open receipts only.
      const keep = new Set(open.map((delivery) => delivery.key));
      for (const key of polled.keys()) if (!keep.has(key)) polled.delete(key);
      const polls = open.map((delivery) => (polled.get(delivery.key) ?? at) + options.pollEvery);
      const wakeAt = earliest([...after.map((entry) => entry.plan.wakeAt), ...polls, ...failures.map((failure) => failure.retryAt), ...waiting]);
      return { routes: after, sent, duplicates, stopped, acknowledged, cancelled, failures, conflicts, ...(wakeAt === undefined ? {} : { wakeAt }) };
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

// The event of a delivery, with the copy id of its send.
function deliveryEvent(delivery: Delivery, copy: string, time: Instant): RuntimeEvent {
  return { ...envelope("delivery", `delivery:${delivery.key}`, time), delivery, copy };
}

// The id of the event of a start: one start for each anchor, level and person.
function startId(entry: Route): string {
  return `escalation:${entry.start.incident}:${entry.start.level}:${entry.start.person}`;
}
