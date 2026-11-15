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

/**
 * The key of the area block of a message, for example the path `info[0].area[1]` of a CAP `area` element. The
 * areas of one block tell one area together: the shapes of a block decide for that block. In a report,
 * the adapter writes a key that is unique in the report. In an incident, the merge puts the report id
 * before the key, so the blocks of two reports stay apart. An area with no key is in no block.
 */
export interface AreaBlock {
  readonly block?: string;
}

/** One area of an event. */
export type Area =
  /** A polygon. The first ring is the outside. Each ring closes on its first position. */
  | ({ readonly type: "polygon"; readonly rings: readonly (readonly Position[])[] } & AreaBlock)
  /** A circle on the ground. */
  | ({ readonly type: "circle"; readonly center: Position; readonly radiusKm: number } & AreaBlock)
  /** A region by its code. */
  | ({ readonly type: "code" } & RegionCode & AreaBlock)
  /**
   * A watched place of the configuration. Only the reports of the core use it, for example a gap of
   * the coverage at that place. An adapter does not know the places.
   */
  | { readonly type: "place"; readonly place: PlaceId };

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
  /**
   * The authority that issued the message: one of the `origins` of the source descriptor, for
   * example `nws` or `usgs`. The corroboration of an incident counts the different origins.
   */
  readonly origin: string;
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
  /** The authority that sent the message, for example `NWS Topeka KS`. */
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

/** The resources of the cell, in their order in a report. */
export const CELL_RESOURCES: readonly CellResource[] = ["internet", "power", "receiver"];

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
  /**
   * `snapshot`: each complete fetch gives all the messages that are in effect, and a message that ends
   * leaves the list with no cancel. Then the runtime ends a report that is absent from complete fetches.
   * Absent: a stream. A message stays until its cancel or its expiry.
   */
  readonly listing?: "snapshot";
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
  /**
   * The codes of the regions that contain the place: the NWS zones and county, SAME, the state
   * (`state`) and the country (`iso3166`). The coverage of a source can name a region at each level.
   */
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
      /**
       * The time of the data of a complete list of a snapshot source: the time of its newest product. A cache can give an
       * old list, and this time tells its age. The runtime reads a list with no time as current.
       */
      readonly asOf?: Instant;
    }
  | { readonly ok: false; readonly failure: FetchFailure };

/**
 * A part of a message that the map function did not understand. Problems tell of a format change. A
 * problem has one of three effects. A fatal problem gives no report. A lossy problem gives a report that
 * lacks a value of the message, or holds a fallback in its place. A note gives a whole report.
 */
