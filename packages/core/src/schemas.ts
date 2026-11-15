/**
 * The runtime schemas of the contracts, in zod 4. Each schema checks one data type of `contracts.ts`
 * or `lateness.ts` at a trust boundary. The boundaries are the output of a map function, the event
 * log, the private configuration and the procedure tools.
 *
 * - The TypeScript types stay the source of truth. `schemaOf` holds each schema to its type, so a
 *   drift fails the type check.
 * - Each object is strict, so an unknown key fails. The contract is closed, as the taxonomy is.
 * - Each schema has no transform, so `z.toJSONSchema` converts it. The MCP tools use the JSON Schema.
 * - The rules of the values that a type cannot hold are refinements. Each rule tells the line of the
 *   contract that states it.
 */
import { z } from "zod";
import {
  ASSESSED_LEVELS,
  CELL_RESOURCES,
  LEVELS,
  type Acknowledgment,
  type Address,
  type Area,
  type AssessedLevel,
  type AssessPolicy,
  type AssessReason,
  type Assessment,
  type CanaryResult,
  type Category,
  type CellResource,
  type Certainty,
  type ChannelDescriptor,
  type ChannelId,
  type CorrelationKey,
  type Coverage,
  type Cursor,
  type Delivery,
  type DeliveryState,
  type DeliveryStatus,
  type EndMark,
  type Duration,
  type EscalationPolicy,
  type EscalationStep,
  type FetchFailure,
  type FetchOutcome,
  type FetchRecord,
  type HealthState,
  type Id,
  type Incident,
  type Instant,
  type Kind,
  type KindClass,
  type Level,
  type LevelRule,
  type LevelTable,
  type LocateOutcome,
  type MapProblem,
  type MapResult,
  type Message,
  type Observation,
  type ObservationId,
  type Operation,
  type PersonId,
  type PersonWatch,
  type PlaceId,
  type Position,
  type QuietWindow,
  type Receipt,
  type RegionCode,
  type Report,
  type ReportId,
  type ResponseType,
  type SendOutcome,
  type Severity,
  type Significance,
  type SourceDescriptor,
  type SourceHealth,
  type SourceId,
  type Status,
  type Subject,
  type SubjectWatch,
  type Transport,
  type Urgency,
  type Watch,
  type WatchedPlace,
} from "./contracts.ts";
import { err, ok, tryCatch, type Result } from "@mark1russell7/optional";
import {
  CONFIG_FORMAT,
  loadConfig,
  type AddressValue,
  type AlertConfig,
  type ContactConfig,
  type PersonConfig,
  type PlaceConfig,
  type SecretLookup,
  type SecretRef,
} from "./config.ts";
import type { Recipient } from "./delivery.ts";
import type { Lateness, LatenessLimit, LatenessState } from "./lateness.ts";
import { CATEGORIES, knownKind } from "./taxonomy.ts";

// =============================================================================
// The gate between a schema and its type
// =============================================================================

// This type removes the intersections and the names of the interfaces. It keeps the readonly keys and the optional keys.
type Plain<T> = T extends string | number | boolean | null | undefined ? T : { [K in keyof T]: Plain<T[K]> };

// This type is true when the two types are the same after `Plain`. The comparison of two generic functions finds each difference of a readonly key or an optional key.
type Same<A, B> = (<G>() => G extends Plain<A> ? 1 : 2) extends <G>() => G extends Plain<B> ? 1 : 2 ? true : false;

/** This type is the error of `schemaOf`. The type check shows its key when a schema does not match its type. */
export interface SchemaDrift<T> {
  readonly "The output or the input of this schema is not exactly its type.": T;
}

// This type is `unknown` when the output and the input of the schema are exactly the type. Else it is the error.
type Exact<S extends z.ZodType, T> = Same<z.output<S>, T> extends true ? (Same<z.input<S>, T> extends true ? unknown : SchemaDrift<T>) : SchemaDrift<T>;

/**
 * This function gives a schema the type of its contract. The type check fails when the output or the
 * input of the schema is not exactly the type `T`. The readonly keys and the optional keys must also
 * be the same. The function changes nothing at run time.
 *
 * The package checks its declarations in isolation. Thus each exported schema has the short type
 * `z.ZodType<T, T>`. This function compares the full type of the schema to `T` first.
 */
export function schemaOf<T>(): <S extends z.ZodType<T, T>>(schema: S & Exact<S, T>) => z.ZodType<T, T> {
  return (schema) => schema;
}

// The brand of `contracts.ts` is a `unique symbol` of the types only, and `.brand()` of zod has a different symbol.
// So this cast gives the non-empty string schema the branded type of the id. It is the one cast of this file.
function idSchema<T extends Id<string>>(): z.ZodType<T, T> {
  const nonEmpty: z.ZodType<string, string> = z.string().min(1, "An id is a non-empty string.");
  return nonEmpty as z.ZodType<T, T>;
}

