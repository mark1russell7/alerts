import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { assess, DEFAULT_ASSESS_POLICY } from "./assess.ts";
import { CONFIG_FORMAT, loadConfig, type AlertConfig } from "./config.ts";
import type {
  Acknowledgment,
  EndMark,
  Address,
  Area,
  AssessedLevel,
  AssessPolicy,
  AssessReason,
  Assessment,
  CanaryResult,
  Category,
  CellResource,
  Certainty,
  ChannelDescriptor,
  ChannelId,
  CorrelationKey,
  Coverage,
  Cursor,
  Delivery,
  DeliveryState,
  DeliveryStatus,
  Duration,
  EscalationPolicy,
  EscalationStep,
  FetchFailure,
  FetchOutcome,
  FetchRecord,
  HealthState,
  Incident,
  Instant,
  Kind,
  KindClass,
  Level,
  LevelRule,
  LevelTable,
  LocateOutcome,
  MapProblem,
  MapResult,
  Message,
  Observation,
  ObservationId,
  Operation,
  PersonId,
  PersonWatch,
  PlaceId,
  Position,
  QuietWindow,
  Receipt,
  RegionCode,
  Report,
  ReportId,
  ResponseType,
  SendOutcome,
  Severity,
  Significance,
  SourceDescriptor,
  SourceHealth,
  SourceId,
  Status,
  Subject,
  SubjectWatch,
  Transport,
  Urgency,
  Watch,
  WatchedPlace,
} from "./contracts.ts";
import { coverage } from "./coverage.ts";
import { escalate } from "./escalation.ts";
import { observeFetch, startHealth } from "./health.ts";
import { messageKey, observationId, reportId } from "./ids.ts";
import { lateness, type Lateness, type LatenessLimit, type LatenessState } from "./lateness.ts";
import { incidents, normalize } from "./merge.ts";
import * as schemas from "./schemas.ts";
import {
  acknowledgmentSchema,
  endMarkSchema,
  addressSchema,
  addressValueSchema,
  alertConfigSchema,
  areaSchema,
  assessedLevelSchema,
  assessmentSchema,
  assessPolicySchema,
  assessReasonSchema,
  canaryResultSchema,
  categorySchema,
  cellResourceSchema,
  certaintySchema,
  channelDescriptorSchema,
  channelIdSchema,
  checkWith,
  contactConfigSchema,
  correlationKeySchema,
  coverageSchema,
  cursorSchema,
  deliverySchema,
  deliveryStateSchema,
  deliveryStatusSchema,
  durationSchema,
  escalationPolicySchema,
  escalationStepSchema,
  fetchFailureSchema,
  fetchOutcomeSchema,
  fetchRecordSchema,
  healthStateSchema,
  incidentSchema,
  instantSchema,
  isContactUrl,
  kindClassSchema,
  kindSchema,
  latenessLimitSchema,
  latenessSchema,
  latenessStateSchema,
  levelRuleSchema,
  levelSchema,
  levelTableSchema,
  locateOutcomeSchema,
  mapProblemSchema,
  mapResultSchema,
  messageSchema,
  observationIdSchema,
  observationSchema,
  operationSchema,
  parseConfig,
  personConfigSchema,
  personIdSchema,
  personWatchSchema,
  placeConfigSchema,
  placeIdSchema,
  positionSchema,
  quietWindowSchema,
  receiptSchema,
  regionCodeSchema,
  reportIdSchema,
  reportSchema,
  responseTypeSchema,
  schemaOf,
  secretRefSchema,
  sendOutcomeSchema,
  severitySchema,
  significanceSchema,
  sourceDescriptorSchema,
  sourceHealthSchema,
  sourceIdSchema,
  statusSchema,
  subjectSchema,
  subjectWatchSchema,
  transportSchema,
  urgencySchema,
  watchedPlaceSchema,
  watchSchema,
} from "./schemas.ts";
import { NO_SYSTEM_LINES, SOURCE_SUBJECT, systemReports } from "./system-reports.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const HOUR = 3_600_000;
const T0 = 1_763_157_600_000;
const API = "nws-api" as SourceId;
const PUSHOVER = "pushover" as ChannelId;
const PERSON = "person:a" as PersonId;

// A public place in Kansas: Sedgwick County KS, in the area of the NWS office KICT.
const KANSAS: WatchedPlace = {
  id: "place:a" as PlaceId,
  at: [-97.46, 37.68],
  codes: [
    { system: "ugc", code: "KSZ083" },
    { system: "ugc", code: "KSC173" },
    { system: "same", code: "020173" },
    { system: "state", code: "KS" },
  ],
  bufferKm: 5,
};

// A public place in Texas: Bexar County TX, in the area of the NWS office KEWX.
const TEXAS: WatchedPlace = { id: "place:b" as PlaceId, codes: [{ system: "ugc", code: "TXC029" }, { system: "same", code: "048029" }], bufferKm: 0 };

