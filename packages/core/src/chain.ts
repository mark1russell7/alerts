/**
 * The chain of tries: the escalation of one person when no timer runs. The end of each try starts
 * the next try, so a function with no state can make each step. The outage call of the outside
 * heartbeat uses it. The instance is down then, so a function on the server of the call provider
 * operates the chain.
 *
 * `CHAIN_MACHINE` is the machine document of the chain, in the format of `@mark1russell7/algebra`.
 * `chainRun` makes only its transitions. `outageAudit` compares each outage with the records of
 * the tries, and finds each person with no confirmed try.
 */

import type { Machine, Transition } from "@mark1russell7/algebra";
import type { ChannelId, Duration, Instant, PersonId } from "./contracts.ts";

/**
 * The end of one try.
 * - `acked`: the person confirmed the message, for example with a key press.
 * - `unconfirmed`: the try reached the address, and no person confirmed it. Busy, no answer, a voicemail and a hang-up with no key press are unconfirmed.
 * - `failed`: the try did not reach the address, for example a failed call or a refused number.
 * - `sent`: a channel with no confirmation accepted the message, for example a text message.
 */
export type TryEnd = "acked" | "unconfirmed" | "failed" | "sent";

/** The ends of a try, in a fixed order. */
export const TRY_ENDS: readonly TryEnd[] = ["acked", "unconfirmed", "failed", "sent"];

/** The chain of one person: the channel of each try, in order. Each try starts at the end of the try before it. */
export interface TryChain {
  readonly steps: readonly ChannelId[];
}

/**
 * The state of a chain.
 * - `trying`: the try `step` on `channel` runs.
 * - `acked`: the person confirmed the try `step`. No try follows.
 * - `exhausted`: each try ended with no confirmation. No try follows, and the audit reports it.
 */
export type ChainState =
  | { readonly kind: "trying"; readonly step: number; readonly channel: ChannelId }
  | { readonly kind: "acked"; readonly step: number }
  | { readonly kind: "exhausted" };

/** The machine document of the chain. `chainRun` makes only the transitions of this document. */
export const CHAIN_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "alerts.chain",
  title: "The tries of one person when no timer runs, until a confirmation",
  layer: "self",
  version: "1",
  sources: [{ ref: "docs/CONTRACTS.md of the alerts repository: the chain of tries", rung: "derived" }],
  states: {
    start: { initial: true, note: "no try started" },
    trying: { note: "one try runs" },
    acked: { final: true, note: "the person confirmed a try" },
    exhausted: { final: true, note: "each try ended with no confirmation" },
  },
  events: {
    "app.start": { kind: "app", note: "the start of the chain, for example the webhook of the outside check" },
    "app.acked": { kind: "app", note: "the person confirmed the try" },
    "app.unconfirmed": { kind: "app", note: "the try reached the address, and no person confirmed it" },
    "app.failed": { kind: "app", note: "the try did not reach the address" },
    "app.sent": { kind: "app", note: "a channel with no confirmation accepted the message" },
  },
  knobs: {},
  timers: {},
  transitions: [
    { id: "ch.start", from: "start", to: "trying", on: "app.start" },
    { id: "ch.none", from: "start", to: "exhausted", on: "app.start", note: "a chain with no step: nothing reaches the person" },
    { id: "ch.ack", from: "trying", to: "acked", on: "app.acked" },
    { id: "ch.next.unconfirmed", from: "trying", to: "trying", on: "app.unconfirmed" },
    { id: "ch.next.failed", from: "trying", to: "trying", on: "app.failed" },
    { id: "ch.next.sent", from: "trying", to: "trying", on: "app.sent" },
    { id: "ch.last.unconfirmed", from: "trying", to: "exhausted", on: "app.unconfirmed" },
    { id: "ch.last.failed", from: "trying", to: "exhausted", on: "app.failed" },
    { id: "ch.last.sent", from: "trying", to: "exhausted", on: "app.sent" },
  ],
};

/**
 * This function gives the next state of a chain. Without `end`, it gives the start. With `end`, it
 * gives the state after the try `step`. A step that the chain does not have gives `exhausted`, so an
 * old or false step starts no try.
 */