// =============================================================================
// Time, ids and counts
// =============================================================================

/** This schema checks a time in milliseconds since the epoch. A zod number is finite, so it refuses `Infinity` and `NaN`. */
export const instantSchema: z.ZodType<Instant, Instant> = schemaOf<Instant>()(z.number());

/** This schema checks a length of time in milliseconds. A duration is finite, and it is 0 or more. */
export const durationSchema: z.ZodType<Duration, Duration> = schemaOf<Duration>()(z.number().nonnegative("A duration is 0 or more."));

/** This schema checks the id of a source adapter. */
export const sourceIdSchema: z.ZodType<SourceId, SourceId> = idSchema<SourceId>();
/** This schema checks the id of a delivery channel. */
export const channelIdSchema: z.ZodType<ChannelId, ChannelId> = idSchema<ChannelId>();
/** This schema checks the id of an observation. */
export const observationIdSchema: z.ZodType<ObservationId, ObservationId> = idSchema<ObservationId>();
/** This schema checks the id of a report. */
export const reportIdSchema: z.ZodType<ReportId, ReportId> = idSchema<ReportId>();
/** This schema checks the id of a person. */
export const personIdSchema: z.ZodType<PersonId, PersonId> = idSchema<PersonId>();
/** This schema checks the id of a place. */
export const placeIdSchema: z.ZodType<PlaceId, PlaceId> = idSchema<PlaceId>();

// A count and an index are integers, 0 or more. The fields that use it state a count or a position in words.
const count = (): z.ZodInt => z.int().nonnegative("A count is an integer, 0 or more.");

// =============================================================================
// The event
// =============================================================================

/** This schema checks a CAP status. */
export const statusSchema: z.ZodType<Status, Status> = schemaOf<Status>()(z.enum(["actual", "exercise", "system", "test", "draft"]));

/** This schema checks a CAP message type, without `ack` and `error`. */
export const operationSchema: z.ZodType<Operation, Operation> = schemaOf<Operation>()(z.enum(["alert", "update", "cancel"]));

/** This schema checks a CAP severity. */
export const severitySchema: z.ZodType<Severity, Severity> = schemaOf<Severity>()(z.enum(["extreme", "severe", "moderate", "minor", "unknown"]));

/** This schema checks a CAP urgency. */
export const urgencySchema: z.ZodType<Urgency, Urgency> = schemaOf<Urgency>()(z.enum(["immediate", "expected", "future", "past", "unknown"]));

/** This schema checks a CAP certainty. */
export const certaintySchema: z.ZodType<Certainty, Certainty> = schemaOf<Certainty>()(z.enum(["observed", "likely", "possible", "unlikely", "unknown"]));

/** This schema checks a CAP response type. */
export const responseTypeSchema: z.ZodType<ResponseType, ResponseType> = schemaOf<ResponseType>()(
  z.enum(["shelter", "evacuate", "prepare", "execute", "avoid", "monitor", "assess", "allclear", "none"]),
);

/** This schema checks a category. The values come from `CATEGORIES` of the taxonomy. */
export const categorySchema: z.ZodType<Category, Category> = schemaOf<Category>()(z.enum(CATEGORIES));

/** This schema checks the stage of a hazard message. */
export const significanceSchema: z.ZodType<Significance, Significance> = schemaOf<Significance>()(
  z.enum(["warning", "watch", "advisory", "statement", "outlook", "observation"]),
);

/** This schema checks a kind. Its code must be in the taxonomy: `knownKind` gives true. This rule is the runtime gate of the closed taxonomy. */
export const kindSchema: z.ZodType<Kind, Kind> = schemaOf<Kind>()(
  z
    .strictObject({
      code: z.string().refine(knownKind, "The kind code is not in the taxonomy."),
      significance: significanceSchema.exactOptional(),
      label: z.string(),
    })
    .readonly(),
);

/** This schema checks a position: the longitude in [-180, 180], then the latitude in [-90, 90]. */
export const positionSchema: z.ZodType<Position, Position> = schemaOf<Position>()(
  z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).readonly(),
);

/** This schema checks the code of a region in one system of codes. */
export const regionCodeSchema: z.ZodType<RegionCode, RegionCode> = schemaOf<RegionCode>()(
  z.strictObject({ system: z.string(), code: z.string() }).readonly(),
);