const DESCRIPTOR: SourceDescriptor = {
  id: API,
  title: "NWS API",
  origins: ["nws"],
  dependsOn: ["provider:nws-api", "cdn:akamai"],
  uses: ["internet", "power"],
  kinds: ["met"],
  coverage: [{ type: "code", system: "state", code: "KS" }],
  transport: "poll",
  interval: 60_000,
  slowAfter: 10_000,
  auth: "none",
  canary: "The national feed has one active alert or more.",
};

const CHANNEL: ChannelDescriptor = {
  id: PUSHOVER,
  title: "Pushover",
  dependsOn: ["provider:pushover", "provider:apns"],
  uses: ["internet", "power"],
  breaksThrough: true,
  repeats: true,
  ack: "poll",
  maxTitle: 250,
  maxBody: 1024,
};

const OBSERVATION: Observation = {
  id: observationId({ source: API, contentType: "application/geo+json", body: "{}", url: "https://api.weather.gov/alerts/active?area=KS" }),
  source: API,
  fetched: T0,
  contentType: "application/geo+json",
  body: "{}",
  transport: { url: "https://api.weather.gov/alerts/active?area=KS", status: 200, latency: 120, etag: "W/\"1\"" },
};

// A tornado warning of the NWS office KICT for Sedgwick County KS.
const WARNING: Report = {
  id: reportId({ source: API, key: "urn:oid:2.49.0.1.840.0.kict.1", sent: T0 }),
  source: API,
  origin: "nws",
  key: "urn:oid:2.49.0.1.840.0.kict.1",
  references: [],
  correlation: [{ system: "vtec", id: "KICT.TO.W.0012.2025" }],
  status: "actual",
  op: "alert",
  kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" },
  categories: ["met"],
  severity: "extreme",
  urgency: "immediate",
  certainty: "observed",
  response: ["shelter"],
  sent: T0,
  received: T0 + 1_000,
  effective: T0,
  onset: T0,
  expires: T0 + HOUR,
  areas: [
    { type: "polygon", rings: [[[-97.5, 37.6], [-97.3, 37.6], [-97.3, 37.8], [-97.5, 37.6]]] },
    { type: "code", system: "ugc", code: "KSC173" },
    { type: "code", system: "same", code: "020173" },
  ],
  areaText: "Sedgwick, KS",
  about: [],
  sender: "NWS Wichita KS",
  headline: "Tornado Warning issued for Sedgwick County KS",
  description: "A tornado is on the ground.",
  instruction: "Take shelter now.",
  web: "https://www.weather.gov/ict",
  observation: OBSERVATION.id,
  parameters: { VTEC: ["/O.NEW.KICT.TO.W.0012.2025/"], WEAHandling: ["Imminent Threat"] },
};

const OPERATOR: PersonWatch = {
  person: PERSON,
  places: [KANSAS.id, TEXAS.id],
  subjects: [{ system: SOURCE_SUBJECT }],
  rules: [{ places: [TEXAS.id], kinds: ["met"], max: "urgent" }],
  quiet: { zone: "America/Chicago", start: "22:00", end: "07:00" },
};

const ESCALATION: EscalationPolicy = { level: "life-safety", steps: [{ channel: PUSHOVER, at: 0 }], exhaustedAfter: 10 * 60_000 };

