/**
 * This module holds the state of the runtime and the fold of the events of its log. The fold is the
 * only change of the state. The runtime writes an event to the log and folds it in one step, thus the
 * state after a restart is the state before it.
 */
import {
  add,
  addSystemReports,
  EMPTY_STATE,
  join,
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
  type LogRecovery,
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
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { ImportEvent, RefusalKind, RuntimeEvent, SharedEvent } from "./events.ts";

/** What the fold reads from the configuration: the descriptors of the sources and the options of the health. */
export interface FoldContext {
  readonly sources: readonly SourceDescriptor[];
  readonly health?: HealthOptions;
}

/** The shared state of one side: this copy, or the other copies of the system. */
export interface SharedState {
  /** The reports, the deliveries, the acknowledgments and the end marks. */
  readonly merge: MergeState;
  /** The ends of the escalations, in the order of the log. */
  readonly escalationEnds: readonly EscalationEnd[];
}

/** The read position in the log of another copy. */
export interface ExchangeCursor {
  /** The id of the first event of the log of the copy. */
  readonly log: string;
  /** The position of the last entry that the read examined. */
  readonly next: number;
}

/** The shared state with no part. */
export const NO_SHARED: SharedState = { merge: EMPTY_STATE, escalationEnds: [] };

/** The state of the runtime: a fold of the log. */
export interface RuntimeState {
  /** The time of the first start. Each health track starts at it. */
  readonly start?: Instant;
  /** The time of the latest event. */
  readonly time: Instant;
  /** The reports, the deliveries and the acknowledgments of each copy: the join of `own` and `imported`. */
  readonly merge: MergeState;
  /** The shared state that this copy wrote. A step of the wall clock moves it. Without imports, its merge is `merge`. */
  readonly own: SharedState;
  /**
   * The shared state that the other copies wrote (AL-16). It has the times of their clocks, thus a step of the wall clock
   * of this copy does not move it.
   */
  readonly imported: SharedState;
  /** The read position in the log of each other copy, by the id of the copy. */
  readonly exchanges: Readonly<Record<string, ExchangeCursor>>;
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
   * The end of the escalations of a person in a live incident that no longer reaches the person. It holds the ends of
   * `own`, then the ends of `imported`.
   */
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
  /** The recoveries of the log from a broken file, in the order of the log. A later step of the wall clock moves their times. */
  readonly recoveries: readonly LogRecovery[];
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
  own: NO_SHARED,
  imported: NO_SHARED,
  exchanges: {},
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
  recoveries: [],
};

/** This function adds one event to the state. */
export function fold(state: RuntimeState, event: RuntimeEvent, context: FoldContext): RuntimeState {
  const rest = foldRest(state, event, context);
  const parts = event.type === "import" ? partsOf(event.event) : partsOf(event);
  if (parts === undefined) return rest;
  // The merge is a join of a semilattice, thus the view of each copy gets the parts of each side in any order.
  if (event.type === "import") return { ...rest, merge: add(rest.merge, parts), imported: { ...rest.imported, merge: add(rest.imported.merge, parts) } };
  const own = add(rest.own.merge, parts);
  return { ...rest, merge: hasImports(rest) ? add(rest.merge, parts) : own, own: { ...rest.own, merge: own } };
}

/**
 * This function gives the state of the events of a log, in their order. It equals a fold of each
 * event. The merge is a join of a semilattice, thus the function joins all the parts once, at the end.
 */
export function rebuild(events: Iterable<RuntimeEvent>, context: FoldContext): RuntimeState {
  let state = EMPTY_RUNTIME;
  const own = collector();
  const imported = collector();
  for (const event of events) {
    state = foldRest(state, event, context);
    // A step moves the own parts before it, as the fold moves its own merge state. The parts after it are in the new frame.
    if (event.type === "clock") own.shift(event.size);
    if (event.type === "import") imported.push(partsOf(event.event));
    else own.push(partsOf(event));
  }
  const sides = { own: { ...state.own, merge: normalize(own.parts) }, imported: { ...state.imported, merge: normalize(imported.parts) } };
  return { ...state, ...sides, ...joined(sides.own, sides.imported) };
}

// The parts of one side of a rebuild, in the order of the log.
function collector(): { readonly parts: MergeParts; push(parts: MergeParts | undefined): void; shift(size: Duration): void } {
  const reports: Report[] = [];
  const deliveries: Delivery[] = [];
  const acks: Acknowledgment[] = [];
  const ends: EndMark[] = [];
  return {
    parts: { reports, deliveries, acks, ends },
    push(parts) {
      reports.push(...(parts?.reports ?? []));
      deliveries.push(...(parts?.deliveries ?? []));
      acks.push(...(parts?.acks ?? []));
      ends.push(...(parts?.ends ?? []));
    },
    shift(size) {
      for (let index = 0; index < reports.length; index += 1) reports[index] = shiftReport(reports[index]!, size);
      for (let index = 0; index < deliveries.length; index += 1) deliveries[index] = shiftDelivery(deliveries[index]!, size);
      for (let index = 0; index < ends.length; index += 1) ends[index] = shiftEndMark(ends[index]!, size);
    },
  };
}

// The merge state has no part.
function emptyMerge(merge: MergeState): boolean {
  return merge.reports.length + merge.deliveries.length + merge.acks.length + merge.ends.length + merge.retired.length === 0;
}

// The state has a part of another copy.
function hasImports(state: RuntimeState): boolean {
  return !emptyMerge(state.imported.merge) || state.imported.escalationEnds.length > 0;
}

// The views of each copy: the join of the two sides. Without imports, the views are the own side.
function joined(own: SharedState, imported: SharedState): Pick<RuntimeState, "merge" | "escalationEnds"> {
  return {
    merge: emptyMerge(imported.merge) ? own.merge : join(own.merge, imported.merge),
    escalationEnds: joinedEnds(own, imported),
  };
}

// The ends of the escalations of each copy: the own ends, then the imported ends. It does not join the merge states.
function joinedEnds(own: SharedState, imported: SharedState): readonly EscalationEnd[] {
  return imported.escalationEnds.length === 0 ? own.escalationEnds : [...own.escalationEnds, ...imported.escalationEnds];
}

// The parts of the merge in an event.
function partsOf(event: RuntimeEvent | SharedEvent): MergeParts | undefined {
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
    case "escalation-end": {
      const own = { ...state.own, escalationEnds: [...state.own.escalationEnds, event.end] };
      return { ...base, own, escalationEnds: joinedEnds(own, state.imported) };
    }
    case "cancelled":
      return state.cancelled.includes(event.delivery) ? base : { ...base, cancelled: [...state.cancelled, event.delivery].sort(compareCodeUnits) };
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
    case "recovered": {
      const recoveries = [...state.recoveries, { at: event.time, quarantine: event.quarantine, kept: event.added, lost: event.lost, whole: event.whole }];
      // The salvage can lose an import and keep the position after it. Thus the next read of each other copy starts at 0.
      return { ...base, recoveries, exchanges: {} };
    }
    case "import":
      return foldImport(state, event);
    case "exchange":
      return { ...base, exchanges: { ...state.exchanges, [event.peer]: { log: event.log, next: event.next } } };
    default:
      return base;
  }
}

