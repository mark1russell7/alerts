/**
 * The escalation of one level of one incident to one person. It is a pure calculation. Its input
 * is the policy, the deliveries and the acknowledgments of the merge state, and the time. Its
 * output is the state, the sends that are due, the cancels and the time of the next decision. It
 * reads no channel and no clock: the runtime gives `now`, and starts it again at `wakeAt` or when the
 * merge state changes.
 *
 * `ESCALATION_MACHINE` is the machine document of the escalation, in the format of
 * `@mark1russell7/algebra`. Each plan gives its transitions, and a replay against the document
 * finds a transition that the document does not permit.
 */

import type { Machine, Transition } from "@mark1russell7/algebra";
import { LEVELS } from "./contracts.ts";
import type { Acknowledgment, ChannelId, Delivery, Duration, EscalationPolicy, Incident, Instant, Level, PersonId, ReportId } from "./contracts.ts";
import type { MessageKeyInput } from "./ids.ts";

/**
 * The state of an escalation.
 * - `idle`: no step is due.
 * - `sent`: one or more steps are due, and one or more steps are not due.
 * - `last`: each step is due. The time to the exhaustion runs.
 * - `exhausted`: no acknowledgment came in the time of the policy. This is a system alert.
 * - `acknowledged`: the person acknowledged, by a channel or by the UI.
 * - `ended`: the incident is over, by its expiry or by its cancel.
 */
export type EscalationState = "idle" | "sent" | "last" | "exhausted" | "acknowledged" | "ended";

/** The events of the escalation machine. */
export const ESCALATION_EVENTS: {
  readonly step: "timer.step";
  readonly exhaust: "timer.exhaust";
  readonly ack: "app.ack";
  readonly end: "app.end";
} = { step: "timer.step", exhaust: "timer.exhaust", ack: "app.ack", end: "app.end" };

/** The machine document of the escalation. `escalate` makes only the transitions of this document. */
export const ESCALATION_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "alerts.escalation",
  title: "The escalation of one level of one incident to one person, until an acknowledgment",
  layer: "self",
  version: "1",
  sources: [{ ref: "docs/CONTRACTS.md of the alerts repository: the channel contract and the delivery promise", rung: "derived" }],
  states: {
    idle: { initial: true, note: "no step is due" },
    sent: { note: "one or more steps are due, and one or more steps are not due" },
    last: { note: "each step is due, and the exhaust timer runs" },
    exhausted: { note: "no acknowledgment came in the time of the policy. An acknowledgment or the end still stops the repeats" },
    acknowledged: { final: true },
    ended: { final: true, note: "the incident is over, by its expiry or by its cancel" },
  },
  events: {
    "timer.step": { kind: "timer", note: "the time of the next step of the policy" },
    "timer.exhaust": { kind: "timer", note: "the end of the time after the last step" },
    "app.ack": { kind: "app", note: "an acknowledgment in the merge state, from a channel or from the UI" },
    "app.end": { kind: "app", note: "the expiry or the cancel of the incident" },
  },
  knobs: {
    step_at: { key: "EscalationStep.at", scope: "policy", unit: "ms", default: null, note: "the time from the start to the first step" },
    step_wait: { key: "the time from one step of the policy to the next", scope: "policy", unit: "ms", default: null, note: "the policy gives one for each step" },
    rank_wait: { key: "rank × rankDelay of the copy", scope: "cell", unit: "ms", default: null, note: "a copy waits for its rank before each send" },
    exhausted_after: { key: "EscalationPolicy.exhaustedAfter", scope: "policy", unit: "ms", default: null },
  },
  timers: {
    first: {
      duration: { expr: "step_at + rank_wait", unit: "ms" },
      arms: ["enter:idle"],
      cancels: ["app.ack", "app.end"],
      fires: "timer.step",
      note: "the time from the start to the first step",
    },
    next: {
      duration: { knob: "step_wait", unit: "ms" },
      arms: ["timer.step"],
      cancels: ["app.ack", "app.end", "enter:last"],
      fires: "timer.step",
      note: "the time from one step to the next",
    },
    exhaust: {
      duration: { knob: "exhausted_after", unit: "ms" },
      arms: ["enter:last"],
      cancels: ["app.ack", "app.end"],
      fires: "timer.exhaust",
    },
  },
  transitions: [
    { id: "es.first", from: "idle", to: "sent", on: "timer.step", note: "the first step of a policy with two or more steps" },
    { id: "es.only", from: "idle", to: "last", on: "timer.step", note: "the step of a policy with one step" },
    { id: "es.next", from: "sent", to: "sent", on: "timer.step" },
    { id: "es.last", from: "sent", to: "last", on: "timer.step" },
    { id: "es.exhaust", from: "last", to: "exhausted", on: "timer.exhaust" },
    { id: "es.none", from: "idle", to: "exhausted", on: "timer.exhaust", note: "a policy with no step: nothing reaches the person" },
    { id: "es.ack", from: "*", to: "acknowledged", on: "app.ack" },
    { id: "es.end", from: "*", to: "ended", on: "app.end" },
  ],
};