/** This schema checks one area of an event: a polygon, a circle, a region code or a watched place. */
export const areaSchema: z.ZodType<Area, Area> = schemaOf<Area>()(
  z
    .discriminatedUnion("type", [
      z.strictObject({ type: z.literal("polygon"), rings: z.array(z.array(positionSchema).readonly()).readonly() }),
      z.strictObject({ type: z.literal("circle"), center: positionSchema, radiusKm: z.number() }),
      z.strictObject({ type: z.literal("code"), system: z.string(), code: z.string() }),
      z.strictObject({ type: z.literal("place"), place: placeIdSchema }),
    ])
    .readonly(),
);

/** This schema checks a thing that an event is about, other than a place. */
export const subjectSchema: z.ZodType<Subject, Subject> = schemaOf<Subject>()(
  z.strictObject({ system: z.string(), id: z.string(), label: z.string().exactOptional() }).readonly(),
);

/** This schema checks a key that two sources share for one real event. */
export const correlationKeySchema: z.ZodType<CorrelationKey, CorrelationKey> = schemaOf<CorrelationKey>()(
  z.strictObject({ system: z.string(), id: z.string() }).readonly(),
);

/** This schema checks one raw message as a source gave it. */
export const observationSchema: z.ZodType<Observation, Observation> = schemaOf<Observation>()(
  z
    .strictObject({
      id: observationIdSchema,
      source: sourceIdSchema,
      fetched: instantSchema,
      contentType: z.string(),
      body: z.string(),
      transport: z
        .strictObject({
          url: z.string().exactOptional(),
          status: z.number().exactOptional(),
          latency: durationSchema,
          etag: z.string().exactOptional(),
          lastModified: z.string().exactOptional(),
        })
        .readonly(),
    })
    .readonly(),
);

/**
 * This schema checks one report. A report has one area or more, or one subject or more. The merge
 * takes the areas of an incident from its heads. So a report with no area and no subject can empty
 * the places of a life-safety incident.
 */
export const reportSchema: z.ZodType<Report, Report> = schemaOf<Report>()(
  z
    .strictObject({
      id: reportIdSchema,
      source: sourceIdSchema,
      origin: z.string(),
      key: z.string(),
      references: z.array(z.string()).readonly(),
      correlation: z.array(correlationKeySchema).readonly(),
      status: statusSchema,
      op: operationSchema,
      kind: kindSchema,
      categories: z.array(categorySchema).readonly(),
      severity: severitySchema,
      urgency: urgencySchema,
      certainty: certaintySchema,
      response: z.array(responseTypeSchema).readonly(),
      sent: instantSchema,
      received: instantSchema,
      effective: instantSchema.exactOptional(),
      onset: instantSchema.exactOptional(),
      expires: instantSchema.exactOptional(),
      ends: instantSchema.exactOptional(),
      areas: z.array(areaSchema).readonly(),
      areaText: z.string().exactOptional(),
      about: z.array(subjectSchema).readonly(),
      sender: z.string(),
      headline: z.string(),
      description: z.string().exactOptional(),
      instruction: z.string().exactOptional(),
      web: z.string().exactOptional(),
      observation: observationIdSchema,
      parameters: z.record(z.string(), z.array(z.string()).readonly()).readonly(),
    })
    .readonly()
    .refine((report) => report.areas.length > 0 || report.about.length > 0, {
      error: "A report has one area or more, or one subject or more.",
      path: ["areas"],
    }),
);

// =============================================================================
// The source contract
// =============================================================================

/** This schema checks how a source gives its data. */
export const transportSchema: z.ZodType<Transport, Transport> = schemaOf<Transport>()(z.enum(["poll", "stream", "push", "radio"]));

/** This schema checks a resource of the cell. The values come from `CELL_RESOURCES`. */
export const cellResourceSchema: z.ZodType<CellResource, CellResource> = schemaOf<CellResource>()(z.enum(CELL_RESOURCES));

// The failure domains outside the cell. contracts.ts, lines 240 and 476: "Do not put the resources of the cell here."
const outsideDomains = z
  .array(z.string().refine((domain) => !CELL_RESOURCES.some((resource) => resource === domain), "A resource of the cell is not a failure domain outside the cell."))
  .readonly();

/** This schema checks the facts of a source. Its `dependsOn` holds no resource of the cell. */
export const sourceDescriptorSchema: z.ZodType<SourceDescriptor, SourceDescriptor> = schemaOf<SourceDescriptor>()(
  z
    .strictObject({
      id: sourceIdSchema,
      title: z.string(),
      origins: z.array(z.string()).readonly(),
      dependsOn: outsideDomains,
      uses: z.array(cellResourceSchema).readonly(),
      kinds: z.array(z.string()).readonly(),
      coverage: z.union([z.array(areaSchema).readonly(), z.literal("global")]),
      transport: transportSchema,
      interval: durationSchema,
      slowAfter: durationSchema,
      maxQuiet: durationSchema.exactOptional(),
      auth: z.enum(["none", "key", "oauth"]),
      listing: z.literal("snapshot").exactOptional(),
      canary: z.string().exactOptional(),
    })
    .readonly(),
);