export interface MapProblem {
  /** The path in the message, for example `features[3].properties.onset`. */
  readonly path: string;
  readonly message: string;
  /** True: the map function could not make a report from the message. */
  readonly fatal: boolean;
  /**
   * True: the report lacks a value of the message, or holds a fallback in its place. The field is
   * absent for a note and for a fatal problem.
   */
  readonly lossy?: true;
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
 * The record of one fetch of a source. The runtime writes one record when each fetch ends, and the
 * core calculates the health of the source from the records.
 */
export interface FetchRecord {
  readonly source: SourceId;
  /** The time at which the fetch started. */
  readonly at: Instant;
  /** The time that the fetch took. */
  readonly took: Duration;
  /** The failure of the fetch. It is absent when the fetch passed. */
  readonly failure?: FetchFailure;
  /** The count of observations of the fetch that the log did not have before. */
  readonly fresh: number;
  /** The count of fatal problems that the map gave for the observations of the fetch. */
  readonly fatal: number;
  /** The count of lossy problems that the map gave for the observations of the fetch. An absent count is 0. */
  readonly lossy?: number;
  /** The result of the canary check of the observations of the fetch, when the source has a canary. */
  readonly canary?: CanaryResult;
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
 */
export interface SourceProcedures {
  describe(): SourceDescriptor;
  fetch(input: { readonly watch: Watch; readonly cursor?: Cursor }): Promise<FetchOutcome>;
  map(input: { readonly observation: Observation }): MapResult;
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
  /** The sources that are up and cover the kind at the place. */
  readonly sources: readonly SourceId[];
  /**
   * The smallest count of outside failure domains whose faults stop each of these sources. At 2
   * or more, no single outside fault stops the coverage.
   */
  readonly independent: number;
  /**
   * The search of the smallest count ended. When it is false, the search passed its budget. Then
   * `independent` is the count of a set that the search found, and the true count can be smaller.
   */
  readonly proven: boolean;
  /** The outside failure domains of the smallest set: one fault of each stops each of these sources. */
  readonly faults: readonly string[];
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
 * merge state and a time, so each copy of the system gets the same incidents.
 */
export interface Incident {
  /** The smallest report id of the incident. It changes when two incidents merge. */
  readonly anchor: ReportId;
  /** The report ids of the incident, from the smallest. */
  readonly reports: readonly ReportId[];
  /** The status of each report of the incident. Reports of two statuses are not in one incident. */
  readonly status: Status;
  readonly kind: Kind;
  readonly severity: Severity;
  readonly urgency: Urgency;
  readonly certainty: Certainty;
  readonly onset?: Instant;
  readonly expires?: Instant;
  readonly areas: readonly Area[];
  readonly about: readonly Subject[];
  /** False when each line of reports is cancelled, expired or ended at the time of the calculation. */
  readonly live: boolean;
  /** The count of different origins that report the event. */
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
  /**
   * The failure domains outside the cell that the channel needs, for example `provider:pushover` and
   * `provider:apns`. Do not put the resources of the cell here.
   */
  readonly dependsOn: readonly string[];
  /**
   * The resources of the cell that the channel uses. A push or a text through an API uses
   * `internet` and `power`. Thus a fault of the internet link stops each source and each such
   * channel together.
   */
  readonly uses: readonly CellResource[];
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
  /**
   * True: the channel sends the message in its silent mode, for example Pushover priority `-1`, or a
   * text and no call. The escalation sets it in the quiet window of the person. A `life-safety`
   * message is not quiet at any time. The channel keeps no rule of its own about the time of day.
   */
  readonly quiet: boolean;
  /**
   * True: the message tells of the entry of a channel into the reserve of its quota. The channel can send
   * it from the reserve, one time in each window. `messageOf` sets it.
   */
  readonly useReserve?: boolean;
}

/** The address of a person on a channel, from the private configuration. The repo does not hold an address. */
export type Address = Readonly<Record<string, string>>;

/** The receipt of a sent message, as the channel gives it. */
export type Receipt = Readonly<Record<string, string>>;

/**
 * The stages of the quota of a channel. Each stage is a line of system reports:
 *
 * - `low`: the window has 2 reserves of units or fewer left.
 * - `reserve`: the window has the reserve or fewer left. The channel sends only `life-safety`.
 * - `spent`: the provider refuses each message, also a `life-safety` message.
 */
export type QuotaStage = "low" | "reserve" | "spent";

/** The state of the quota of a channel in its window, as the gate of the channel counts it. */
export interface ChannelQuota {
  readonly channel: ChannelId;
  /** The units of one window. */
  readonly limit: number;
  /** The last units of the window. The channel uses them only for `life-safety`. */
  readonly reserve: number;
  /** The units used in the window. */
  readonly used: number;
  /** The end of the window. */
  readonly resetAt?: Instant;
  /** The provider refuses each message until this time. */
  readonly blockedUntil?: Instant;
}

/**
 * The result of a send. A failed send has one of these kinds:
 *
 * - `network`, `timeout` and `server`: the channel can have the message.
 * - `rate-limited`: the provider refuses each message until the retry.
 * - `reserved`: the channel keeps the last units of its quota for a higher level. It still sends a message of that level.
 * - `auth` and `refused`: the provider refused the key or the message.
 */
export type SendOutcome =
  | { readonly ok: true; readonly receipt: Receipt; readonly accepted: Instant }
  | {
      readonly ok: false;
      readonly kind: "network" | "timeout" | "server" | "rate-limited" | "reserved" | "auth" | "refused";
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
  send(input: SendInput): Promise<SendOutcome>;
  status(input: { readonly receipt: Receipt }): Promise<DeliveryStatus>;
  cancel(input: CancelTarget): Promise<void>;
}

/** The input of a send. */
export interface SendInput {
  readonly message: Message;
  readonly address: Address;
  /**
   * The id of this send of the key. Its characters match `COPY_ID`. Each send of a key has a new id.
   * A channel that repeats a message keeps the id with the message. Then `cancel({ copy })` stops this copy only.
   */
  readonly copy?: string;
}

/**
 * The target of a cancel. A receipt stops each copy of its delivery key. A copy id stops one copy
 * whose send did not end, thus the cancel has no receipt of it. The new copy of the key continues.
 */
export type CancelTarget = { readonly receipt: Receipt } | { readonly copy: string };

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

/**
 * One accepted send of one step of an escalation. The merge state keeps each send, so each copy of
 * the system knows the level that a person already got. A send that failed makes no record, so its
 * step stays due.
 */
export interface Delivery {
  /** The key of the message, from `messageKey`. */
  readonly key: string;
  /** A report of the incident: its anchor at the time of the send. */
  readonly incident: ReportId;
  readonly level: Level;
  readonly person: PersonId;
  readonly channel: ChannelId;
  /** The index of the step in the escalation, from 0. */
  readonly step: number;
  /** The time at which the channel accepted the message. */
  readonly at: Instant;
  /** The receipt of the channel, when it gives one. The escalation uses it to cancel or to poll. */
  readonly receipt?: Receipt;
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

// =============================================================================
// The merge state
// =============================================================================

/**
 * A mark of the runtime on a report of a snapshot source. The latest mark of a report at a time tells
 * if the report ended. At one time, a mark with `ended` false wins, so a tie keeps the report live.
 */
export interface EndMark {
  readonly report: ReportId;
  readonly at: Instant;
  /** True: the report left the list of its source. False: the report is in the list again. */
  readonly ended: boolean;
  /** The time of the data of the list that ended the report (`asOf` of the fetch), if the list has a time. */
  readonly asOf?: Instant;
}

/**
 * The merge state: four grow-only sets. The join of two states is their union, so each copy of
 * the system that gets the same parts gets the same state. `normalize` gives the one form of a
 * state. It has one report for each id, in the order of the ids. It has each delivery, each
 * acknowledgment and each end mark one time, in the order of their canonical JSON.
 */
export interface MergeState {
  readonly reports: readonly Report[];
  readonly deliveries: readonly Delivery[];
  readonly acks: readonly Acknowledgment[];
  /** The end marks of the reports of the snapshot sources. */
  readonly ends: readonly EndMark[];
}

// =============================================================================
// The assessment
// =============================================================================

/** The level of an incident for a person, or `none`: no message. */
export type AssessedLevel = Level | "none";

/** The order of the assessed levels, from the lowest. */
export const ASSESSED_LEVELS: readonly AssessedLevel[] = ["none", ...LEVELS];

/**
 * The highest levels for the severity and for the urgency of an incident. The level of the table is the
 * lower of the two values.
 */
export interface LevelTable {
  readonly severity: Readonly<Record<Severity, AssessedLevel>>;
  readonly urgency: Readonly<Record<Urgency, AssessedLevel>>;
}

/** A class of kinds with its own table, for example the kinds that can reach `life-safety`. */
export interface KindClass extends LevelTable {
  readonly id: string;
  /** The prefixes of the taxonomy codes of the class, for example `met.tornado`. */
  readonly kinds: readonly string[];
  /** The statuses that can make a message of this class. Absent: the statuses of the policy. */
  readonly statuses?: readonly Status[];
}

/** The data of the first assessment. A change of the policy is a change of data, not of code. */
export interface AssessPolicy {
  /** The statuses that can make a message, for each class with no statuses of its own. Another status gets `none`. */
  readonly statuses: readonly Status[];
  /** The classes, in order. The first class with a prefix of the kind applies. */
  readonly classes: readonly KindClass[];
  /** The table of each kind that no class has. */
  readonly otherwise: LevelTable;
}

/**
 * A rule of a person: the highest level of the incidents of some kinds at some places. At each
 * place, the first rule that matches the place and the kind applies. With no matching rule, the
 * table level stays.
 */
export interface LevelRule {
  /** The places of the rule. When it is absent, the rule applies at each place of the person. */
  readonly places?: readonly PlaceId[];
  /** The prefixes of the taxonomy codes of the rule. When it is absent, the rule applies to each kind. */
  readonly kinds?: readonly string[];
  readonly max: AssessedLevel;
}

/**
 * The quiet window of a person: a part of each day, in local times of a time zone. In the window,
 * each message below `life-safety` is quiet. A `life-safety` message ignores the window. The shape
 * is that of `TimeWindow` of `@mark1russell7/algebra/clock`, without the days of the week.
 */
export interface QuietWindow {
  /** The IANA name of the time zone, for example `Europe/Berlin`. */
  readonly zone: string;
  /** The start of the window, a local time `HH:MM` from `00:00` to `23:59`. The start is in the window. */
  readonly start: string;
  /** The end of the window, a local time `HH:MM`. The end is not in the window. An end before the start crosses midnight. An end equal to the start gives the full day. */
  readonly end: string;
}

/**
 * A subject that a person watches, other than a place: a source of the system, a service, a cloud
 * region. A watch with no id matches each subject of its system.
 */
export interface SubjectWatch {
  readonly system: string;
  readonly id?: string;
}

/** The places and the rules of one person. The private configuration gives them. */
export interface PersonWatch {
  readonly person: PersonId;
  /** The places that the person watches. */
  readonly places: readonly PlaceId[];
  /**
   * The subjects that the person watches. The health reports of the sources have the subjects of
   * the system `alerts.source`, and the quota reports have the subjects of the system `alerts.channel`. So the
   * person who operates the system watches `{ system: "alerts.source" }` and `{ system: "alerts.channel" }`.
   */
  readonly subjects?: readonly SubjectWatch[];
  /** The rules of the person, in order. */
  readonly rules: readonly LevelRule[];
  /** The quiet window of the person. When it is absent, no message is quiet. */
  readonly quiet?: QuietWindow;
}

/** A measured value with its interval. The interval holds the value: `low <= value <= high`. */
export interface Estimate {
  readonly value: number;
  readonly low: number;
  readonly high: number;
}

/**
 * The priors of one kind of event, from public measures. A field that the measures do not give is
 * absent. Then the shadow score of the kind has no read.
 */
export interface KindPrior {
  /** The share of the warnings of the kind that an event verified, from 0 to 1. It applies to the significance `warning` only. */
  readonly verified?: Estimate;
  /** The deaths in one event of the kind. */
  readonly deaths?: Estimate;
  /** The injuries in one event of the kind. */
  readonly injuries?: Estimate;
}

/**
 * The priors of the shadow score. Each factor comes from a public measure, not from a guess. The
 * format of the file is `alerts-priors/1`.
 */
export interface ScorePriors {
  readonly format: "alerts-priors/1";
  /** The priors of the kinds, by prefixes of the taxonomy codes. For each field, the longest prefix of a kind with that field decides. */
  readonly kinds: Readonly<Record<string, KindPrior>>;
  /** The probability of each CAP certainty value, from 0 to 1. */
  readonly certainty: Readonly<Partial<Record<Certainty, Estimate>>>;
}

/** One factor of a shadow score, with the key of the priors that gave it. */
export interface ScoreFactor {
  readonly estimate: Estimate;
  /** The table of the priors and its key: a prefix of `kinds`, or a value of `certainty`. */
  readonly from: { readonly table: "kinds" | "certainty"; readonly key: string };
}

/** A factor of the shadow score that the priors do not give. */
export type ScoreGap = "probability" | "deaths" | "injuries";

/**
 * The shadow score of an incident: the probability of the event and the harm of one event. The score
 * does not decide a level at this time. The table decides, and the assessment shows the score next to it.
 * A score with a gap has no read, and it shows each factor that the priors do not give.
 */
export type ShadowScore =
  | {
      readonly read: true;
      /** The probability that the event occurs. */
      readonly probability: ScoreFactor;
      /** The deaths in one event of the kind. */
      readonly deaths: ScoreFactor;
      /** The injuries in one event of the kind. */
      readonly injuries: ScoreFactor;
    }
  | { readonly read: false; readonly missing: readonly ScoreGap[] };

/** A reason of an assessment. The UI shows the reasons, so each level tells why. */
export type AssessReason =
  /** Each line of the incident is cancelled or expired. */
  | { readonly kind: "ended" }
  /** The policy does not send incidents of this status. */
  | { readonly kind: "status"; readonly status: Status }
  /** No place of the person is in the areas of the incident. */
  | { readonly kind: "no-place" }
  /** The incident has no area, and the person watches no subject of the incident. */
  | { readonly kind: "no-subject" }
  /**
   * The areas of the incident have no code and no place, and no shape can match. Either the areas have
   * no shape, or no place of the person has a position.
   */
  | { readonly kind: "no-codes" }
  /** The configuration has no watched place for this id of the person. */
  | { readonly kind: "unknown-place"; readonly place: PlaceId }
  /**
   * An area of the incident covers this place. The codes are the codes of the place that decided the match.
   * `distanceKm` is the distance from the place to the nearest shape that decided, and it is 0 in a shape.
   * It is present when that distance is in the buffer of the place. For a match by a shape only, the codes
   * are empty. `shapeRefused` is true when the codes of a block decided because `@mark1russell7/geo`
   * refuses each shape of that block.
   */
  | {
      readonly kind: "place";
      readonly place: PlaceId;
      readonly codes: readonly RegionCode[];
      readonly distanceKm?: number;
      readonly shapeRefused?: true;
    }
  /** The person watches a subject of the incident. */
  | { readonly kind: "subject"; readonly subject: SubjectWatch }
  /** The table gave this level. The class is absent for the table `otherwise`. */
  | {
      readonly kind: "table";
      readonly class?: string;
      readonly bySeverity: AssessedLevel;
      readonly byUrgency: AssessedLevel;
      readonly level: AssessedLevel;
    }
  /**
   * A rule of the person lowered the level at this place. The index is the position of the rule.
   * The place is absent for a subject.
   */
  | { readonly kind: "rule"; readonly place?: PlaceId; readonly index: number; readonly max: AssessedLevel }
  /** The shadow score of the incident. It does not change the level. */
  | { readonly kind: "shadow"; readonly score: ShadowScore };

/** The level of one incident for one person, with its reasons. */
export interface Assessment {
  /** The anchor of the incident at the time of the assessment. */
  readonly incident: ReportId;
  readonly person: PersonId;
  readonly level: AssessedLevel;
  /** The places of the person that the areas of the incident contain. */
  readonly places: readonly PlaceId[];
  readonly reasons: readonly AssessReason[];
}
