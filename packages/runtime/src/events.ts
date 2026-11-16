/**
 * This module holds the events of the log of the runtime. The state of the runtime is a fold of these
 * events and the configuration, and of nothing else. Thus a restart reads the log and gets the same
 * state as a run with no restart.
 */
import type { Acknowledgment, ChannelId, Cursor, Delivery, Duration, EscalationEnd, EscalationStart, FetchRecord, Instant, MapProblem, Observation, Report, ReportId, SendOutcome, SourceId } from "@mark1russell7/alerts";

/** The kind of a failed call of a channel. */
export type ChannelFailureKind = Extract<SendOutcome, { readonly ok: false }>["kind"];

/** The kinds of a send that the channel refused. After such a send, the channel has no message. */
export type RefusalKind = Exclude<ChannelFailureKind, "network" | "timeout" | "server">;

/** The fields of each event. The log of `@mark1russell7/sqlite` reads `id`, `at` and `type`. */
interface Envelope<T extends string> {
  /** The id of the event. The log keeps one event for each id, thus an append that repeats changes nothing. */
  readonly id: string;
  /** The time of the event as an ISO 8601 text, for a person who reads the file. */
  readonly at: string;
  readonly type: T;
  /** The time of the event in milliseconds since the epoch. The fold reads this value, not `at`. */
  readonly time: Instant;
}

/** A run of the runtime starts. The first start is the start of the health of each source. */
export interface StartedEvent extends Envelope<"started"> {
  readonly run: string;
}

/** A new observation of a source. Its id is the id of the observation, thus a repeat is not new. */
export interface ObservationEvent extends Envelope<"observation"> {
  readonly observation: Observation;
}

/** The end of one fetch: the record for the health, the next cursor, and the reports of the new observations. */
export interface FetchEvent extends Envelope<"fetch"> {
  readonly record: FetchRecord;
  readonly cursor?: Cursor;
  readonly reports: readonly Report[];
  /** The problems of the map of the new observations. */
  readonly problems: readonly MapProblem[];
}

/** Reports of a snapshot source left its complete lists. The merge reads them as ended from the time of the event. */
export interface EndedEvent extends Envelope<"ended"> {
  readonly source: SourceId;
  readonly reports: readonly ReportId[];
  /** The time of the data of the list that ended the reports (`asOf` of the fetch), if the list has a time. */
  readonly asOf?: Instant;
}

/** Reports of a snapshot source that ended are in a complete list of the source again. The merge reads them as live. */
export interface BackEvent extends Envelope<"back"> {
  readonly source: SourceId;
  readonly reports: readonly ReportId[];
}

/** One step of the system reports, with the observation of each report. */
export interface SystemEvent extends Envelope<"system"> {
  readonly reports: readonly Report[];
  readonly observations: readonly Observation[];
}

/** One accepted send. */
export interface DeliveryEvent extends Envelope<"delivery"> {
  readonly delivery: Delivery;
  /** The copy id of the accepted send, on a channel that repeats. The copy then needs no stop by its copy id. */
  readonly copy?: string;
}

/**
 * A send on a channel that repeats starts. The log keeps its copy id before the send. Thus after a
 * restart, the step stops each copy that has no delivery and no `settled` event.
 */
export interface AttemptEvent extends Envelope<"attempt"> {
  /** The delivery key of the send. */
  readonly key: string;
  readonly channel: ChannelId;
  readonly copy: string;
}

/** A copy needs no stop. The channel refused its send after its time limit, or a stop of the copy ended after the end of its send. */
export interface SettledEvent extends Envelope<"settled"> {
  readonly copy: string;
}

/**
 * The channel refused a send in its time limit. The log keeps the refusal, thus a restart keeps the wait
 * of the retry and the fail of the heartbeat.
 */
export interface RefusedEvent extends Envelope<"refused"> {
  /** The delivery key of the send. */
  readonly key: string;
  readonly channel: ChannelId;
  readonly kind: RefusalKind;
  /** The step sends the key again at this time or later. */
  readonly retryAt: Instant;
  /** The copy id of the send, on a channel that repeats. The refusal ends the copy. */
  readonly copy?: string;
}

/** One acknowledgment of a person. */
export interface AcknowledgmentEvent extends Envelope<"acknowledgment"> {
  readonly acknowledgment: Acknowledgment;
}