// The schema refuses the value.
function fails(schema: z.ZodType, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

// The schema accepts the value, also after a trip through JSON, and gives the same value.
function holds(schema: z.ZodType, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
}

describe("the type of each schema", () => {
  it("is exactly its contract", () => {
    expectTypeOf<z.output<typeof instantSchema>>().toEqualTypeOf<Instant>();
    expectTypeOf<z.output<typeof durationSchema>>().toEqualTypeOf<Duration>();
    expectTypeOf<z.output<typeof sourceIdSchema>>().toEqualTypeOf<SourceId>();
    expectTypeOf<z.output<typeof channelIdSchema>>().toEqualTypeOf<ChannelId>();
    expectTypeOf<z.output<typeof observationIdSchema>>().toEqualTypeOf<ObservationId>();
    expectTypeOf<z.output<typeof reportIdSchema>>().toEqualTypeOf<ReportId>();
    expectTypeOf<z.output<typeof personIdSchema>>().toEqualTypeOf<PersonId>();
    expectTypeOf<z.output<typeof placeIdSchema>>().toEqualTypeOf<PlaceId>();
    expectTypeOf<z.output<typeof statusSchema>>().toEqualTypeOf<Status>();
    expectTypeOf<z.output<typeof operationSchema>>().toEqualTypeOf<Operation>();
    expectTypeOf<z.output<typeof severitySchema>>().toEqualTypeOf<Severity>();
    expectTypeOf<z.output<typeof urgencySchema>>().toEqualTypeOf<Urgency>();
    expectTypeOf<z.output<typeof certaintySchema>>().toEqualTypeOf<Certainty>();
    expectTypeOf<z.output<typeof responseTypeSchema>>().toEqualTypeOf<ResponseType>();
    expectTypeOf<z.output<typeof categorySchema>>().toEqualTypeOf<Category>();
    expectTypeOf<z.output<typeof significanceSchema>>().toEqualTypeOf<Significance>();
    expectTypeOf<z.output<typeof kindSchema>>().toEqualTypeOf<Kind>();
    expectTypeOf<z.output<typeof positionSchema>>().toEqualTypeOf<Position>();
    expectTypeOf<z.output<typeof regionCodeSchema>>().toEqualTypeOf<RegionCode>();
    expectTypeOf<z.output<typeof areaSchema>>().toEqualTypeOf<Area>();
    expectTypeOf<z.output<typeof subjectSchema>>().toEqualTypeOf<Subject>();
    expectTypeOf<z.output<typeof correlationKeySchema>>().toEqualTypeOf<CorrelationKey>();
    expectTypeOf<z.output<typeof observationSchema>>().toEqualTypeOf<Observation>();
    expectTypeOf<z.output<typeof reportSchema>>().toEqualTypeOf<Report>();
    expectTypeOf<z.output<typeof transportSchema>>().toEqualTypeOf<Transport>();
    expectTypeOf<z.output<typeof cellResourceSchema>>().toEqualTypeOf<CellResource>();
    expectTypeOf<z.output<typeof sourceDescriptorSchema>>().toEqualTypeOf<SourceDescriptor>();
    expectTypeOf<z.output<typeof watchedPlaceSchema>>().toEqualTypeOf<WatchedPlace>();
    expectTypeOf<z.output<typeof watchSchema>>().toEqualTypeOf<Watch>();
    expectTypeOf<z.output<typeof cursorSchema>>().toEqualTypeOf<Cursor>();
    expectTypeOf<z.output<typeof fetchFailureSchema>>().toEqualTypeOf<FetchFailure>();
    expectTypeOf<z.output<typeof fetchOutcomeSchema>>().toEqualTypeOf<FetchOutcome>();
    expectTypeOf<z.output<typeof mapProblemSchema>>().toEqualTypeOf<MapProblem>();
    expectTypeOf<z.output<typeof mapResultSchema>>().toEqualTypeOf<MapResult>();
    expectTypeOf<z.output<typeof canaryResultSchema>>().toEqualTypeOf<CanaryResult>();
    expectTypeOf<z.output<typeof fetchRecordSchema>>().toEqualTypeOf<FetchRecord>();
    expectTypeOf<z.output<typeof locateOutcomeSchema>>().toEqualTypeOf<LocateOutcome>();
    expectTypeOf<z.output<typeof healthStateSchema>>().toEqualTypeOf<HealthState>();
    expectTypeOf<z.output<typeof sourceHealthSchema>>().toEqualTypeOf<SourceHealth>();
    expectTypeOf<z.output<typeof coverageSchema>>().toEqualTypeOf<Coverage>();
    expectTypeOf<z.output<typeof incidentSchema>>().toEqualTypeOf<Incident>();
    expectTypeOf<z.output<typeof levelSchema>>().toEqualTypeOf<Level>();
    expectTypeOf<z.output<typeof channelDescriptorSchema>>().toEqualTypeOf<ChannelDescriptor>();
    expectTypeOf<z.output<typeof messageSchema>>().toEqualTypeOf<Message>();
    expectTypeOf<z.output<typeof addressSchema>>().toEqualTypeOf<Address>();
    expectTypeOf<z.output<typeof receiptSchema>>().toEqualTypeOf<Receipt>();
    expectTypeOf<z.output<typeof sendOutcomeSchema>>().toEqualTypeOf<SendOutcome>();
    expectTypeOf<z.output<typeof deliveryStateSchema>>().toEqualTypeOf<DeliveryState>();
    expectTypeOf<z.output<typeof deliveryStatusSchema>>().toEqualTypeOf<DeliveryStatus>();
    expectTypeOf<z.output<typeof escalationStepSchema>>().toEqualTypeOf<EscalationStep>();
    expectTypeOf<z.output<typeof escalationPolicySchema>>().toEqualTypeOf<EscalationPolicy>();
    expectTypeOf<z.output<typeof deliverySchema>>().toEqualTypeOf<Delivery>();
    expectTypeOf<z.output<typeof acknowledgmentSchema>>().toEqualTypeOf<Acknowledgment>();
    expectTypeOf<z.output<typeof endMarkSchema>>().toEqualTypeOf<EndMark>();
    expectTypeOf<z.output<typeof assessedLevelSchema>>().toEqualTypeOf<AssessedLevel>();
    expectTypeOf<z.output<typeof levelTableSchema>>().toEqualTypeOf<LevelTable>();
    expectTypeOf<z.output<typeof kindClassSchema>>().toEqualTypeOf<KindClass>();
    expectTypeOf<z.output<typeof assessPolicySchema>>().toEqualTypeOf<AssessPolicy>();
    expectTypeOf<z.output<typeof levelRuleSchema>>().toEqualTypeOf<LevelRule>();
    expectTypeOf<z.output<typeof quietWindowSchema>>().toEqualTypeOf<QuietWindow>();
    expectTypeOf<z.output<typeof subjectWatchSchema>>().toEqualTypeOf<SubjectWatch>();
    expectTypeOf<z.output<typeof personWatchSchema>>().toEqualTypeOf<PersonWatch>();
    expectTypeOf<z.output<typeof assessReasonSchema>>().toEqualTypeOf<AssessReason>();
    expectTypeOf<z.output<typeof assessmentSchema>>().toEqualTypeOf<Assessment>();
    expectTypeOf<z.output<typeof latenessStateSchema>>().toEqualTypeOf<LatenessState>();
    expectTypeOf<z.output<typeof latenessLimitSchema>>().toEqualTypeOf<LatenessLimit>();
    expectTypeOf<z.output<typeof latenessSchema>>().toEqualTypeOf<Lateness>();
  });

  it("is the input type too", () => {
    expectTypeOf<z.input<typeof reportSchema>>().toEqualTypeOf<Report>();
    expectTypeOf<z.input<typeof personWatchSchema>>().toEqualTypeOf<PersonWatch>();
    expectTypeOf<z.input<typeof watchSchema>>().toEqualTypeOf<Watch>();
    expectTypeOf<z.input<typeof alertConfigSchema>>().toEqualTypeOf<AlertConfig>();
  });
});

describe("the gate of schemaOf", () => {
  interface Sample {
    readonly name: string;
    readonly size?: number;
  }

  it("accepts a schema that is exactly its type", () => {
    const sample = schemaOf<Sample>()(z.strictObject({ name: z.string(), size: z.number().exactOptional() }).readonly());
    expect(sample.parse({ name: "KSZ083" })).toEqual({ name: "KSZ083" });
  });

  it("refuses a plain optional key, a key that is not readonly, a missing key and a missing value", () => {
    // @ts-expect-error A plain optional key gives `size?: number | undefined`, not `size?: number`.
    schemaOf<Sample>()(z.strictObject({ name: z.string(), size: z.number().optional() }).readonly());
    // @ts-expect-error An object with no `.readonly()` has keys that are not readonly.
    schemaOf<Sample>()(z.strictObject({ name: z.string(), size: z.number().exactOptional() }));
    // @ts-expect-error The schema has no key `size`.
    schemaOf<Sample>()(z.strictObject({ name: z.string() }).readonly());
    // @ts-expect-error The enum has no value `test`.
    schemaOf<Status>()(z.enum(["actual", "exercise", "system", "draft"]));
  });
});

describe("the JSON Schema of each schema", () => {
  const exported = Object.entries(schemas).filter(([name]) => name.endsWith("Schema"));

  it("has each exported schema", () => {
    expect(exported.length).toBe(79);
    for (const [name, schema] of exported) expect(schema instanceof z.ZodType, name).toBe(true);
  });

  it("converts each schema with no error", () => {
    for (const [name, schema] of exported) {
      if (!(schema instanceof z.ZodType)) throw new Error(`${name} is not a schema.`);
      expect(() => z.toJSONSchema(schema), name).not.toThrow();
    }
  });

  it("closes each object and keeps the bounds", () => {
    expect(z.toJSONSchema(regionCodeSchema)).toMatchObject({ type: "object", additionalProperties: false, required: ["system", "code"] });
    expect(z.toJSONSchema(reportIdSchema)).toMatchObject({ type: "string", minLength: 1 });
    expect(z.toJSONSchema(durationSchema)).toMatchObject({ type: "number", minimum: 0 });
    expect(z.toJSONSchema(kindSchema)).toMatchObject({ required: ["code", "label"] });
  });
});

describe("the round trip of real values", () => {
  it("accepts the values of the source and the channel contracts", () => {
    holds(sourceDescriptorSchema, DESCRIPTOR);
    holds(sourceDescriptorSchema, { ...DESCRIPTOR, coverage: "global", maxQuiet: HOUR });
    holds(sourceDescriptorSchema, { ...DESCRIPTOR, listing: "snapshot" });
    fails(sourceDescriptorSchema, { ...DESCRIPTOR, listing: "stream" });
    holds(channelDescriptorSchema, CHANNEL);
    holds(observationSchema, OBSERVATION);
    holds(reportSchema, WARNING);
    holds(mapResultSchema, { reports: [WARNING], problems: [{ path: "features[3].properties.onset", message: "The onset is not a date.", fatal: false }] });
    holds(watchSchema, { places: [KANSAS, TEXAS], kinds: ["met"] });
    holds(fetchOutcomeSchema, { ok: true, observations: [OBSERVATION], cursor: { etag: "W/\"1\"" }, complete: true });
    holds(fetchOutcomeSchema, { ok: true, observations: [], complete: true });
    holds(fetchOutcomeSchema, { ok: false, failure: { kind: "rate-limited", message: "429", retryAfter: 30_000 } });
    holds(fetchOutcomeSchema, { ok: false, failure: { kind: "auth", message: "401" } });
    holds(locateOutcomeSchema, { ok: true, codes: KANSAS.codes });
    holds(sendOutcomeSchema, { ok: true, receipt: { receipt: "r1" }, accepted: T0 });
    holds(sendOutcomeSchema, { ok: false, kind: "server", message: "500", retryAfter: 1_000 });
    holds(deliveryStatusSchema, { state: "acknowledged", at: T0, by: "iphone" });
    holds(personWatchSchema, OPERATOR);
    holds(escalationPolicySchema, ESCALATION);
  });

  it("accepts the reports, the observations and the incidents of the core", () => {
    const record: FetchRecord = { source: API, at: T0, took: 500, failure: { kind: "timeout", message: "No answer in 10 s." }, fresh: 0, fatal: 0 };
    holds(fetchRecordSchema, record);
    holds(fetchRecordSchema, { source: API, at: T0, took: 200, fresh: 3, fatal: 0, canary: { pass: true, reason: "The feed has 12 alerts." } });
    const first = observeFetch(startHealth(API, T0 - HOUR), record, DESCRIPTOR).track;
    const failing = observeFetch(first, { ...record, at: T0 + 60_000 }, DESCRIPTOR).health;
    expect(failing.state).toBe("failing");
    holds(sourceHealthSchema, failing);

    const gaps = coverage({ sources: [DESCRIPTOR], health: [failing], places: [KANSAS], kinds: ["met.tornado"] });
    expect(gaps).toHaveLength(1);
    for (const gap of gaps) holds(coverageSchema, gap);

    const step = systemReports(NO_SYSTEM_LINES, { sources: [DESCRIPTOR], health: [failing], coverage: gaps, threats: [{ place: KANSAS.id, kind: "met.tornado" }] }, T0 + 2 * 60_000);
    expect(step.reports.map((report) => report.kind.code)).toEqual(["system.coverage.met.tornado", "system.health.failing"]);
    for (const report of step.reports) holds(reportSchema, report);
    for (const observation of step.observations) holds(observationSchema, observation);

    const found = incidents(normalize({ reports: [WARNING, ...step.reports] }), T0 + 3 * 60_000);
    expect(found).toHaveLength(3);
    for (const incident of found) {
      holds(incidentSchema, incident);
      const assessment = assess(incident, OPERATOR, [KANSAS, TEXAS]);
      holds(assessmentSchema, assessment);
    }
  });

  it("accepts the sends, the deliveries and the acknowledgments of the escalation", () => {
    const incident = incidents(normalize({ reports: [WARNING] }), T0)[0]!;
    const plan = escalate({ policy: ESCALATION, person: PERSON, incident, since: T0, deliveries: [], acknowledgments: [], quiet: OPERATOR.quiet, now: T0 });
    expect(plan.sends).toHaveLength(1);
    for (const send of plan.sends) {
      const message: Message = {
        key: messageKey(send),
        person: send.person,
        level: send.level,
        title: WARNING.headline,
        body: WARNING.instruction ?? "",
        url: "https://www.weather.gov/ict",
        incident: send.incident,
        expires: T0 + HOUR,
        quiet: send.quiet,
      };
      holds(messageSchema, message);
      const delivery: Delivery = { key: message.key, incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: T0 + 500, receipt: { receipt: "r1" } };
      holds(deliverySchema, delivery);
    }
    const ack: Acknowledgment = { incident: incident.anchor, level: "life-safety", person: PERSON, at: T0 + 60_000, via: "ui" };
    holds(acknowledgmentSchema, ack);
    holds(acknowledgmentSchema, { ...ack, via: PUSHOVER });
    holds(endMarkSchema, { report: ack.incident, at: T0, ended: true });
    fails(endMarkSchema, { report: ack.incident, at: T0, ended: "yes" });
  });

  it("accepts the first policy and the lateness of the core", () => {
    holds(assessPolicySchema, DEFAULT_ASSESS_POLICY);
    const expectation = { id: "nws-to-wea", from: API, to: "ipaws" as SourceId, when: { statuses: ["actual" as const] } };
    const limit: LatenessLimit = { delay: 5 * 60_000, misses: 2 };
    holds(latenessLimitSchema, limit);
    const checks = [
      { expectation: expectation.id, report: WARNING.id, started: T0 },
      { expectation: expectation.id, report: reportId({ source: API, key: "k2", sent: T0 }), started: T0 + 60_000 },
    ];
    for (const at of [T0, T0 + HOUR]) {
      for (const entry of lateness(checks, [expectation], { [expectation.id]: limit }, at)) holds(latenessSchema, entry);
    }
    for (const entry of lateness(checks, [expectation], {}, T0)) holds(latenessSchema, entry);
  });
});

describe("the value rules", () => {
  it("a report has one area or more, or one subject or more", () => {
    fails(reportSchema, { ...WARNING, areas: [], about: [] });
    holds(reportSchema, { ...WARNING, areas: [{ type: "code", system: "ugc", code: "KSZ083" }], about: [] });
    holds(reportSchema, { ...WARNING, areas: [], about: [{ system: SOURCE_SUBJECT, id: "nws-api" }] });
  });

  it("the code of a kind is in the taxonomy", () => {
    fails(kindSchema, { code: "met.tornadoo", label: "Tornado Warning" });
    fails(kindSchema, { code: "system.coverage.system.health", label: "Coverage" });
    fails(reportSchema, { ...WARNING, kind: { code: "met.tornadoo", label: "Tornado Warning" } });
    holds(kindSchema, { code: "other.unknown", label: "Unknown event" });
    holds(kindSchema, { code: "system.coverage.met.flood.flash", label: "Coverage" });
  });

  it("each id is a non-empty string", () => {
    for (const schema of [sourceIdSchema, channelIdSchema, observationIdSchema, reportIdSchema, personIdSchema, placeIdSchema]) {
      fails(schema, "");
      fails(schema, 7);
      holds(schema, "id:1");
    }
    fails(reportSchema, { ...WARNING, source: "" });
  });

  it("an instant and a duration are finite, and a duration is 0 or more", () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, "1"]) {
      fails(instantSchema, bad);
      fails(durationSchema, bad);
    }
    fails(durationSchema, -1);
    holds(durationSchema, 0);
    holds(instantSchema, -1);
    fails(sourceDescriptorSchema, { ...DESCRIPTOR, interval: -60_000 });
  });

  it("a position has the longitude in [-180, 180] and the latitude in [-90, 90]", () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      for (let i = 0; i < 50; i += 1) {
        const lon = r.range(-180, 180);
        const lat = r.range(-90, 90);
        expect(positionSchema.safeParse([lon, lat]).success, `seed ${seed}`).toBe(true);
        expect(positionSchema.safeParse([lon + (r.chance(0.5) ? 360 : -360), lat]).success, `seed ${seed}`).toBe(false);
        expect(positionSchema.safeParse([lon, lat + (r.chance(0.5) ? 180 : -180)]).success, `seed ${seed}`).toBe(false);
      }
    }
    holds(positionSchema, [180, -90]);
    fails(positionSchema, [-97.46]);
    fails(positionSchema, [-97.46, 37.68, 400]);
    fails(watchedPlaceSchema, { ...KANSAS, at: [37.68, -197.46] });
  });

  it("a count is an integer, 0 or more, and the count of misses is 1 or more", () => {
    const record: FetchRecord = { source: API, at: T0, took: 200, fresh: 0, fatal: 0 };
    holds(fetchRecordSchema, record);
    fails(fetchRecordSchema, { ...record, fresh: -1 });
    fails(fetchRecordSchema, { ...record, fatal: 0.5 });
    fails(assessReasonSchema, { kind: "rule", index: -1, max: "urgent" });
    holds(assessReasonSchema, { kind: "rule", index: 0, max: "urgent" });
    fails(latenessLimitSchema, { delay: 60_000, misses: 0 });
    fails(latenessLimitSchema, { delay: 60_000, misses: 1.5 });
    holds(latenessLimitSchema, { delay: 60_000, misses: 1 });
  });

  it("a life-safety message is not quiet", () => {
    const message: Message = { key: "k", person: PERSON, level: "life-safety", title: "Tornado Warning", body: "Take shelter now.", incident: WARNING.id, quiet: false };
    holds(messageSchema, message);
    fails(messageSchema, { ...message, quiet: true });
    holds(messageSchema, { ...message, level: "urgent", quiet: true });
  });

  it("an incident has one report or more, from the smallest, and its anchor is the smallest", () => {
    const [a, b] = [reportId({ source: API, key: "k1", sent: T0 }), reportId({ source: API, key: "k2", sent: T0 })].sort();
    if (a === undefined || b === undefined) throw new Error("Two ids are necessary.");
    const incident: Incident = {
      anchor: a,
      reports: [a, b],
      status: "actual",
      kind: WARNING.kind,
      severity: "extreme",
      urgency: "immediate",
      certainty: "observed",
      areas: WARNING.areas,
      about: [],
      live: true,
      corroboration: 1,
    };
    holds(incidentSchema, incident);
    fails(incidentSchema, { ...incident, reports: [] });
    fails(incidentSchema, { ...incident, anchor: b });
    fails(incidentSchema, { ...incident, reports: [b, a], anchor: b });
    fails(incidentSchema, { ...incident, reports: [a, a] });
    fails(incidentSchema, { ...incident, corroboration: -1 });
  });

  it("each prefix of a kind class is a known code", () => {
    const [first] = DEFAULT_ASSESS_POLICY.classes;
    if (first === undefined) throw new Error("The first policy has a class.");
    holds(kindClassSchema, first);
    fails(kindClassSchema, { ...first, kinds: ["met.tornadoo"] });
    fails(assessPolicySchema, { ...DEFAULT_ASSESS_POLICY, classes: [{ ...first, kinds: ["hydro"] }] });
  });

  it("the failure domains outside the cell hold no resource of the cell", () => {
    fails(sourceDescriptorSchema, { ...DESCRIPTOR, dependsOn: ["provider:nws-api", "internet"] });
    fails(channelDescriptorSchema, { ...CHANNEL, dependsOn: ["power"] });
    holds(sourceDescriptorSchema, { ...DESCRIPTOR, dependsOn: [] });
  });

  it("an unknown key fails, and an optional key is absent, not undefined", () => {
    fails(reportSchema, { ...WARNING, extra: 1 });
    fails(regionCodeSchema, { system: "ugc", code: "KSZ083", label: "Sedgwick" });
    fails(kindSchema, { code: "met.tornado", significance: undefined, label: "Tornado Warning" });
    fails(areaSchema, { type: "code", system: "ugc", code: "KSZ083", place: "place:a" });
    fails(fetchFailureSchema, { kind: "auth", message: "401", retryAfter: 1_000 });
    fails(levelTableSchema, { severity: { extreme: "urgent" }, urgency: DEFAULT_ASSESS_POLICY.otherwise.urgency });
  });
});

