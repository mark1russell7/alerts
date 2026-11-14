/**
 * The contracts of the alert system: the event, the source and the channel.
 *
 * The text of `docs/CONTRACTS.md` explains each part. All values are JSON values, so each type
 * crosses a procedure call, a log row and a copy of the system without a change.
 */

// =============================================================================
// Time, ids and references
// =============================================================================

/** This type is a time in milliseconds since the Unix epoch, in UTC. */
export type Instant = number;

/** This type is a length of time in milliseconds. */
export type Duration = number;

declare const brand: unique symbol;
/** This type gives a string a name, so that two kinds of id do not mix. */
export type Id<Name extends string> = string & { readonly [brand]: Name };

/** The id of a source adapter, for example `nws-api`. */
export type SourceId = Id<"SourceId">;
/** The id of a delivery channel, for example `pushover`. */
export type ChannelId = Id<"ChannelId">;
/** The id of one raw message from a source: the SHA-256 of its content, in hex. `observationId` makes it. */
export type ObservationId = Id<"ObservationId">;
/** The id of one report: the SHA-256 of the source id, the source key and the sent time, in hex. `reportId` makes it. */
export type ReportId = Id<"ReportId">;
/** The id of a person that the system watches over. The private configuration resolves it. */
export type PersonId = Id<"PersonId">;
/** The id of a place that the system watches. The private configuration resolves it. */
export type PlaceId = Id<"PlaceId">;

// =============================================================================
// The event: CAP 1.2 values, in lower case
// =============================================================================

/** The CAP status. Only `actual` can alert a person. */
export type Status = "actual" | "exercise" | "system" | "test" | "draft";

/** The CAP message type, without `ack` and `error`. */
export type Operation = "alert" | "update" | "cancel";

/** The CAP severity. */
export type Severity = "extreme" | "severe" | "moderate" | "minor" | "unknown";

/** The CAP urgency. */
export type Urgency = "immediate" | "expected" | "future" | "past" | "unknown";

/** The CAP certainty. */
export type Certainty = "observed" | "likely" | "possible" | "unlikely" | "unknown";

/** The CAP response type. */
export type ResponseType =
  | "shelter"
  | "evacuate"
  | "prepare"
  | "execute"
  | "avoid"
  | "monitor"
  | "assess"
  | "allclear"
  | "none";

/** The CAP categories, and four more: cyber, market, civic and system. */
export type Category =
  | "geo"
  | "met"
  | "safety"
  | "security"
  | "rescue"
  | "fire"
  | "health"
  | "env"
  | "transport"
  | "infra"
  | "cbrne"
  | "other"
  | "cyber"
  | "market"
  | "civic"
  | "system";

/** The stage of a hazard message. NWS VTEC gives it the name significance. */
export type Significance = "warning" | "watch" | "advisory" | "statement" | "outlook" | "observation";

/** The kind of an event in the taxonomy of the system. */
export interface Kind {
  /** A dotted code of the taxonomy, for example `met.tornado` or `infra.power.outage`. */
  readonly code: string;
  /** The stage, when the source gives one. */
  readonly significance?: Significance;
  /** The name that the source gives, for example `Tornado Warning`. */
  readonly label: string;
}

/** A position as in GeoJSON (RFC 7946): longitude, then latitude, in degrees (WGS 84). */
export type Position = readonly [lon: number, lat: number];

/**
 * The code of a region in one system of codes: `state`, `same`, `ugc`, `fips`, `iso3166` and others. The
 * system `ugc` holds the NWS zones and counties (`KSZ083`, `KSC173`). The system `same` holds the
 * SAME county codes (`020173`).
 */
export interface RegionCode {
  readonly system: string;
  readonly code: string;
}

/** One area of an event. */
export type Area =
  /** A polygon. The first ring is the outside. Each ring closes on its first position. */
  | { readonly type: "polygon"; readonly rings: readonly (readonly Position[])[] }
  /** A circle on the ground. */
  | { readonly type: "circle"; readonly center: Position; readonly radiusKm: number }
  /** A region by its code. */
  | ({ readonly type: "code" } & RegionCode);

/** A thing that an event is about, other than a place: a service, a cloud region, a market. */
export interface Subject {
  /** The system of the id, for example `cloud`, `service` or `market`. */
  readonly system: string;
  /** The id in that system, for example `aws/us-east-1`. */
  readonly id: string;
  readonly label?: string;
}

/**
 * A key that two sources share for one real event: an NWS VTEC event (office, phenomenon,
 * significance, event number and year), a USGS event id, and others. A shared key links two
 * reports into one incident with no doubt.
 */
export interface CorrelationKey {
  readonly system: string;
  readonly id: string;
}