/** The input of `escalate`. */
export interface EscalationInput {
  readonly policy: EscalationPolicy;
  readonly person: PersonId;
  /** The incident. A delivery or an acknowledgment that points to one of its reports belongs to it. */
  readonly incident: Pick<Incident, "anchor" | "reports">;
  /** The time at which the level of the incident first called for this escalation. */
  readonly since: Instant;
  /** The time at which the incident is over: its expiry, or the time of its cancel. Without it, the incident is live. */
  readonly endsAt?: Instant | undefined;
  /** The deliveries of the merge state. The function keeps the deliveries of this incident, level and person. */
  readonly deliveries: readonly Delivery[];
  /**
   * The acknowledgments of the merge state. The function keeps the acknowledgments of the person for
   * this incident, at this level or above. An acknowledgment of a level also covers each lower level.
   */
  readonly acknowledgments: readonly Acknowledgment[];
  /** The delivery keys that this copy cancelled. A cancel is idempotent, so this set only prevents a second call. */
  readonly cancelled?: ReadonlySet<string> | undefined;
  /** The rank of this copy of the system, from 0. A copy waits `rank × rankDelay` before each send. */
  readonly rank?: number | undefined;
  readonly rankDelay?: Duration | undefined;
  readonly now: Instant;
}

/** A send that is due. The runtime makes the delivery key with `messageKey` of this value. */
export interface EscalationSend extends MessageKeyInput {
  readonly channel: ChannelId;
  /** The time at which the step became due. */
  readonly due: Instant;
}

/** The output of `escalate`. */
export interface EscalationPlan {
  readonly state: EscalationState;
  /** The start of the escalation: the earliest of `since` and the start that each delivery of the ledger shows. */
  readonly start: Instant;
  /** The indexes of the steps that are due, in the order of their times. */
  readonly due: readonly number[];
  /** The steps that are due and have no delivery in the ledger. Only `sent`, `last` and `exhausted` have sends. */
  readonly sends: readonly EscalationSend[];
  /** The deliveries to cancel, after an acknowledgment or the end. Each one has a different key. */
  readonly cancels: readonly Delivery[];
  /** The time of the next decision. It is absent when only an acknowledgment or the end can change the state. */
  readonly wakeAt?: Instant;
  /** The first acknowledgment of the person. */
  readonly acknowledgment?: Acknowledgment;
  /** The time of the exhaustion, when it occurred. */
  readonly exhaustedAt?: Instant;
  /** Each transition from the start to `now`. The instance is the anchor, the level and the person. */
  readonly transitions: readonly Transition[];
}

interface Event {
  readonly at: Instant;
  readonly on: (typeof ESCALATION_EVENTS)[keyof typeof ESCALATION_EVENTS];
  /** At one time, an acknowledgment comes first, then the end, then the steps, then the exhaustion. */
  readonly order: number;
  readonly step: number;
}

const FINAL: ReadonlySet<EscalationState> = new Set(["acknowledged", "ended"]);
const ACTIVE: ReadonlySet<EscalationState> = new Set(["sent", "last", "exhausted"]);

/**
 * This function calculates the escalation at `now`. It is pure and total: the same input gives
 * the same plan, and it does not throw. Two copies of the system with the same merge state give the
 * same plan, apart from the wait of their rank.
 *
 * - A step is due at `start + step.at + rank × rankDelay`. Each due step without a delivery in the
 *   ledger is a send, also a late one. The system prefers a duplicate to a miss.
 * - An acknowledgment stops the sends, and each delivery becomes a cancel. The end does the same.
 * - The exhaustion comes `exhaustedAfter` after the last step. The repeats continue after it.
 * - A failed send makes no delivery, so its step stays due and the next plan sends it again.
 * - The delivery is at least once, not exactly once. A crash after a send and before its record
 *   gives a second send with the same `messageKey`. A channel that drops a repeated key drops it.
 */
