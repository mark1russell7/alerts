/**
 * This module holds the state of the runtime and the fold of the events of its log. The fold is the
 * only change of the state. The runtime writes an event to the log and folds it in one step, thus the
 * state after a restart is the state before it.
 */
import {
  add,
  addSystemReports,
  EMPTY_STATE,
  NO_SYSTEM_LINES,
  normalize,
  observeFetch,
  startHealth,
  type Acknowledgment,
  type ChannelId,
  type Cursor,
  type Delivery,
  type EndMark,
  type EscalationStart,
  type HealthOptions,
  type HealthTrack,
  type Instant,
  type MergeParts,
  type MergeState,
  type Report,
  type SourceDescriptor,
  type SystemLines,
} from "@mark1russell7/alerts";
import type { RefusalKind, RuntimeEvent } from "./events.ts";

/** What the fold reads from the configuration: the descriptors of the sources and the options of the health. */
export interface FoldContext {
  readonly sources: readonly SourceDescriptor[];
  readonly health?: HealthOptions;
}

/** The state of the runtime: a fold of the log. */
export interface RuntimeState {
  /** The time of the first start. Each health track starts at it. */
  readonly start?: Instant;
  /** The time of the latest event. */
  readonly time: Instant;
  /** The reports, the deliveries and the acknowledgments. */
  readonly merge: MergeState;
  /** The health track of each source, by its id. Only a fetch record moves it. A view at a later time advances a copy. */
  readonly health: Readonly<Record<string, HealthTrack>>;
  /** The start of the last fetch of each source, by its id. */
  readonly fetched: Readonly<Record<string, Instant>>;
  /** The cursor of each source for its next fetch, by its id. */
  readonly cursors: Readonly<Record<string, Cursor>>;
  /** The open lines of the system reports. */
  readonly lines: SystemLines;
  /** The keys of the deliveries with no more repeats, sorted. */
  readonly cancelled: readonly string[];
  /** The start of each escalation, in the order of the log. */
  readonly starts: readonly EscalationStart[];
  /**
   * The open copies, by copy id: each send on a channel that repeats with no delivery of its copy and no
   * `settled` event. The channel can repeat them. After a restart, the delivery step stops them.
   */
  readonly copies: Readonly<Record<string, OpenCopy>>;
  /** The last refusal of each delivery key with no later delivery of the key, by the key. */
  readonly refusals: Readonly<Record<string, Refusal>>;
}

/** The last refusal of a delivery key. */
export interface Refusal {
  readonly channel: ChannelId;
  readonly kind: RefusalKind;
  /** The time of the refusal. */
  readonly at: Instant;
  readonly retryAt: Instant;
}

/** The send of an open copy. */
export interface OpenCopy {
  /** The delivery key of the send. */
  readonly key: string;
  readonly channel: ChannelId;
}

/** The state before the first event. */
export const EMPTY_RUNTIME: RuntimeState = {
  time: Number.NEGATIVE_INFINITY,
  merge: EMPTY_STATE,
  health: {},
  fetched: {},
  cursors: {},
  lines: NO_SYSTEM_LINES,
  cancelled: [],
  starts: [],
  copies: {},
  refusals: {},
};

/** This function adds one event to the state. */
export function fold(state: RuntimeState, event: RuntimeEvent, context: FoldContext): RuntimeState {
  const rest = foldRest(state, event, context);
  const parts = partsOf(event);
  return parts === undefined ? rest : { ...rest, merge: add(state.merge, parts) };
}

/**
 * This function gives the state of the events of a log, in their order. It equals a fold of each
 * event. The merge is a join of a semilattice, thus the function joins all the parts once, at the end.
 */
export function rebuild(events: Iterable<RuntimeEvent>, context: FoldContext): RuntimeState {
  let state = EMPTY_RUNTIME;
  const reports: Report[] = [];
  const deliveries: Delivery[] = [];
  const acks: Acknowledgment[] = [];
  const ends: EndMark[] = [];
  for (const event of events) {
    state = foldRest(state, event, context);
    const parts = partsOf(event);
    reports.push(...(parts?.reports ?? []));
    deliveries.push(...(parts?.deliveries ?? []));
    acks.push(...(parts?.acks ?? []));
    ends.push(...(parts?.ends ?? []));
  }
  return { ...state, merge: normalize({ reports, deliveries, acks, ends }) };
}

// The parts of the merge in an event.
function partsOf(event: RuntimeEvent): MergeParts | undefined {
  switch (event.type) {
    case "fetch":
    case "system":
      return event.reports.length === 0 ? undefined : { reports: event.reports };
    case "delivery":
      return { deliveries: [event.delivery] };
    case "acknowledgment":
      return { acks: [event.acknowledgment] };
    case "ended":
    case "back":
      return { ends: event.reports.map((report) => ({ report, at: event.time, ended: event.type === "ended" })) };
    default:
      return undefined;
  }
}

// Each change of an event other than the merge.
function foldRest(state: RuntimeState, event: RuntimeEvent, context: FoldContext): RuntimeState {
  const base: RuntimeState = { ...state, time: Math.max(state.time, event.time) };
  const start = state.start ?? event.time;
  switch (event.type) {
    case "started": {
      const health = { ...state.health };
      for (const source of context.sources) health[source.id] ??= startHealth(source.id, start);
      return { ...base, start, health };
    }
    case "fetch": {
      const { record } = event;
      const descriptor = context.sources.find((source) => source.id === record.source);
      const cursors = event.cursor === undefined ? state.cursors : { ...state.cursors, [record.source]: event.cursor };
      const next: RuntimeState = { ...base, start, cursors, fetched: { ...state.fetched, [record.source]: Math.max(state.fetched[record.source] ?? record.at, record.at) } };
      // A source that is not in the configuration keeps its reports, and it has no health.
      if (descriptor === undefined) return next;
      const track = state.health[record.source] ?? startHealth(record.source, start);
      return { ...next, health: { ...state.health, [record.source]: observeFetch(track, record, descriptor, context.health).track } };
    }
    case "system":
      return { ...base, lines: addSystemReports(state.lines, event.reports, event.observations) };
    case "escalation":
      return { ...base, starts: [...state.starts, event.start] };
    case "cancelled":
      return state.cancelled.includes(event.delivery) ? base : { ...base, cancelled: [...state.cancelled, event.delivery].sort(compare) };
    case "attempt":
      return { ...base, copies: { ...state.copies, [event.copy]: { key: event.key, channel: event.channel } } };
    case "delivery": {
      const refusals = without(state.refusals, event.delivery.key);
      return { ...base, refusals, copies: event.copy === undefined ? state.copies : without(state.copies, event.copy) };
    }
    case "settled":
      return { ...base, copies: without(state.copies, event.copy) };
    case "refused": {
      const refusals = { ...state.refusals, [event.key]: { channel: event.channel, kind: event.kind, at: event.time, retryAt: event.retryAt } };
      return { ...base, refusals, copies: event.copy === undefined ? state.copies : without(state.copies, event.copy) };
    }
    default:
      return base;
  }
}

// The record with no entry for one id.
function without<T>(record: Readonly<Record<string, T>>, id: string): Readonly<Record<string, T>> {
  if (!Object.hasOwn(record, id)) return record;
  const rest = { ...record };
  delete rest[id];
  return rest;
}

// The order of the code units, the same in each copy and each locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