/** This schema checks a place that the system watches, as the adapters see it. */
export const watchedPlaceSchema: z.ZodType<WatchedPlace, WatchedPlace> = schemaOf<WatchedPlace>()(
  z
    .strictObject({
      id: placeIdSchema,
      at: positionSchema.exactOptional(),
      codes: z.array(regionCodeSchema).readonly(),
      bufferKm: z.number(),
    })
    .readonly(),
);

/** This schema checks what a fetch asks for. */
export const watchSchema: z.ZodType<Watch, Watch> = schemaOf<Watch>()(
  z.strictObject({ places: z.array(watchedPlaceSchema).readonly(), kinds: z.array(z.string()).readonly().exactOptional() }).readonly(),
);

/** This schema checks the state that a source keeps between two fetches. */
export const cursorSchema: z.ZodType<Cursor, Cursor> = schemaOf<Cursor>()(z.record(z.string(), z.string()).readonly());

/** This schema checks why a fetch failed. */
export const fetchFailureSchema: z.ZodType<FetchFailure, FetchFailure> = schemaOf<FetchFailure>()(
  z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.enum(["network", "timeout", "server"]), message: z.string(), retryAfter: durationSchema.exactOptional() }),
      z.strictObject({ kind: z.literal("rate-limited"), message: z.string(), retryAfter: durationSchema.exactOptional() }),
      z.strictObject({ kind: z.enum(["auth", "refused"]), message: z.string() }),
    ])
    .readonly(),
);

/** This schema checks the result of one fetch. */
export const fetchOutcomeSchema: z.ZodType<FetchOutcome, FetchOutcome> = schemaOf<FetchOutcome>()(
  z
    .discriminatedUnion("ok", [
      z.strictObject({
        ok: z.literal(true),
        observations: z.array(observationSchema).readonly(),
        cursor: cursorSchema.exactOptional(),
        complete: z.boolean(),
        asOf: instantSchema.exactOptional(),
      }),
      z.strictObject({ ok: z.literal(false), failure: fetchFailureSchema }),
    ])
    .readonly(),
);

/** This schema checks a part of a message that the map function did not understand. The field `lossy` is absent or true. */
export const mapProblemSchema: z.ZodType<MapProblem, MapProblem> = schemaOf<MapProblem>()(
  z.strictObject({ path: z.string(), message: z.string(), fatal: z.boolean(), lossy: z.literal(true).exactOptional() }).readonly(),
);

/** This schema checks the result of the map function. */
export const mapResultSchema: z.ZodType<MapResult, MapResult> = schemaOf<MapResult>()(
  z.strictObject({ reports: z.array(reportSchema).readonly(), problems: z.array(mapProblemSchema).readonly() }).readonly(),
);

/** This schema checks the result of the canary check of a source. */
export const canaryResultSchema: z.ZodType<CanaryResult, CanaryResult> = schemaOf<CanaryResult>()(
  z.strictObject({ pass: z.boolean(), reason: z.string() }).readonly(),
);

/** This schema checks the record of one fetch. The three counts are integers, 0 or more (`contracts.ts`, lines 356, 358 and 360). */
export const fetchRecordSchema: z.ZodType<FetchRecord, FetchRecord> = schemaOf<FetchRecord>()(
  z
    .strictObject({
      source: sourceIdSchema,
      at: instantSchema,
      took: durationSchema,
      failure: fetchFailureSchema.exactOptional(),
      fresh: count(),
      fatal: count(),
      lossy: count().exactOptional(),
      canary: canaryResultSchema.exactOptional(),
    })
    .readonly(),
);

/** This schema checks the result of a lookup of the region codes of a position. */
export const locateOutcomeSchema: z.ZodType<LocateOutcome, LocateOutcome> = schemaOf<LocateOutcome>()(
  z
    .discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true), codes: z.array(regionCodeSchema).readonly() }),
      z.strictObject({ ok: z.literal(false), failure: fetchFailureSchema }),
    ])
    .readonly(),
);

// =============================================================================
// Health and coverage
// =============================================================================

/** This schema checks the health of a source. */
export const healthStateSchema: z.ZodType<HealthState, HealthState> = schemaOf<HealthState>()(
  z.enum(["unknown", "healthy", "slow", "failing", "silent", "changed"]),
);

/** This schema checks the health of one source at one time. */
export const sourceHealthSchema: z.ZodType<SourceHealth, SourceHealth> = schemaOf<SourceHealth>()(
  z
    .strictObject({
      source: sourceIdSchema,
      state: healthStateSchema,
      since: instantSchema,
      lastSuccess: instantSchema.exactOptional(),
      lastFailure: z.strictObject({ at: instantSchema, failure: fetchFailureSchema }).readonly().exactOptional(),
      reason: z.string(),
    })
    .readonly(),
);