/** One raw message as a source gave it. The log keeps each observation. */
export interface Observation {
  readonly id: ObservationId;
  readonly source: SourceId;
  /** The time at which the adapter got the message. */
  readonly fetched: Instant;
  readonly contentType: string;
  /** The body as text. A binary body is in base64, and `contentType` tells it. */
  readonly body: string;
  /** The facts of the transport. */
  readonly transport: {
    readonly url?: string;
    readonly status?: number;
    readonly latency: Duration;
    readonly etag?: string;
    readonly lastModified?: string;
  };
}

/**
 * One report: one message of one source, in the one format of the system. A report does not
 * change. An update or a cancel of the source is a new report.
 */
export interface Report {
  readonly id: ReportId;
  readonly source: SourceId;
  /** The id that the source gives to the message (the CAP identifier). */
  readonly key: string;
  /** The keys of the same source that this report updates or cancels (the CAP references). */
  readonly references: readonly string[];
  /** The keys that other sources also give for the same real event. */
  readonly correlation: readonly CorrelationKey[];
  readonly status: Status;
  readonly op: Operation;
  readonly kind: Kind;
  readonly categories: readonly Category[];
  readonly severity: Severity;
  readonly urgency: Urgency;
  readonly certainty: Certainty;
  readonly response: readonly ResponseType[];
  /** The time at which the source sent the message. */
  readonly sent: Instant;
  /** The time at which the adapter got the message. */
  readonly received: Instant;
  readonly effective?: Instant;
  readonly onset?: Instant;
  readonly expires?: Instant;
  /** The time at which the event ends, when the source tells it apart from `expires`. */
  readonly ends?: Instant;
  /** The areas of the event. An empty list: the event has no place. */
  readonly areas: readonly Area[];
  readonly areaText?: string;
  readonly about: readonly Subject[];
  /** The authority that sent the message, for example `NWS Boston/Norton MA`. */
  readonly sender: string;
  readonly headline: string;
  readonly description?: string;
  readonly instruction?: string;
  readonly web?: string;
  /** The observation that the map function made this report from. */
  readonly observation: ObservationId;
  /** The name and value pairs of the source that the core does not know (the CAP parameters). */
  readonly parameters: Readonly<Record<string, readonly string[]>>;
}

// =============================================================================
// The source contract
// =============================================================================

/** How a source gives its data. */
export type Transport = "poll" | "stream" | "push" | "radio";

/**
 * A resource of the cell. The cell is the copy of the system on one machine. Each source of the
 * cell uses the same internet link, the same power and the same receivers. So the fault of a
 * resource is a common fault of the cell, not the fault of one source.
 */
export type CellResource = "internet" | "power" | "receiver";

/** The facts of a source. The core uses them for the schedule, the health and the coverage. */
export interface SourceDescriptor {
  readonly id: SourceId;
  readonly title: string;
  /** The authorities whose messages the source carries, for example `nws` or `usgs`. */
  readonly origins: readonly string[];
  /**
   * The failure domains outside the cell that the source needs: providers, CDNs, transmitters and
   * regions. Examples: `provider:nws-api`, `cdn:akamai`, `rf:nwr`. Two sources with a shared
   * domain are not independent for coverage. Do not put the resources of the cell here.
   */
  readonly dependsOn: readonly string[];
  /**
   * The resources of the cell that the source uses. An internet source uses `internet` and
   * `power`. A radio source uses `receiver` and `power`.
   */
  readonly uses: readonly CellResource[];
  /** The prefixes of the taxonomy codes that the source covers, for example `met` and `hydro`. */
  readonly kinds: readonly string[];
  /** The areas that the source covers, or `global`. */
  readonly coverage: readonly Area[] | "global";
  readonly transport: Transport;
  /** The time between two fetches in normal work. */
  readonly interval: Duration;
  /** The longest time that a fetch takes before the health is `slow`. */
  readonly slowAfter: Duration;
  /**
   * The longest normal time with no new message. Absent: a quiet source is normal, as an alert
   * feed with no alert.
   */
  readonly maxQuiet?: Duration;
  readonly auth: "none" | "key" | "oauth";
  /** A plain sentence of the canary check, when the source has one. */
  readonly canary?: string;
}

/**
 * A place that the system watches, as the adapters see it. It holds no name and no address. A source
 * fetches by the region codes, and the core matches the places on the machine of the instance.
 */
export interface WatchedPlace {
  readonly id: PlaceId;
  /** The position of the place. Absent unless the owner lets this source get positions. */
  readonly at?: Position;
  /** The codes of the regions that contain the place: NWS zones, the county, SAME. */
  readonly codes: readonly RegionCode[];
  /** The distance around the place that the system also watches. */
  readonly bufferKm: number;
}

