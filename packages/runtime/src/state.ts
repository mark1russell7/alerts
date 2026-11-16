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
  shiftDelivery,
  shiftEndMark,
  shiftEscalationEnd,
  shiftEscalationStart,
  shiftHealth,
  shiftMerge,
  shiftReport,
  startHealth,
  type Acknowledgment,
  type ChannelId,
  type ClockStep,
  type Cursor,
  type Delivery,
  type Duration,
  type EndMark,
  type EscalationEnd,
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
  /** The end of the escalations of a person in a live incident that no longer reaches the person, in the order of the log. */
  readonly escalationEnds: readonly EscalationEnd[];
  /**
   * The open copies, by copy id: each send on a channel that repeats with no delivery of its copy and no
   * `settled` event. The channel can repeat them. After a restart, the delivery step stops them.
   */
  readonly copies: Readonly<Record<string, OpenCopy>>;
  /**
   * The last refusal of each delivery key with no later delivery of the key, by the key. A start of a run and
   * a refusal drop each refusal whose retry is at or before their time. Thus the record keeps only the waits.
   */
  readonly refusals: Readonly<Record<string, Refusal>>;
  /** The count of the deliveries of each channel in the log, by the channel id. */
  readonly delivered: Readonly<Record<string, number>>;
  /**
   * The steps of the wall clock, in the order of the log. A later step moves the time of each earlier step, as it
   * moves each own instant of the state.
   */
  readonly steps: readonly ClockStep[];
}

/** The last refusal of a delivery key. */
export interface Refusal {
  readonly channel: ChannelId;
  readonly kind: RefusalKind;
  /** The time of the refusal. */
  readonly at: Instant;
  readonly retryAt: Instant;
  /**
   * The count of the deliveries of the channel in the log before the refusal. When `delivered` of the
   * channel is larger, a delivery on the channel came after the refusal in the log.
   */
  readonly deliveries: number;
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
  escalationEnds: [],
  copies: {},
  refusals: {},
  delivered: {},
  steps: [],
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
    // A step moves the parts before it, as the fold moves its merge state. The parts after it are in the new frame.
    if (event.type === "clock") {
      for (let index = 0; index < reports.length; index += 1) reports[index] = shiftReport(reports[index]!, event.size);
      for (let index = 0; index < deliveries.length; index += 1) deliveries[index] = shiftDelivery(deliveries[index]!, event.size);
      for (let index = 0; index < ends.length; index += 1) ends[index] = shiftEndMark(ends[index]!, event.size);
    }
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
      return {
        ends: event.reports.map((report) => ({
          report,
          at: event.time,
          ended: event.type === "ended",
          ...(event.type === "ended" && event.asOf !== undefined ? { asOf: event.asOf } : {}),
        })),
      };
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
      return { ...base, start, health, refusals: waiting(state.refusals, event.time) };
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
    case "escalation-end":
      return { ...base, escalationEnds: [...state.escalationEnds, event.end] };
    case "cancelled":
      return state.cancelled.includes(event.delivery) ? base : { ...base, cancelled: [...state.cancelled, event.delivery].sort(compare) };
    case "attempt":
      return { ...base, copies: { ...state.copies, [event.copy]: { key: event.key, channel: event.channel } } };
    case "delivery": {
      const refusals = without(state.refusals, event.delivery.key);
      const { channel } = event.delivery;
      const delivered = { ...state.delivered, [channel]: (state.delivered[channel] ?? 0) + 1 };
      return { ...base, refusals, delivered, copies: event.copy === undefined ? state.copies : without(state.copies, event.copy) };
    }
    case "settled":
      return { ...base, copies: without(state.copies, event.copy) };
    case "refused": {
      const refusal: Refusal = { channel: event.channel, kind: event.kind, at: event.time, retryAt: event.retryAt, deliveries: state.delivered[event.channel] ?? 0 };
      const refusals = { ...waiting(state.refusals, event.time), [event.key]: refusal };
      return { ...base, refusals, copies: event.copy === undefined ? state.copies : without(state.copies, event.copy) };
    }
    case "clock": {
      const shifted = shiftState(state, event.size);
      return { ...shifted, time: Math.max(shifted.time, event.time), steps: [...shifted.steps, { at: event.time, size: event.size }] };
    }
    default:
      return base;
  }
}

/**
 * This function moves each own instant of a state by the size of a step of the wall clock. The instants of the sources
 * and the channels do not move: `shiftMerge` of the core tells which instants of the merge move. The cursors, the
 * lines of the system reports and the counts hold no own instant.
 */
export function shiftState(state: RuntimeState, size: Duration): RuntimeState {
  const health = Object.fromEntries(Object.entries(state.health).map(([source, track]) => [source, shiftHealth(track, size)]));
  const fetched = Object.fromEntries(Object.entries(state.fetched).map(([source, at]) => [source, at + size]));
  const refusals = Object.fromEntries(Object.entries(state.refusals).map(([key, refusal]) => [key, { ...refusal, at: refusal.at + size, retryAt: refusal.retryAt + size }]));
  return {
    ...state,
    ...(state.start === undefined ? {} : { start: state.start + size }),
    time: state.time + size,
    merge: shiftMerge(state.merge, size),
    health,
    fetched,
    refusals,
    starts: state.starts.map((start) => shiftEscalationStart(start, size)),
    escalationEnds: state.escalationEnds.map((end) => shiftEscalationEnd(end, size)),
    steps: state.steps.map((step) => ({ ...step, at: step.at + size })),
  };
}

// The refusals with a retry after the time `at`. A refusal with an earlier retry holds no send and no channel after a restart.
function waiting(refusals: Readonly<Record<string, Refusal>>, at: Instant): Readonly<Record<string, Refusal>> {
  const kept = Object.entries(refusals).filter(([, refusal]) => refusal.retryAt > at);
  return kept.length === Object.keys(refusals).length ? refusals : Object.fromEntries(kept);
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