/** This schema checks the coverage of one kind at one place. The two counts are integers, 0 or more (`contracts.ts`, lines 416 and 432). */
export const coverageSchema: z.ZodType<Coverage, Coverage> = schemaOf<Coverage>()(
  z
    .strictObject({
      place: placeIdSchema,
      kind: z.string(),
      sources: z.array(sourceIdSchema).readonly(),
      independent: count(),
      proven: z.boolean(),
      faults: z.array(z.string()).readonly(),
      commonResources: z.array(cellResourceSchema).readonly(),
      required: count(),
    })
    .readonly(),
);

// =============================================================================
// Incidents
// =============================================================================

/**
 * This schema checks one incident. It has one report or more (`contracts.ts`, line 430). Its report ids
 * go from the smallest, each one time, and its anchor is the smallest (lines 434 and 436). The order
 * is the order of the code units, as in the merge. The corroboration is a count (line 450).
 */
export const incidentSchema: z.ZodType<Incident, Incident> = schemaOf<Incident>()(
  z
    .strictObject({
      anchor: reportIdSchema,
      reports: z.array(reportIdSchema).min(1, "An incident has one report or more.").readonly(),
      status: statusSchema,
      kind: kindSchema,
      severity: severitySchema,
      urgency: urgencySchema,
      certainty: certaintySchema,
      onset: instantSchema.exactOptional(),
      expires: instantSchema.exactOptional(),
      areas: z.array(areaSchema).readonly(),
      about: z.array(subjectSchema).readonly(),
      live: z.boolean(),
      corroboration: count(),
    })
    .readonly()
    .refine((incident) => incident.reports[0] === incident.anchor, { error: "The anchor of an incident is its smallest report id.", path: ["anchor"] })
    .refine(
      (incident) =>
        incident.reports.every((id, index) => {
          const before = incident.reports[index - 1];
          return before === undefined || before < id;
        }),
      { error: "The report ids of an incident go from the smallest, each one time.", path: ["reports"] },
    ),
);

// =============================================================================
// Delivery
// =============================================================================

/** This schema checks the level of an alert. The values come from `LEVELS`. */
export const levelSchema: z.ZodType<Level, Level> = schemaOf<Level>()(z.enum(LEVELS));

/** This schema checks the facts of a channel. Its `dependsOn` holds no resource of the cell. */
export const channelDescriptorSchema: z.ZodType<ChannelDescriptor, ChannelDescriptor> = schemaOf<ChannelDescriptor>()(
  z
    .strictObject({
      id: channelIdSchema,
      title: z.string(),
      dependsOn: outsideDomains,
      uses: z.array(cellResourceSchema).readonly(),
      breaksThrough: z.boolean(),
      repeats: z.boolean(),
      ack: z.enum(["none", "poll", "callback"]),
      maxTitle: z.number(),
      maxBody: z.number(),
      costUsd: z.number().exactOptional(),
    })
    .readonly(),
);

/** This schema checks one message to one person on one channel. A `life-safety` message is not quiet (`contracts.ts`, line 516). */
export const messageSchema: z.ZodType<Message, Message> = schemaOf<Message>()(
  z
    .strictObject({
      key: z.string(),
      person: personIdSchema,
      level: levelSchema,
      title: z.string(),
      body: z.string(),
      url: z.string().exactOptional(),
      incident: reportIdSchema,
      expires: instantSchema.exactOptional(),
      quiet: z.boolean(),
    })
    .readonly()
    .refine((message) => !(message.level === "life-safety" && message.quiet), {
      error: "A life-safety message is not quiet at any time.",
      path: ["quiet"],
    }),
);

/** This schema checks the address of a person on a channel. */
export const addressSchema: z.ZodType<Address, Address> = schemaOf<Address>()(z.record(z.string(), z.string()).readonly());

/** This schema checks the receipt of a sent message. */
export const receiptSchema: z.ZodType<Receipt, Receipt> = schemaOf<Receipt>()(z.record(z.string(), z.string()).readonly());

/** This schema checks the result of a send. */
export const sendOutcomeSchema: z.ZodType<SendOutcome, SendOutcome> = schemaOf<SendOutcome>()(
  z
    .discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true), receipt: receiptSchema, accepted: instantSchema }),
      z.strictObject({
        ok: z.literal(false),
        kind: z.enum(["network", "timeout", "server", "rate-limited", "auth", "refused"]),
        message: z.string(),
        retryAfter: durationSchema.exactOptional(),
      }),
    ])
    .readonly(),
);

/** This schema checks the state of a sent message. */
export const deliveryStateSchema: z.ZodType<DeliveryState, DeliveryState> = schemaOf<DeliveryState>()(
  z.enum(["accepted", "delivered", "acknowledged", "expired", "failed"]),
);