export function escalate(input: EscalationInput): EscalationPlan {
  const { policy, person, incident, now } = input;
  const level = policy.level;
  const reports = new Set<string>([incident.anchor, ...incident.reports]);
  const ours = (item: { readonly incident: ReportId; readonly level: Level; readonly person: PersonId }): boolean =>
    reports.has(item.incident) && item.level === level && item.person === person;
  const deliveries = input.deliveries.filter(ours);
  const least = LEVELS.indexOf(level);
  const covers = (ack: Acknowledgment): boolean => reports.has(ack.incident) && ack.person === person && LEVELS.indexOf(ack.level) >= least;
  const acknowledgment = input.acknowledgments.filter(covers).sort(byTimeThenVia)[0];
  const steps = policy.steps;
  const wait = nonNegative(input.rank) * nonNegative(input.rankDelay);

  // A step time that is not a number of 0 or more counts as 0: escalationProblems reports it, and a send comes early, not late.
  const offsets = steps.map((step) => nonNegative(step.at));

  // Another copy can have started first. Its deliveries show its start.
  let start = Number.isFinite(input.since) ? input.since : now;
  for (const delivery of deliveries) {
    const offset = offsets[delivery.step];
    if (offset !== undefined && Number.isFinite(delivery.at)) start = Math.min(start, delivery.at - offset);
  }

  const events: Event[] = offsets.map((offset, index) => ({ at: start + offset + wait, on: ESCALATION_EVENTS.step, order: 2, step: index }));
  const lastAt = Math.max(0, ...offsets);
  events.push({ at: start + lastAt + nonNegative(policy.exhaustedAfter) + wait, on: ESCALATION_EVENTS.exhaust, order: 3, step: -1 });
  // An acknowledgment in the merge state occurred, also when the clock of its copy is ahead or broken.
  if (acknowledgment !== undefined) {
    events.push({ at: Number.isFinite(acknowledgment.at) ? Math.min(acknowledgment.at, now) : now, on: ESCALATION_EVENTS.ack, order: 0, step: -1 });
  }
  if (input.endsAt !== undefined && Number.isFinite(input.endsAt)) events.push({ at: input.endsAt, on: ESCALATION_EVENTS.end, order: 1, step: -1 });
  events.sort((a, b) => a.at - b.at || a.order - b.order || a.step - b.step);

  const instance = `${incident.anchor} ${level} ${person}`;
  const transitions: Transition[] = [];
  const due: number[] = [];
  let state: EscalationState = "idle";
  let wakeAt: Instant | undefined;
  let exhaustedAt: Instant | undefined;
  const move = (event: Event, to: EscalationState): void => {
    transitions.push({ machine: ESCALATION_MACHINE.id, instance, from: state, on: event.on, to, at: event.at });
    state = to;
  };

  for (const event of events) {
    if (FINAL.has(state)) break;
    if (event.at > now) {
      wakeAt = event.at;
      break;
    }
    if (event.on === ESCALATION_EVENTS.step) {
      due.push(event.step);
      move(event, due.length === steps.length ? "last" : "sent");
    } else if (event.on === ESCALATION_EVENTS.exhaust) {
      exhaustedAt = event.at;
      move(event, "exhausted");
    } else {
      move(event, event.on === ESCALATION_EVENTS.ack ? "acknowledged" : "ended");
    }
  }

  const delivered = new Set(deliveries.map((delivery) => delivery.step));
  const sends: EscalationSend[] = ACTIVE.has(state)
    ? due.flatMap((index) => {
        const step = steps[index];
        const offset = offsets[index] ?? 0;
        return step === undefined || delivered.has(index)
          ? []
          : [{ incident: incident.anchor, level, person, step: index, channel: step.channel, due: start + offset + wait }];
      })
    : [];

  const cancels: Delivery[] = [];
  if (FINAL.has(state)) {
    const seen = new Set<string>(input.cancelled ?? []);
    for (const delivery of [...deliveries].sort((a, b) => byTime(a.at, b.at) || compare(a.key, b.key))) {
      if (seen.has(delivery.key)) continue;
      seen.add(delivery.key);
      cancels.push(delivery);
    }
  }

  return {
    state,
    start,
    due,
    sends,
    cancels,
    ...(wakeAt === undefined ? {} : { wakeAt }),
    ...(acknowledgment === undefined ? {} : { acknowledgment }),
    ...(exhaustedAt === undefined ? {} : { exhaustedAt }),
    transitions,
  };
}

/**
 * This function gives the problems of a policy. `escalate` accepts each policy, but a policy with a
 * problem does not do what its author meant.
 */
export function escalationProblems(policy: EscalationPolicy): string[] {
  const problems: string[] = [];
  if (policy.steps.length === 0) problems.push(`The policy of ${policy.level} has no step, so nothing reaches the person.`);
  policy.steps.forEach((step, index) => {
    if (!Number.isFinite(step.at) || step.at < 0) problems.push(`Step ${index} has the time ${step.at}. A time is 0 or more.`);
    const before = policy.steps[index - 1];
    if (before !== undefined && step.at < before.at) problems.push(`Step ${index} comes before step ${index - 1}.`);
  });
  if (!Number.isFinite(policy.exhaustedAfter) || policy.exhaustedAfter < 0) problems.push(`exhaustedAfter is ${policy.exhaustedAfter}. It is 0 or more.`);
  return problems;
}

const nonNegative = (value: number | undefined): number => (value !== undefined && Number.isFinite(value) && value > 0 ? value : 0);

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** This order puts a time that is not a number last, so the order of the input has no effect. */
const byTime = (a: number, b: number): number => {
  const x = Number.isFinite(a) ? a : Number.POSITIVE_INFINITY;
  const y = Number.isFinite(b) ? b : Number.POSITIVE_INFINITY;
  return x < y ? -1 : x > y ? 1 : 0;
};

function byTimeThenVia(a: Acknowledgment, b: Acknowledgment): number {
  return byTime(a.at, b.at) || compare(a.via, b.via);
}