/** The repeats of a delivery stopped. The escalation does not cancel it again. */
export interface CancelledEvent extends Envelope<"cancelled"> {
  /** The key of the delivery. */
  readonly delivery: string;
}

/** An escalation started. Its start stays the same after a restart, thus each step comes at its time. */
export interface EscalationEvent extends Envelope<"escalation"> {
  readonly start: EscalationStart;
}

/**
 * The escalations of a person in a live incident ended: the incident no longer reaches the person. A later match of
 * the person starts a new episode.
 */
export interface EscalationEndEvent extends Envelope<"escalation-end"> {
  readonly end: EscalationEnd;
}

/**
 * The wall clock stepped against the monotonic clock, back or forward. The fold moves each own instant of the state by
 * `size`. Thus each timer keeps its distance on the monotonic clock, and a rebuild gives the same state.
 */
export interface ClockEvent extends Envelope<"clock"> {
  /** The size of the step: below 0 for a step back, above 0 for a step forward. */
  readonly size: Duration;
}

/**
 * At the boot, the log file was broken. The runtime moved it into a quarantine folder, and it started a new file with
 * each event that the salvage read. This event comes after the salvaged events. Its fold gives a system report.
 */
export interface RecoveredEvent extends Envelope<"recovered"> {
  /** The name of the quarantine folder, in the folder of the log. The id of the event has it. */
  readonly quarantine: string;
  /** The kind of the fault of the broken file, from `sqliteFault` of `@mark1russell7/sqlite`. An example is `corrupt`. */
  readonly fault: string;
  /** The count of the events that the salvage read and parsed. */
  readonly read: number;
  /** The count of the read events that the new file got. */
  readonly added: number;
  /** The count of the positions of the broken file that the salvage could not read or parse. */
  readonly lost: number;
  /** This value tells if the salvage read each part of the broken file with no problem. */
  readonly whole: boolean;
  /** The first problems of the check and of the salvage, in this order. */
  readonly problems: readonly string[];
}

/** One event of the log of the runtime. */
export type RuntimeEvent =
  | StartedEvent
  | ObservationEvent
  | FetchEvent
  | EndedEvent
  | BackEvent
  | SystemEvent
  | EscalationEvent
  | EscalationEndEvent
  | DeliveryEvent
  | AcknowledgmentEvent
  | CancelledEvent
  | AttemptEvent
  | SettledEvent
  | RefusedEvent
  | ClockEvent
  | RecoveredEvent;

/** The types of the events. */
export const EVENT_TYPES: readonly RuntimeEvent["type"][] = [
  "started",
  "observation",
  "fetch",
  "ended",
  "back",
  "system",
  "escalation",
  "escalation-end",
  "delivery",
  "acknowledgment",
  "cancelled",
  "attempt",
  "settled",
  "refused",
  "clock",
  "recovered",
];

/**
 * This function gives the frame tag of an id with a time of the runtime. The tag is empty before the first step of
 * the wall clock, and `~<count of steps>` after it. Thus a time that comes again after a step back gives a new id.
 */
export function frameTag(steps: number): string {
  return steps === 0 ? "" : `~${steps}`;
}

/** This function gives the fields of the envelope of an event at a time. */
export function envelope<T extends RuntimeEvent["type"]>(type: T, id: string, time: Instant): Envelope<T> {
  return { id, at: new Date(time).toISOString(), type, time };
}

/**
 * This function changes a stored JSON value into an event, and throws for a value that is not one.
 * It examines only the envelope and the type. The log holds only the events of the runtime, and
 * SQLite examines the integrity of the file.
 */
export function parseEvent(value: unknown): RuntimeEvent {
  const event = value as Partial<Envelope<string>> | null;
  if (
    typeof event !== "object" ||
    event === null ||
    typeof event.id !== "string" ||
    typeof event.at !== "string" ||
    typeof event.time !== "number" ||
    !Number.isFinite(event.time) ||
    !(EVENT_TYPES as readonly unknown[]).includes(event.type)
  ) {
    throw new TypeError(`The log has a value that is not an event of the runtime: ${JSON.stringify(value)?.slice(0, 200)}`);
  }
  return value as RuntimeEvent;
}