/** This schema checks the state of a sent message, as the channel tells it. */
export const deliveryStatusSchema: z.ZodType<DeliveryStatus, DeliveryStatus> = schemaOf<DeliveryStatus>()(
  z
    .strictObject({
      state: deliveryStateSchema,
      at: instantSchema,
      by: z.string().exactOptional(),
      reason: z.string().exactOptional(),
    })
    .readonly(),
);

/** This schema checks one step of an escalation. */
export const escalationStepSchema: z.ZodType<EscalationStep, EscalationStep> = schemaOf<EscalationStep>()(
  z.strictObject({ channel: channelIdSchema, at: durationSchema }).readonly(),
);

/** This schema checks the escalation of one level. */
export const escalationPolicySchema: z.ZodType<EscalationPolicy, EscalationPolicy> = schemaOf<EscalationPolicy>()(
  z.strictObject({ level: levelSchema, steps: z.array(escalationStepSchema).readonly(), exhaustedAfter: durationSchema }).readonly(),
);

/** This schema checks one accepted send. The step is an index from 0 (`contracts.ts`, line 593). */
export const deliverySchema: z.ZodType<Delivery, Delivery> = schemaOf<Delivery>()(
  z
    .strictObject({
      key: z.string(),
      incident: reportIdSchema,
      level: levelSchema,
      person: personIdSchema,
      channel: channelIdSchema,
      step: count(),
      at: instantSchema,
      receipt: receiptSchema.exactOptional(),
    })
    .readonly(),
);

/** This schema checks an acknowledgment from a person, by a channel or the UI. */
export const acknowledgmentSchema: z.ZodType<Acknowledgment, Acknowledgment> = schemaOf<Acknowledgment>()(
  z
    .strictObject({
      incident: reportIdSchema,
      level: levelSchema,
      person: personIdSchema,
      at: instantSchema,
      via: z.union([channelIdSchema, z.literal("ui")]),
    })
    .readonly(),
);

/** This schema checks an end mark of a report of a snapshot source. */
export const endMarkSchema: z.ZodType<EndMark, EndMark> = schemaOf<EndMark>()(
  z
    .strictObject({
      report: reportIdSchema,
      at: instantSchema,
      ended: z.boolean(),
      asOf: instantSchema.exactOptional(),
    })
    .readonly(),
);

// =============================================================================
// The assessment
// =============================================================================

/** This schema checks the level of an incident for a person, or `none`. The values come from `ASSESSED_LEVELS`. */
export const assessedLevelSchema: z.ZodType<AssessedLevel, AssessedLevel> = schemaOf<AssessedLevel>()(z.enum(ASSESSED_LEVELS));

// The two lookups of a table. Each lookup has a level for each value.
const severityLookup = z.record(severitySchema, assessedLevelSchema).readonly();
const urgencyLookup = z.record(urgencySchema, assessedLevelSchema).readonly();

/** This schema checks the highest levels for the severity and the urgency. Each lookup has a level for each value. */
export const levelTableSchema: z.ZodType<LevelTable, LevelTable> = schemaOf<LevelTable>()(
  z.strictObject({ severity: severityLookup, urgency: urgencyLookup }).readonly(),
);

/**
 * This schema checks a class of kinds with its own table. Each prefix of the class must be a code of
 * the taxonomy, because each policy names only known codes (`docs/CONTRACTS.md`, line 219).
 */
export const kindClassSchema: z.ZodType<KindClass, KindClass> = schemaOf<KindClass>()(
  z
    .strictObject({
      id: z.string(),
      kinds: z.array(z.string().refine(knownKind, "A policy names only known codes of the taxonomy.")).readonly(),
      statuses: z.array(statusSchema).readonly().exactOptional(),
      severity: severityLookup,
      urgency: urgencyLookup,
    })
    .readonly(),
);

/** This schema checks the data of the first assessment. */
export const assessPolicySchema: z.ZodType<AssessPolicy, AssessPolicy> = schemaOf<AssessPolicy>()(
  z
    .strictObject({
      statuses: z.array(statusSchema).readonly(),
      classes: z.array(kindClassSchema).readonly(),
      otherwise: levelTableSchema,
    })
    .readonly(),
);

/** This schema checks a rule of a person. */
export const levelRuleSchema: z.ZodType<LevelRule, LevelRule> = schemaOf<LevelRule>()(
  z
    .strictObject({
      places: z.array(placeIdSchema).readonly().exactOptional(),
      kinds: z.array(z.string()).readonly().exactOptional(),
      max: assessedLevelSchema,
    })
    .readonly(),
);