/** What a fetch asks for. */
export interface Watch {
  readonly places: readonly WatchedPlace[];
  /** The prefixes of the taxonomy codes. Absent: all kinds of the source. */
  readonly kinds?: readonly string[];
}

/** The state that a source keeps between two fetches: an ETag, a time, a sequence number. */
export type Cursor = Readonly<Record<string, string>>;

/** Why a fetch failed. */
export type FetchFailure =
  | { readonly kind: "network" | "timeout" | "server"; readonly message: string; readonly retryAfter?: Duration }
  | { readonly kind: "rate-limited"; readonly message: string; readonly retryAfter?: Duration }
  | { readonly kind: "auth" | "refused"; readonly message: string };

/** The result of one fetch. */
export type FetchOutcome =
  | {
      readonly ok: true;
      readonly observations: readonly Observation[];
      readonly cursor?: Cursor;
      /**
       * True: the source answered in full. An empty list with `complete` true means "no message",
       * not "no answer".
       */
      readonly complete: boolean;
    }
  | { readonly ok: false; readonly failure: FetchFailure };

/** A part of a message that the map function did not understand. Problems tell of a format change. */
export interface MapProblem {
  /** The path in the message, for example `features[3].properties.onset`. */
  readonly path: string;
  readonly message: string;
  /** True: the map function could not make a report from the message. */
  readonly fatal: boolean;
}

/** The result of the map function. */
export interface MapResult {
  readonly reports: readonly Report[];
  readonly problems: readonly MapProblem[];
}

/** The result of the canary check of a source. */
export interface CanaryResult {
  readonly pass: boolean;
  readonly reason: string;
}

/**
 * The procedures of one source. Each source package registers them under the path
 * `alerts.source.<id>.<name>`.
 *
 * - `describe`: no effects.
 * - `fetch`: it reads `network`, through polite-crawler. It is idempotent. For a failure of the
 *   source, it gives `{ ok: false }` and does not throw.
 * - `map`: a pure, total function. It does not throw, and the same observation gives the same
 *   reports with the same ids.
 * - `check`: a pure function. It examines the observations of a fetch against the canary.
 * - `locate`: optional. It reads `network` and is idempotent. It gives the region codes of a
 *   position, for a source that has a lookup: the `/points` query of the NWS API.
 *
 * The `map` function gives a promise, because the ids are SHA-256 hashes from WebCrypto. It stays
 * pure and total.
 */
export interface SourceProcedures {
  describe(): SourceDescriptor;
  fetch(input: { readonly watch: Watch; readonly cursor?: Cursor }): Promise<FetchOutcome>;
  map(input: { readonly observation: Observation }): Promise<MapResult>;
  check?(input: { readonly observations: readonly Observation[] }): CanaryResult;
  locate?(input: { readonly at: Position }): Promise<LocateOutcome>;
}

/** The result of a lookup of the region codes of a position. */
export type LocateOutcome =
  | { readonly ok: true; readonly codes: readonly RegionCode[] }
  | { readonly ok: false; readonly failure: FetchFailure };

// =============================================================================
// Health and coverage (the core calculates them, not the adapter)
// =============================================================================

/** The health of a source. */
export type HealthState = "unknown" | "healthy" | "slow" | "failing" | "silent" | "changed";

/** The health of one source at one time. */
export interface SourceHealth {
  readonly source: SourceId;
  readonly state: HealthState;
  readonly since: Instant;
  readonly lastSuccess?: Instant;
  readonly lastFailure?: { readonly at: Instant; readonly failure: FetchFailure };
  readonly reason: string;
}

/** The sources that cover one kind at one place at this time. */
export interface Coverage {
  readonly place: PlaceId;
  readonly kind: string;
  /** The healthy sources that cover the kind at the place. */
  readonly sources: readonly SourceId[];
  /**
   * The smallest count of outside failure domains whose faults stop each of these sources. At 2
   * or more, no single outside fault stops the coverage.
   */
  readonly independent: number;
  /**
   * The resources of the cell that each of these sources uses. One fault of one of them stops all
   * of these sources in this cell.
   */
  readonly commonResources: readonly CellResource[];
  /** The count that the policy needs. A smaller count is a coverage alert. */
  readonly required: number;
}

// =============================================================================
// Incidents (the core makes them from the reports)
// =============================================================================

/**
 * One real event, made from one or more reports. The core calculates each incident from the
 * merge state alone, so each copy of the system gets the same incidents.
 */
export interface Incident {
  /** The smallest report id of the incident. It changes when two incidents merge. */
  readonly anchor: ReportId;
  readonly reports: readonly ReportId[];
  readonly kind: Kind;
  readonly severity: Severity;
  readonly urgency: Urgency;
  readonly certainty: Certainty;
  readonly onset?: Instant;
  readonly expires?: Instant;
  readonly areas: readonly Area[];
  readonly about: readonly Subject[];
  /** False when each line of reports is cancelled or expired. */
  readonly live: boolean;
  /** The count of independent origins that report the event. */
  readonly corroboration: number;
}