export function chainNext(chain: TryChain, step?: number, end?: TryEnd): ChainState {
  if (step === undefined || end === undefined) return tryAt(chain, 0);
  if (!Number.isSafeInteger(step) || step < 0 || step >= chain.steps.length) return { kind: "exhausted" };
  if (end === "acked") return { kind: "acked", step };
  return tryAt(chain, step + 1);
}

function tryAt(chain: TryChain, step: number): ChainState {
  const channel = chain.steps[step];
  return channel === undefined ? { kind: "exhausted" } : { kind: "trying", step, channel };
}

/** The end of one try at a time. */
export interface TimedEnd {
  readonly end: TryEnd;
  readonly at: Instant;
}

/** The result of `chainRun`. */
export interface ChainRun {
  readonly state: ChainState;
  /** The count of the tries that started. It is at most the count of the steps of the chain. */
  readonly tries: number;
  /** The transitions, in the format of `@mark1russell7/algebra`, for a replay against `CHAIN_MACHINE`. */
  readonly transitions: readonly Transition[];
  /** The count of the ends after a final state. Each one is a fault of the records, because no try was open. */
  readonly extra: number;
}

/** This function gives the state of a chain that started at `start`, after the ends of its tries in order. It is a fold of `chainNext`. */
export function chainRun(chain: TryChain, start: Instant, ends: readonly TimedEnd[], instance: string): ChainRun {
  const transitions: Transition[] = [];
  let state = chainNext(chain);
  transitions.push({ machine: CHAIN_MACHINE.id, instance, from: "start", on: "app.start", to: state.kind, at: start });
  let tries = state.kind === "trying" ? 1 : 0;
  let extra = 0;
  for (const { end, at } of ends) {
    if (state.kind !== "trying") {
      extra += 1;
      continue;
    }
    const next = chainNext(chain, state.step, end);
    transitions.push({ machine: CHAIN_MACHINE.id, instance, from: "trying", on: `app.${end}`, to: next.kind, at });
    if (next.kind === "trying") tries += 1;
    state = next;
  }
  return { state, tries, transitions, extra };
}

/** One outage of the instance: the time at which the outside check went down, and the time at which it came up. */
export interface Outage {
  readonly down: Instant;
  readonly up?: Instant;
}

/** The record of one try of one person, from the records of the provider. */
export interface TryRecord {
  readonly person: PersonId;
  readonly started: Instant;
  readonly end: TryEnd;
  /** The time of the end of the try. */
  readonly at: Instant;
}

/**
 * The reach of one outage to one person.
 * - `acked`: the person confirmed a try.
 * - `exhausted`: each try ended with no confirmation.
 * - `open`: the records end before the chain does.
 * - `untried`: no try started. The webhook of the check or the start of the chain failed.
 */
export interface OutageReach {
  readonly down: Instant;
  readonly person: PersonId;
  readonly state: "acked" | "exhausted" | "open" | "untried";
  /** The count of the records of tries. A count above the count of the steps of the chain is a fault: the provider made more tries than the chain permits. */
  readonly tries: number;
  /** The time of the confirmation, when the state is `acked`. */
  readonly ackedAt?: Instant;
}

/**
 * This function gives the reach of each outage to each person. The tries of an outage are the records
 * that start in the time `within` after its down time, and before the next down time. Each reach that
 * is not `acked` is a fault of the outage call.
 */
export function outageAudit(outages: readonly Outage[], chains: ReadonlyMap<PersonId, TryChain>, records: readonly TryRecord[], within: Duration): OutageReach[] {
  const downs = [...outages].sort((a, b) => a.down - b.down);
  return downs.flatMap((outage, index) => {
    const until = Math.min(outage.down + within, downs[index + 1]?.down ?? Number.POSITIVE_INFINITY);
    return [...chains].map(([person, chain]): OutageReach => {
      const own = records.filter((record) => record.person === person && record.started >= outage.down && record.started < until).sort((a, b) => a.started - b.started);
      if (own.length === 0) return { down: outage.down, person, state: "untried", tries: 0 };
      const run = chainRun(chain, outage.down, own, `${outage.down} ${person}`);
      const tries = own.length;
      if (run.state.kind === "acked") return { down: outage.down, person, state: "acked", tries, ackedAt: own[run.state.step]!.at };
      return { down: outage.down, person, state: run.state.kind === "exhausted" ? "exhausted" : "open", tries };
    });
  });
}