/**
 * This schema checks the quiet window of a person. It does not check the time zone or the local
 * times. The contract gives a bad window a meaning: it makes no quiet send (`docs/CONTRACTS.md`,
 * line 278). `quietWindowProblems` finds a bad window.
 */
export const quietWindowSchema: z.ZodType<QuietWindow, QuietWindow> = schemaOf<QuietWindow>()(
  z.strictObject({ zone: z.string(), start: z.string(), end: z.string() }).readonly(),
);

/** This schema checks a subject that a person watches. */
export const subjectWatchSchema: z.ZodType<SubjectWatch, SubjectWatch> = schemaOf<SubjectWatch>()(
  z.strictObject({ system: z.string(), id: z.string().exactOptional() }).readonly(),
);

/** This schema checks the places and the rules of one person. */
export const personWatchSchema: z.ZodType<PersonWatch, PersonWatch> = schemaOf<PersonWatch>()(
  z
    .strictObject({
      person: personIdSchema,
      places: z.array(placeIdSchema).readonly(),
      subjects: z.array(subjectWatchSchema).readonly().exactOptional(),
      rules: z.array(levelRuleSchema).readonly(),
      quiet: quietWindowSchema.exactOptional(),
    })
    .readonly(),
);

/** This schema checks a reason of an assessment. The index of a rule is its position, from 0 (`contracts.ts`, line 747). */
export const assessReasonSchema: z.ZodType<AssessReason, AssessReason> = schemaOf<AssessReason>()(
  z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("ended") }),
      z.strictObject({ kind: z.literal("status"), status: statusSchema }),
      z.strictObject({ kind: z.literal("no-place") }),
      z.strictObject({ kind: z.literal("no-subject") }),
      z.strictObject({ kind: z.literal("no-codes") }),
      z.strictObject({ kind: z.literal("unknown-place"), place: placeIdSchema }),
      z.strictObject({ kind: z.literal("place"), place: placeIdSchema, codes: z.array(regionCodeSchema).readonly() }),
      z.strictObject({ kind: z.literal("subject"), subject: subjectWatchSchema }),
      z.strictObject({
        kind: z.literal("table"),
        class: z.string().exactOptional(),
        bySeverity: assessedLevelSchema,
        byUrgency: assessedLevelSchema,
        level: assessedLevelSchema,
      }),
      z.strictObject({ kind: z.literal("rule"), place: placeIdSchema.exactOptional(), index: count(), max: assessedLevelSchema }),
    ])
    .readonly(),
);

/** This schema checks the level of one incident for one person, with its reasons. */
export const assessmentSchema: z.ZodType<Assessment, Assessment> = schemaOf<Assessment>()(
  z
    .strictObject({
      incident: reportIdSchema,
      person: personIdSchema,
      level: assessedLevelSchema,
      places: z.array(placeIdSchema).readonly(),
      reasons: z.array(assessReasonSchema).readonly(),
    })
    .readonly(),
);

// =============================================================================
// The lateness across sources
// =============================================================================

/** This schema checks the state of an expectation. */
export const latenessStateSchema: z.ZodType<LatenessState, LatenessState> = schemaOf<LatenessState>()(z.enum(["no-limit", "no-data", "met", "late"]));

/** This schema checks the limits of one expectation. The count of misses is an integer, 1 or more (`lateness.ts`, line 66). */
export const latenessLimitSchema: z.ZodType<LatenessLimit, LatenessLimit> = schemaOf<LatenessLimit>()(
  z.strictObject({ delay: durationSchema, misses: z.int().min(1, "The count of misses is an integer, 1 or more.") }).readonly(),
);

/** This schema checks the lateness of one source against another source for one expectation. */
export const latenessSchema: z.ZodType<Lateness, Lateness> = schemaOf<Lateness>()(
  z
    .strictObject({
      expectation: z.string(),
      from: sourceIdSchema,
      to: sourceIdSchema,
      state: latenessStateSchema,
      limit: latenessLimitSchema.exactOptional(),
      missed: z.array(reportIdSchema).readonly(),
      since: instantSchema.exactOptional(),
      wakeAt: instantSchema.exactOptional(),
    })
    .readonly(),
);

// =============================================================================
// The private configuration
// =============================================================================

/** This schema checks a reference to a secret. The name is not empty. The value stays in the secret store. */
export const secretRefSchema: z.ZodType<SecretRef, SecretRef> = schemaOf<SecretRef>()(
  z.strictObject({ secret: z.string().min(1, "The name of a secret is a non-empty string.") }).readonly(),
);

/** This schema checks one field of an address: a text, or a reference to a secret. */
export const addressValueSchema: z.ZodType<AddressValue, AddressValue> = schemaOf<AddressValue>()(z.union([z.string(), secretRefSchema]));