describe("the private configuration", () => {
  // The places of the fixtures, with made-up labels. The secret holds a name, not a value.
  const CONFIG: AlertConfig = {
    format: CONFIG_FORMAT,
    places: [
      { id: KANSAS.id, label: "Place A", at: [-97.46, 37.68], codes: KANSAS.codes, bufferKm: 5, sharePosition: [API] },
      { id: TEXAS.id, label: "Place B", codes: TEXAS.codes, bufferKm: 0 },
    ],
    people: [{ watch: { person: PERSON, places: [KANSAS.id, TEXAS.id], rules: [] }, label: "Person A" }],
    contacts: [{ person: PERSON, channel: PUSHOVER, address: { user: { secret: "PUSHOVER_USER" }, device: "phone" } }],
    policies: [ESCALATION],
  };

  it("accepts a configuration, and the load takes the parsed value", () => {
    holds(alertConfigSchema, CONFIG);
    const parsed = alertConfigSchema.parse(JSON.parse(JSON.stringify(CONFIG)));
    const loaded = loadConfig(parsed, [CHANNEL], (name) => (name === "PUSHOVER_USER" ? "user-test" : undefined));
    expect(loaded.problems).toEqual([]);
    expect(loaded.recipients.map((recipient) => recipient.addresses)).toEqual([{ [PUSHOVER]: { user: "user-test", device: "phone" } }]);
  });

  it("refuses a wrong form, and leaves the references to the load", () => {
    fails(alertConfigSchema, { ...CONFIG, format: "alerts-config/2" });
    fails(alertConfigSchema, { ...CONFIG, extra: 1 });
    fails(alertConfigSchema, { ...CONFIG, contacts: undefined });
    fails(secretRefSchema, { secret: "" });
    // A reference to a secret does not hold its value.
    fails(addressValueSchema, { secret: "PUSHOVER_USER", value: "user-test" });
    fails(addressValueSchema, 7);
    fails(contactConfigSchema, { person: PERSON, channel: PUSHOVER, address: { user: 7 } });
    fails(placeConfigSchema, { id: KANSAS.id, codes: KANSAS.codes, bufferKm: 0 });
    fails(personConfigSchema, { watch: { person: PERSON, places: [], rules: [] }, policies: [{ ...ESCALATION, level: "loud" }] });
    // A person who watches a place that the configuration does not have is a problem of the load, not of the form.
    holds(alertConfigSchema, { ...CONFIG, people: [{ watch: { person: PERSON, places: ["place:z"], rules: [] } }] });
  });

  const store = (name: string): string | undefined => (name === "PUSHOVER_USER" ? "user-test" : undefined);
  const problemsOf = (text: string, secret = store): readonly string[] => {
    const parsed = parseConfig(text, [CHANNEL], secret);
    return parsed.tag === "err" ? parsed.error : [];
  };

  it("parses the JSON text of a configuration, and gives the recipients", () => {
    const parsed = parseConfig(JSON.stringify(CONFIG), [CHANNEL], store);
    expect(parsed.tag).toBe("ok");
    if (parsed.tag === "ok") {
      expect(parsed.value.config).toEqual(CONFIG);
      expect(parsed.value.recipients.map((recipient) => recipient.addresses)).toEqual([{ [PUSHOVER]: { user: "user-test", device: "phone" } }]);
    }
  });

  it("gives the problems of the JSON, of the form and of the references, each with its path", () => {
    expect(problemsOf("{")).toEqual(["The configuration is not valid JSON."]);
    // The path of a problem is its text before the first colon.
    const pathsOf = (text: string): string[] => problemsOf(text).map((problem) => problem.slice(0, problem.indexOf(": ")));
    expect(pathsOf("7")).toEqual(["(root)"]);
    const wrong = { ...CONFIG, places: [{ ...CONFIG.places[0], bufferKm: "5" }, { ...CONFIG.places[1], codes: [{ system: "ugc", code: 7 }] }] };
    expect(pathsOf(JSON.stringify(wrong))).toEqual(["places[0].bufferKm", "places[1].codes[0].code"]);
    // The form holds, and the load finds the secret that the store does not have.
    expect(problemsOf(JSON.stringify(CONFIG), () => undefined)).toEqual([expect.stringContaining("names the secret PUSHOVER_USER")]);
  });

  it("accepts only printable ASCII in a contact, with no space, no parenthesis and no backslash", () => {
    const breaks = ["https://example.org/\r\nX: y", "https://example.org/\na", "https://example.org/\ta", "https://example.org/ a", "https://example.org/\u0000", "https://example.org/\u007f", "https://example.org/a)", "https://example.org/(a"];
    // A header with a character after ASCII stops the fetch. A backslash escapes the parenthesis that ends the comment.
    const others = ["https://exämple.org/", "https://example.org/\\", "mailto:operator@example.org "];
    for (const text of [...breaks, ...others]) expect(isContactUrl(text)).toBe(false);
    for (const text of ["https://example.org", "https://example.org/operator?topic=alerts", "HTTPS://alerts.example.org:8443/#contact", "mailto:operator@example.org", "mailto:a+b@example.org?subject=alerts"]) {
      expect(isContactUrl(text)).toBe(true);
    }
  });

  it("refuses a contact with no host, no address or another scheme", () => {
    for (const text of ["https://", "https://localhost", "https://example.org@", "https:example.org", "http://example.org", "ftp://example.org", "mailto:operator", "mailto:@example.org", "example.org"]) {
      expect(isContactUrl(text)).toBe(false);
    }
  });

  it("accepts a contact of the operator as an https URL or a mailto URL, and refuses other forms with no quote of the value", () => {
    holds(alertConfigSchema, { ...CONFIG, contact: "https://example.org/operator" });
    holds(alertConfigSchema, { ...CONFIG, contact: "mailto:operator@example.org" });
    const headerBreaks = ["https://example.org/\r\nX-PRIVATE: 1", "https://example.org/\tPRIVATE", "https://example.org/ PRIVATE", "mailto:PRIVATE@example.org\u0000", "mailto:PRIVATE@example.org\u007f"];
    const comments = ["https://example.org/PRIVATE)", "https://example.org/(PRIVATE"];
    for (const contact of ["http://example.org/PRIVATE", "PRIVATE@example.org", "", 7, ...headerBreaks, ...comments]) {
      const problems = problemsOf(JSON.stringify({ ...CONFIG, contact }));
      expect(problems).toHaveLength(1);
      expect(problems[0]?.startsWith("contact: ")).toBe(true);
      expect(problems[0]).not.toContain("PRIVATE");
    }
  });

  it("gives no value of the configuration and no value of a secret in a problem", () => {
    // Each check looks for the start of the value, because the JSON parser quotes only a part of a text.
    const prefix = "PRIVATE";
    const value = `${prefix}-VALUE`;
    // The message of the JSON parser quotes this text.
    expect(problemsOf(`{"label": ${value}}`).join(" ")).not.toContain(prefix);
    const wrong = {
      ...CONFIG,
      format: `alerts-config/${value}`,
      places: [{ ...CONFIG.places[0], label: [value], bufferKm: value, at: [500, 37.68] }],
      contacts: [{ ...CONFIG.contacts[0], address: { user: { secret: "PUSHOVER_USER", value } } }],
    };
    const problems = problemsOf(JSON.stringify(wrong));
    expect(problems.length).toBeGreaterThanOrEqual(4);
    expect(problems.join(" ")).not.toContain(prefix);
    // The load: the store holds the value of one secret, and the problem names only the other secret.
    const twoSecrets = { ...CONFIG, contacts: [{ ...CONFIG.contacts[0], address: { user: { secret: "PUSHOVER_USER" }, device: { secret: "MISSING" } } }] };
    const loadProblems = problemsOf(JSON.stringify(twoSecrets), (name) => (name === "PUSHOVER_USER" ? value : undefined));
    expect(loadProblems).toEqual([expect.stringContaining("names the secret MISSING")]);
    expect(loadProblems.join(" ")).not.toContain(prefix);
  });

  it("gives each issue of a schema with its path, and a value that holds", () => {
    expect(checkWith(secretRefSchema, { secret: "NAME" })).toEqual({ tag: "ok", value: { secret: "NAME" } });
    expect(checkWith(secretRefSchema, { secret: "" })).toEqual({ tag: "err", error: ["secret: The name of a secret is a non-empty string."] });
  });

  it("gives a JSON Schema with the format as a constant", () => {
    expect(z.toJSONSchema(alertConfigSchema)).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["format", "places", "people", "contacts", "policies"],
      properties: { format: { const: CONFIG_FORMAT } },
    });
  });
});