/**
 * The change of an import other than the merge. It changes only the shared state: the cancels, the ends of the
 * escalations and the refusals of a delivered key. The time of the state stays, because the instants of the import come
 * from the clock of another copy.
 */
function foldImport(state: RuntimeState, { event }: ImportEvent): RuntimeState {
  switch (event.type) {
    case "delivery":
      return { ...state, refusals: without(state.refusals, event.delivery.key) };
    case "cancelled":
      return state.cancelled.includes(event.delivery) ? state : { ...state, cancelled: [...state.cancelled, event.delivery].sort(compareCodeUnits) };
    case "escalation-end": {
      const imported = { ...state.imported, escalationEnds: [...state.imported.escalationEnds, event.end] };
      return { ...state, imported, escalationEnds: joinedEnds(state.own, imported) };
    }
    default:
      return state;
  }
}

/**
 * This function moves each own instant of a state by the size of a step of the wall clock. The instants of the sources
 * and the channels do not move: `shiftMerge` of the core tells which instants of the merge move. The cursors, the
 * lines of the system reports and the counts hold no own instant. The imported state has the instants of other clocks,
 * thus it does not move.
 */
export function shiftState(state: RuntimeState, size: Duration): RuntimeState {
  const health = Object.fromEntries(Object.entries(state.health).map(([source, track]) => [source, shiftHealth(track, size)]));
  const fetched = Object.fromEntries(Object.entries(state.fetched).map(([source, at]) => [source, at + size]));
  const refusals = Object.fromEntries(Object.entries(state.refusals).map(([key, refusal]) => [key, { ...refusal, at: refusal.at + size, retryAt: refusal.retryAt + size }]));
  const own: SharedState = { merge: shiftMerge(state.own.merge, size), escalationEnds: state.own.escalationEnds.map((end) => shiftEscalationEnd(end, size)) };
  return {
    ...state,
    ...(state.start === undefined ? {} : { start: state.start + size }),
    time: state.time + size,
    own,
    ...joined(own, state.imported),
    health,
    fetched,
    refusals,
    starts: state.starts.map((start) => shiftEscalationStart(start, size)),
    steps: state.steps.map((step) => ({ ...step, at: step.at + size })),
    recoveries: state.recoveries.map((recovery) => ({ ...recovery, at: recovery.at + size })),
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