/** This schema checks a place of the configuration. */
export const placeConfigSchema: z.ZodType<PlaceConfig, PlaceConfig> = schemaOf<PlaceConfig>()(
  z
    .strictObject({
      id: placeIdSchema,
      label: z.string(),
      at: positionSchema.exactOptional(),
      codes: z.array(regionCodeSchema).readonly(),
      bufferKm: z.number(),
      sharePosition: z.array(sourceIdSchema).readonly().exactOptional(),
    })
    .readonly(),
);

// The printable ASCII characters, with no space, no parenthesis and no backslash.
const CONTACT_CHARACTERS = /^[\x21-\x27\x2a-\x5b\x5d-\x7e]+$/;
// An `https` URL with a host of two labels or more, or a `mailto` URL with one address.
const CONTACT_FORMS = [
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::[0-9]{1,5})?(?:[/?#].*)?$/i,
  /^mailto:[^@/?#]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\?.*)?$/i,
];

/**
 * This function tells if a text is a contact of an operator: an `https` URL with a host, or a `mailto` URL
 * with an address. The contact goes into the comment of the User-Agent. Thus it has only
 * printable ASCII characters, with no space, no parenthesis and no backslash. A header with other
 * characters stops the fetch. A parenthesis ends the comment, and a backslash escapes the next character.
 */
export function isContactUrl(text: string): boolean {
  return CONTACT_CHARACTERS.test(text) && CONTACT_FORMS.some((form) => form.test(text));
}

/** This schema checks a person of the configuration: the watch, and the policies of the person when they are not the default. */
export const personConfigSchema: z.ZodType<PersonConfig, PersonConfig> = schemaOf<PersonConfig>()(
  z
    .strictObject({
      watch: personWatchSchema,
      label: z.string().exactOptional(),
      policies: z.array(escalationPolicySchema).readonly().exactOptional(),
    })
    .readonly(),
);

/** This schema checks one address of one person on one channel. */
export const contactConfigSchema: z.ZodType<ContactConfig, ContactConfig> = schemaOf<ContactConfig>()(
  z.strictObject({ person: personIdSchema, channel: channelIdSchema, address: z.record(z.string(), addressValueSchema).readonly() }).readonly(),
);

/**
 * This schema checks the JSON of the private configuration at the load. It checks the form of each
 * value. Then `loadConfig` checks the references: the ids, the places of each person, the contacts and
 * the secrets.
 */
export const alertConfigSchema: z.ZodType<AlertConfig, AlertConfig> = schemaOf<AlertConfig>()(
  z
    .strictObject({
      format: z.literal(CONFIG_FORMAT),
      places: z.array(placeConfigSchema).readonly(),
      people: z.array(personConfigSchema).readonly(),
      contacts: z.array(contactConfigSchema).readonly(),
      policies: z.array(escalationPolicySchema).readonly(),
      contact: z.string().refine(isContactUrl, "The contact is not an https URL or a mailto URL.").exactOptional(),
    })
    .readonly(),
);

/**
 * This function checks a value at a trust boundary. The result is the value, or one problem for each
 * issue of the schema. A problem names the path and the rule. It does not hold the value, because the
 * value can be private.
 */
export function checkWith<T>(schema: z.ZodType<T, T>, value: unknown): Result<T, readonly string[]> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return err(parsed.error.issues.map((issue) => `${pathText(issue.path)}: ${issue.message}`));
}

/** The text of the path of an issue, for example `places[0].codes[1]`. The root is `(root)`. */
function pathText(path: readonly PropertyKey[]): string {
  const text = path.map((part, index) => (typeof part === "number" ? `[${part}]` : `${index === 0 ? "" : "."}${String(part)}`)).join("");
  return text === "" ? "(root)" : text;
}

/** A configuration that passed the schema and the load, with the recipient of each person. */
export interface ParsedConfig {
  readonly config: AlertConfig;
  readonly recipients: readonly Recipient[];
}

/**
 * This function reads the JSON text of the private configuration. It checks the JSON, then the schema,
 * then the references with `loadConfig`. The runtime starts only with an `ok` result. The problems hold
 * no value of the configuration and no value of a secret.
 */
export function parseConfig(text: string, channels: readonly ChannelDescriptor[], secret: SecretLookup): Result<ParsedConfig, readonly string[]> {
  // The message of the JSON parser can quote the text, so the problem does not use it.
  const json = tryCatch((): unknown => JSON.parse(text), () => ["The configuration is not valid JSON."]);
  if (json.tag === "err") return json;
  const checked = checkWith(alertConfigSchema, json.value);
  if (checked.tag === "err") return checked;
  const loaded = loadConfig(checked.value, channels, secret);
  return loaded.problems.length > 0 ? err(loaded.problems) : ok({ config: checked.value, recipients: loaded.recipients });
}