// =============================================================================
// Delivery: the level, the message and the channel contract
// =============================================================================

/**
 * The level of an alert.
 * - `life-safety`: it wakes the person, sounds through silent mode and escalates until acknowledged.
 * - `urgent`: a push at once, without the break through Do Not Disturb.
 * - `notice`: a push in the day, else the digest.
 * - `digest`: the next digest.
 */
export type Level = "life-safety" | "urgent" | "notice" | "digest";

/** The order of the levels, from the lowest. */
export const LEVELS: readonly Level[] = ["digest", "notice", "urgent", "life-safety"];

/** The facts of a channel. The core uses them for the escalation and the coverage of delivery. */
export interface ChannelDescriptor {
  readonly id: ChannelId;
  readonly title: string;
  /** The failure domains that the channel needs, for example `provider:pushover` and `provider:apns`. */
  readonly dependsOn: readonly string[];
  /** True: the channel can sound through silent mode and Do Not Disturb. */
  readonly breaksThrough: boolean;
  /** True: the channel repeats a message by itself until the person acknowledges it. */
  readonly repeats: boolean;
  /** How the channel tells of an acknowledgment: not at all, by a receipt to poll, or by a callback. */
  readonly ack: "none" | "poll" | "callback";
  readonly maxTitle: number;
  readonly maxBody: number;
  /** The cost of one message, when the channel costs money. */
  readonly costUsd?: number;
}

/** One message to one person on one channel. */
export interface Message {
  /**
   * The delivery key: the SHA-256 of the incident anchor, the level, the person and the step. `messageKey` makes it.
   * A channel that can drop a repeated key does so.
   */
  readonly key: string;
  readonly person: PersonId;
  readonly level: Level;
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  /** A report of the incident: its anchor at the time of the send. */
  readonly incident: ReportId;
  /** The time after which the message has no use. */
  readonly expires?: Instant;
}

/** The address of a person on a channel, from the private configuration. The repo does not hold an address. */
export type Address = Readonly<Record<string, string>>;

/** The receipt of a sent message, as the channel gives it. */
export type Receipt = Readonly<Record<string, string>>;

/** The result of a send. */
export type SendOutcome =
  | { readonly ok: true; readonly receipt: Receipt; readonly accepted: Instant }
  | {
      readonly ok: false;
      readonly kind: "network" | "timeout" | "server" | "rate-limited" | "auth" | "refused";
      readonly message: string;
      readonly retryAfter?: Duration;
    };

/** The state of a sent message. */
export type DeliveryState = "accepted" | "delivered" | "acknowledged" | "expired" | "failed";

/** The state of a sent message, as the channel tells it. */
export interface DeliveryStatus {
  readonly state: DeliveryState;
  readonly at: Instant;
  /** The device or the person that acknowledged, when the channel tells it. */
  readonly by?: string;
  readonly reason?: string;
}

/**
 * The procedures of one channel. Each channel package registers them under the path
 * `alerts.channel.<id>.<name>`. The core does the escalation and the acknowledgment, not the channel.
 *
 * - `describe`: no effects.
 * - `send`: it writes `network`. It is not idempotent, unless the channel drops a repeated key.
 * - `status`: it reads `network`.
 * - `cancel`: it writes `network`. It stops the repeats of a message. It is idempotent.
 */
export interface ChannelProcedures {
  describe(): ChannelDescriptor;
  send(input: { readonly message: Message; readonly address: Address }): Promise<SendOutcome>;
  status(input: { readonly receipt: Receipt }): Promise<DeliveryStatus>;
  cancel(input: { readonly receipt: Receipt }): Promise<void>;
}

/** One step of an escalation: a channel, and the wait after the step before it. */
export interface EscalationStep {
  readonly channel: ChannelId;
  /** The time from the start of the escalation to this step. */
  readonly at: Duration;
}

/** The escalation of one level: the steps, until a person acknowledges. */
export interface EscalationPolicy {
  readonly level: Level;
  readonly steps: readonly EscalationStep[];
  /** The time after the last step at which the escalation is exhausted. Exhausted is a system alert. */
  readonly exhaustedAfter: Duration;
}

/** An acknowledgment from a person, by any channel or the UI. It stops the escalation of the level. */
export interface Acknowledgment {
  /** A report of the incident. The ack applies to the incident that holds this report, also after a merge. */
  readonly incident: ReportId;
  readonly level: Level;
  readonly person: PersonId;
  readonly at: Instant;
  readonly via: ChannelId | "ui";
}
