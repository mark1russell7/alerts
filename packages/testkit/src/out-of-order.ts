/**
 * AL-13, case 9: the order of the reports, and their duplicates. One Flash Flood Warning of the office KEWX comes as NWS messages
 * and as their IPAWS copies. Each arm changes the order or the count of the messages of one event line.
 *
 * Each arm has the NWS source and the IPAWS source on one fast case clock, from 00:20 UTC on 2026-11-09. Each arm also has a
 * fake of the Pushover API. Two persons watch the places of case 8: `kept` (TXC137) and `dropped` (TXC019). Each person has an
 * `urgent` policy and a `life-safety` policy on Pushover. Each policy has a step at 0 and a step at `STEP_GAP`.
 *
 * The base line has an Alert (Moderate, thus `urgent`), an Update (Severe, thus `life-safety`) and a Cancel. Each
 * message is sent half an interval before the fetch of its time `sent`.
 *
 * - `control`: each message and its copy come in the fetch of the message.
 * - `ipaws-late`: each IPAWS copy comes after the NWS Cancel.
 * - `duplicates`: each NWS list has each message two times, and a second form from the next fetch. Each IPAWS copy is
 *   in three feeds, and a second form of it is in the fourth feed.
 * - `cancel-first`: the IPAWS Cancel comes before each other message.
 * - `update-first`: the Alert is Severe and the Update is Moderate. The Update comes before the Alert.
 * - `partial-lone`: a Cancel names only `dropped`.
 * - `partial-nws`: a Cancel names `dropped`, and an Update names `kept`. The NWS sends a partial cancel in this form.
 * - `re-entry`: as `partial-lone`, then an Update names the two places again.
 *
 * The gates of each place come from the log of the runtime and from the ledger of the Pushover fake:
 *
 * - `sends`: the sends of the person are the expected list of levels, steps and episodes.
 * - `oneKey`: each key of the person has one `attempt` row and one `delivery` row (law L1).
 * - `quietAway`: no send of the person starts while the threat is away from the place (law L2).
 * - `episodes`: the key of each send has the episode of the send, the count of the ends before it (law L3).
 * - `ends`: the count of the ends of the escalations of the person.
 * - `cancels`: each expected send has a cancel exactly when the expectation has one.
 * - `receipts`: Pushover got a cancel of each receipt exactly when the log has a cancel of its delivery.
 * - `live`: the place has a threat at the end of the arm exactly when the expectation has one.
 * - `system`: the person gets no send of an incident with the status `system`. The other gates do not count such a send.
 *
 * An incident with the status `system` tells of a fault of the setup, for example a place that no source covers.
 *
 * The arms have no acknowledgment. The runtime has no acknowledge function, and the Pushover fake gives one state to
 * all receipts. A state for each receipt in the fake of `@procedures/notify/testing` removes this limit.
 *
 * `ORDER_KNOWN_FAULTS` has the gates that fail because of a known fault of the core. The verdict expects them to fail.
 */
import {
  type EscalationPolicy,
  type FetchOutcome,
  type Incident,
  type Level,
  messageKey,
  type PersonId,
  type PlaceId,
  type Recipient,
  type ReportId,
  type SourceProcedures,
  threats,
  type Watch,
} from "@mark1russell7/alerts";
import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import { DELAY_LIMITS, DELIVERY_TIMES, openRuntime, openRuntimeLog, type RuntimeLog, type RuntimeOptions, sourcePace } from "@mark1russell7/alerts-runtime";
import { COPY_SUFFIX, createIpawsSource, IPAWS_DESCRIPTOR } from "@mark1russell7/alerts-source-ipaws";
import { createNwsSource, NWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nws-api";
import { random, sha256Hex } from "@mark1russell7/rigor-generators";
import { startScriptedServer } from "@mark1russell7/rigor-testkit/http";
import { pushoverApi, pushoverFetchTo, pushoverLedgerOf } from "@procedures/notify/testing";
import { fetchTransport } from "polite-crawler/api";
import {
  CASE_8_IPAWS,
  CASE_8_NWS,
  COPY_PLACES,
  type CopyFetch,
  type CopyPlace,
  type CopyRoute,
  copyTransport,
  cstTime,
  feedOf,
  type PairFixtures,
  readPair,
  ROUTE_PATHS,
  type RouteCounts,
  swap,
  swapParameter,
  vtecTime,
} from "./copy-late.ts";
import { PUSHOVER, testKey } from "./delivery-fixture.ts";
import { caseBodies } from "./nws.ts";
import { caseClock } from "./source-down.ts";

/** The id and the seed of the case. The ids of the messages and the jitter of each arm come from this seed. */
export const CASE_9_ID = "al-13-case-9";
const USER_AGENT = "alerts-testkit/0 (fault suite)";
const GEO_JSON = { "content-type": "application/geo+json" };
const XML = { "content-type": "application/xml" };
const MINUTE = 60_000;
/** The sender of each NWS message and of each IPAWS copy. */
const SENDER = "w-nws.webmaster@noaa.gov";
/** The event tracking number of the line. Each arm has one event. */
const ETN = "0901";

/** The time between the two steps of each policy, in milliseconds. */
export const STEP_GAP: number = 4 * MINUTE;
/** The time from the time `sent` of the first message of a line to the end of its event, in milliseconds. */
export const EVENT_SPAN: number = 30 * MINUTE;
/** The longest time between two passes of an arm, in milliseconds of the case clock. */
export const TICK = 10_000;
/** The count of IPAWS feeds with each copy. The feed of the first fetch of the copy and the next feed have it. */
export const FEED_SPAN = 2;
/** The count of IPAWS feeds with each copy in the arm `duplicates`. The next feed has the second form of the copy. */
export const DUPLICATE_FEEDS = 3;
/** The count of receipts of the Pushover fake. Each send gets the next receipt. */
const RECEIPTS = 24;
/** The bound of the passes of an arm, for each fetch. */
const PASSES_PER_FETCH = 40;

/** The settings of the case. */
export interface OrderSettings {
  /** The milliseconds of the case clock in one real millisecond. */
  readonly speed: number;
  /** The count of fetches of each source in each arm. */
  readonly fetches: number;
  /** The start of the case clock, in milliseconds since the epoch. */
  readonly start: number;
}

/** The settings of the case. Each arm has 16 fetches of 1 minute: 16 minutes of the case clock, 32 seconds at the speed 30. */
export const CASE_9_SETTINGS: OrderSettings = { speed: 30, fetches: 16, start: Date.parse("2026-11-09T00:20:00Z") };

/** The places of the case, in their order. */
export const ORDER_PLACES: readonly CopyPlace[] = ["kept", "dropped"];

/** The county of each place, as the messages name it. */
export const PLACE_COUNTIES: Readonly<Record<CopyPlace, { readonly ugc: string; readonly same: string; readonly desc: string }>> = {
  kept: { ugc: "TXC137", same: "048137", desc: "Edwards, TX" },
  dropped: { ugc: "TXC019", same: "048019", desc: "Bandera, TX" },
};

const WATCH: Watch = { places: COPY_PLACES };
const VIEW: RuntimeOptions["view"] = {
  places: COPY_PLACES,
  kinds: [...new Set([...NWS_DESCRIPTOR.kinds, ...IPAWS_DESCRIPTOR.kinds])],
  expectations: [],
  delay: DELAY_LIMITS,
};

/** This function gives the person who watches a place. */
export function personOf(place: CopyPlace): PersonId {
  return `person-${place}` as PersonId;
}

/** This function gives the id of a watched place of case 8. */
function placeIdOf(place: CopyPlace): PlaceId {
  const id = place as string as PlaceId;
  if (!COPY_PLACES.some((one) => one.id === id)) throw new Error(`Case 8 has no place ${place}.`);
  return id;
}

const policyOf = (level: Level): EscalationPolicy => ({
  level,
  steps: [
    { channel: PUSHOVER, at: 0 },
    { channel: PUSHOVER, at: STEP_GAP },
  ],
  exhaustedAfter: 20 * MINUTE,
});

/** This function gives the recipients of the case: one person at each place, with an `urgent` policy and a `life-safety` policy, and no quiet window. */
export function orderRecipientsOf(): Recipient[] {
  return ORDER_PLACES.map((place) => ({
    watch: { person: personOf(place), places: [placeIdOf(place)], rules: [] },
    policies: [policyOf("urgent"), policyOf("life-safety")],
    addresses: { pushover: { user: testKey(`casenine${place}user`) } },
  }));
}

/** The operation of a message of a line. */
export type LineOp = "alert" | "update" | "cancel";

/** The action of the VTEC string of a message. */
export type LineAction = "NEW" | "CON" | "EXA" | "CAN";

/** One message of an event line. The NWS message and its IPAWS copy have the same fields. */
export interface LineMessage {
  /** The name of the message in the line. */
  readonly name: string;
  readonly op: LineOp;
  readonly action: LineAction;
  readonly severity: "Moderate" | "Severe";
  /** The places that the message names. */
  readonly places: readonly CopyPlace[];
  /** The fetch of the time `sent`: the message is sent half an interval before this fetch. */
  readonly sent: number;
  /** The names of the earlier messages of the line that the message references. */
  readonly references: readonly string[];
  /** The first NWS fetch with the message. */
  readonly nws: number;
  /** The first IPAWS fetch with the copy of the message. */
  readonly ipaws: number;
}

/** An arm of the case. */
export type OrderArm = "control" | "ipaws-late" | "duplicates" | "cancel-first" | "update-first" | "partial-lone" | "partial-nws" | "re-entry";

/** The arms of the case. The run starts them at the same time, each with its own servers and clock. */
export const ORDER_ARMS: readonly OrderArm[] = ["control", "ipaws-late", "duplicates", "cancel-first", "update-first", "partial-lone", "partial-nws", "re-entry"];

const BOTH: readonly CopyPlace[] = ["kept", "dropped"];
const ALERT: LineMessage = { name: "alert", op: "alert", action: "NEW", severity: "Moderate", places: BOTH, references: [], sent: 2, nws: 2, ipaws: 2 };
const UPDATE: LineMessage = { name: "update", op: "update", action: "CON", severity: "Severe", places: BOTH, references: ["alert"], sent: 4, nws: 4, ipaws: 4 };
const CANCEL: LineMessage = { name: "cancel", op: "cancel", action: "CAN", severity: "Severe", places: BOTH, references: ["alert", "update"], sent: 6, nws: 6, ipaws: 6 };
const CANCEL_DROPPED: LineMessage = { ...CANCEL, name: "cancel-dropped", places: ["dropped"] };
const CONTINUE_KEPT: LineMessage = { ...UPDATE, name: "continue-kept", places: ["kept"], references: ["alert", "update"], sent: 6, nws: 6, ipaws: 6 };
const EXTEND: LineMessage = { ...UPDATE, name: "extend", action: "EXA", references: ["alert", "update", "cancel-dropped"], sent: 9, nws: 9, ipaws: 9 };

/** This function gives the event line of an arm, in the order of the times `sent`. */
export function lineOf(arm: OrderArm): LineMessage[] {
  switch (arm) {
    case "control":
    case "duplicates":
      return [ALERT, UPDATE, CANCEL];
    case "ipaws-late":
      return [
        { ...ALERT, ipaws: 8 },
        { ...UPDATE, ipaws: 9 },
        { ...CANCEL, ipaws: 10 },
      ];
    case "cancel-first":
      return [
        { ...ALERT, nws: 6, ipaws: 8 },
        { ...UPDATE, sent: 3, nws: 7, ipaws: 9 },
        { ...CANCEL, sent: 4, nws: 8, ipaws: 4 },
      ];
    case "update-first":
      return [
        { ...ALERT, severity: "Severe", nws: 5, ipaws: 6 },
        { ...UPDATE, severity: "Moderate", sent: 3, nws: 4, ipaws: 3 },
        { ...CANCEL, sent: 9, nws: 9, ipaws: 9 },
      ];
    case "partial-lone":
      return [ALERT, UPDATE, CANCEL_DROPPED];
    case "partial-nws":
      return [ALERT, UPDATE, CANCEL_DROPPED, CONTINUE_KEPT];
    case "re-entry":
      return [ALERT, UPDATE, CANCEL_DROPPED, EXTEND];
  }
}

/** One message of the line of an arm, with its id and its times. */
export interface LineReport {
  readonly arm: OrderArm;
  readonly message: LineMessage;
  /** The id of the NWS message. The identifier of the IPAWS copy is this id with `COPY_SUFFIX`. */
  readonly id: string;
  /** The time `sent`, in milliseconds since the epoch. */
  readonly sentAt: number;
  /** The end of the event, in milliseconds since the epoch. Each message of the line expires at this time. */
  readonly endAt: number;
  /** The id and the time `sent` of each message that the message references. */
  readonly references: readonly { readonly id: string; readonly sentAt: number }[];
}

/** This function gives the messages of the line of an arm, with their ids and times. */
export function lineReportsOf(arm: OrderArm, settings: OrderSettings = CASE_9_SETTINGS): LineReport[] {
  const line = lineOf(arm);
  const interval = NWS_DESCRIPTOR.interval;
  const sentAt = (message: LineMessage): number => settings.start + message.sent * interval - interval / 2;
  const first = line[0];
  if (first === undefined) throw new Error(`The arm ${arm} has no message.`);
  const endAt = sentAt(first) + EVENT_SPAN;
  const idOf = (name: string): string => `urn:oid:2.49.0.1.840.0.${sha256Hex(`${CASE_9_ID}-${arm}-${name}`).slice(0, 40)}.001.1`;
  const byName = new Map(line.map((message) => [message.name, message]));
  return line.map((message) => ({
    arm,
    message,
    id: idOf(message.name),
    sentAt: sentAt(message),
    endAt,
    references: message.references.map((name) => {
      const referenced = byName.get(name);
      if (referenced === undefined) throw new Error(`The message ${message.name} of the arm ${arm} references the unknown message ${name}.`);
      return { id: idOf(name), sentAt: sentAt(referenced) };
    }),
  }));
}

const MESSAGE_TYPES: Readonly<Record<LineOp, string>> = { alert: "Alert", update: "Update", cancel: "Cancel" };

/** The fields of the NEW message that the messages of the case do not keep: they name the real EXT message. */
const DROPPED_FIELDS: ReadonlySet<string> = new Set(["replacedBy", "replacedAt"]);

/** This function gives the VTEC string of a message of a line. Only a NEW message has the start of the event. */
export function lineVtecOf(report: Pick<LineReport, "message" | "sentAt" | "endAt">): string {
  const begin = report.message.action === "NEW" ? vtecTime(report.sentAt) : "000000T0000Z";
  return `/O.${report.message.action}.KEWX.FF.W.${ETN}.${begin}-${vtecTime(report.endAt)}/`;
}

const headlineOf = (report: LineReport): string => `Flash Flood Warning ${report.message.name} of the fault case by NWS Austin/San Antonio TX`;
const descriptionOf = (report: LineReport): string => `The message ${report.message.name} of the arm ${report.arm} of the fault case ${CASE_9_ID}.`;

/** This function gives the NWS feature of a message of a line, from the real NEW message. */
export function lineFeatureOf(report: LineReport, template: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const properties = template["properties"] as Readonly<Record<string, unknown>>;
  const parameters = properties["parameters"] as Readonly<Record<string, unknown>>;
  const url = `https://api.weather.gov/alerts/${report.id}`;
  const kept = Object.fromEntries(Object.entries(properties).filter(([name]) => !DROPPED_FIELDS.has(name)));
  const counties = report.message.places.map((place) => PLACE_COUNTIES[place]);
  return {
    ...template,
    id: url,
    geometry: null,
    properties: {
      ...kept,
      "@id": url,
      id: report.id,
      areaDesc: counties.map((county) => county.desc).join("; "),
      geocode: { SAME: counties.map((county) => county.same), UGC: counties.map((county) => county.ugc) },
      affectedZones: counties.map((county) => `https://api.weather.gov/zones/county/${county.ugc}`),
      references: report.references.map((reference) => ({
        "@id": `https://api.weather.gov/alerts/${reference.id}`,
        identifier: reference.id,
        sender: SENDER,
        sent: cstTime(reference.sentAt),
      })),
      sent: cstTime(report.sentAt),
      effective: cstTime(report.sentAt),
      onset: cstTime(report.sentAt),
      expires: cstTime(report.endAt),
      ends: cstTime(report.endAt),
      messageType: MESSAGE_TYPES[report.message.op],
      severity: report.message.severity,
      headline: headlineOf(report),
      description: descriptionOf(report),
      instruction: "Turn around, do not drown.",
      parameters: { ...parameters, VTEC: [lineVtecOf(report)], eventEndingTime: [cstTime(report.endAt)] },
    },
  };
}

/**
 * This function gives the IPAWS copy of a message of a line, from the real IPAWS copy of the NEW message. The copy keeps
 * the first `info` only. Its references name the IPAWS copies of the referenced messages.
 */
export function lineCopyOf(report: LineReport, template: string): string {
  const first = template.indexOf("<info>");
  const end = template.indexOf("</info>", first);
  if (first === -1 || end === -1) throw new Error("The template of the IPAWS copy has no info.");
  let head = template.slice(0, first);
  head = swap(head, /<identifier>[^<]*<\/identifier>/, `<identifier>${report.id}${COPY_SUFFIX}</identifier>`);
  head = swap(head, /<sent>[^<]*<\/sent>/, `<sent>${cstTime(report.sentAt)}</sent>`);
  head = swap(head, /<msgType>[^<]*<\/msgType>/, `<msgType>${MESSAGE_TYPES[report.message.op]}</msgType>`);
  if (report.references.length > 0) {
    const list = report.references.map((reference) => `${SENDER},${reference.id}${COPY_SUFFIX},${cstTime(reference.sentAt)}`).join(" ");
    // CAP puts the references after the codes.
    head = swap(head, /<code>IPAWSv1\.0<\/code>/, `<code>IPAWSv1.0</code><references>${list}</references>`);
  }
  let info = template.slice(first, end + "</info>".length);
  info = swap(info, /<severity>[^<]*<\/severity>/, `<severity>${report.message.severity}</severity>`);
  info = swap(info, /<effective>[^<]*<\/effective>/, `<effective>${cstTime(report.sentAt)}</effective>`);
  info = swap(info, /<onset>[^<]*<\/onset>/, `<onset>${cstTime(report.sentAt)}</onset>`);
  info = swap(info, /<expires>[^<]*<\/expires>/, `<expires>${cstTime(report.endAt)}</expires>`);
  info = swap(info, /<headline>[^<]*<\/headline>/, `<headline>${headlineOf(report)}</headline>`);
  info = swap(info, /<description>[\s\S]*?<\/description>/, `<description>${descriptionOf(report)}</description>`);
  info = swap(info, /<instruction>[\s\S]*?<\/instruction>/, "<instruction>Turn around, do not drown.</instruction>");
  info = swapParameter(info, "VTEC", lineVtecOf(report));
  info = swapParameter(info, "eventEndingTime", cstTime(report.endAt));
  const counties = report.message.places.map((place) => PLACE_COUNTIES[place]);
  const geocodes = [
    ...counties.map((county) => `<geocode><valueName>SAME</valueName><value>${county.same}</value></geocode>`),
    ...counties.map((county) => `<geocode><valueName>UGC</valueName><value>${county.ugc}</value></geocode>`),
  ].join("");
  info = swap(info, /<area>[\s\S]*<\/area>/, `<area><areaDesc>${counties.map((county) => county.desc).join("; ")}</areaDesc>${geocodes}</area>`);
  return `${head}${info}</alert>`;
}

/** This function gives a second form of an NWS feature: the same fields, with the properties in the reverse order. */
export function reorderedFeatureOf(feature: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const properties = feature["properties"] as Readonly<Record<string, unknown>>;
  return { ...feature, properties: Object.fromEntries(Object.entries(properties).reverse()) };
}

/** This function gives a second form of an IPAWS copy with the same elements. The form has a line break after the start tag and before the end tag. */
export function spacedCopyOf(copy: string): string {
  const close = "</alert>";
  const open = copy.indexOf(">") + 1;
  if (!copy.startsWith("<alert") || open === 0 || !copy.endsWith(close)) throw new Error("The IPAWS copy is not one alert element.");
  return `${copy.slice(0, open)}\n${copy.slice(open, copy.length - close.length)}\n${close}`;
}

/** The bodies of each route for each fetch of an arm. */
export interface OrderBodies {
  readonly zone: readonly string[];
  readonly canary: readonly Uint8Array[];
  readonly feed: readonly string[];
}

/**
 * This function gives the bodies of each fetch of an arm. Each NWS list keeps each message from its first fetch to the
 * end, thus no report leaves a complete list. Each IPAWS feed has each copy from its first fetch for `FEED_SPAN` fetches.
 */
export function orderBodiesOf(arm: OrderArm, settings: OrderSettings = CASE_9_SETTINGS, pair: PairFixtures = readPair()): OrderBodies {
  const twice = arm === "duplicates";
  const items = lineReportsOf(arm, settings).map((report) => {
    const feature = lineFeatureOf(report, pair.newFeature);
    const copy = lineCopyOf(report, pair.newCopy);
    return { message: report.message, feature, reordered: reorderedFeatureOf(feature), copy, spaced: spacedCopyOf(copy) };
  });
  const fetches = Array.from({ length: settings.fetches }, (_, fetch) => fetch);
  const listOf = (fetch: number): unknown[] =>
    items
      .filter((item) => item.message.nws <= fetch)
      .flatMap((item) => (twice ? [item.feature, item.feature, ...(item.message.nws < fetch ? [item.reordered] : [])] : [item.feature]));
  const copiesOf = (fetch: number): string[] =>
    items.flatMap((item) => {
      const age = fetch - item.message.ipaws;
      if (age < 0) return [];
      if (age < (twice ? DUPLICATE_FEEDS : FEED_SPAN)) return [item.copy];
      return twice && age === DUPLICATE_FEEDS ? [item.spaced] : [];
    });
  return {
    zone: fetches.map((fetch) => JSON.stringify({ type: "FeatureCollection", features: listOf(fetch) })),
    canary: fetches.map((fetch) => caseBodies({ keepaliveSent: settings.start + fetch * NWS_DESCRIPTOR.interval }).canary),
    feed: fetches.map((fetch) => feedOf(pair.emptyFeed, copiesOf(fetch))),
  };
}

/** One expected send of a person. */
export interface ExpectedSend {
  readonly level: Level;
  /** The index of the step in the escalation, from 0. */
  readonly step: number;
  /** The episode of the send, from 0. */
  readonly episode: number;
  /** True when the send has a cancel at the end of the arm. */
  readonly cancelled: boolean;
}

/** The expectation of one place in an arm. */
export interface PlaceExpectation {
  readonly sends: readonly ExpectedSend[];
  /** The count of the ends of the escalations of the person. */
  readonly ends: number;
  /** True when the place has a threat at the end of the arm. */
  readonly live: boolean;
  /** The threat is away from the first fetch with the message `from`, to the first fetch with the message `until` or the end. */
  readonly away?: { readonly from: string; readonly until?: string };
}

const sendOf = (level: Level, step: number, episode: number, cancelled: boolean): ExpectedSend => ({ level, step, episode, cancelled });
const RISE_SENDS: readonly ExpectedSend[] = [sendOf("urgent", 0, 0, true), sendOf("life-safety", 0, 0, true)];
const KEPT_LIVE: PlaceExpectation = { sends: [sendOf("urgent", 0, 0, true), sendOf("life-safety", 0, 0, false), sendOf("life-safety", 1, 0, false)], ends: 0, live: true };
const DROPPED_AWAY: PlaceExpectation = { sends: RISE_SENDS, ends: 1, live: false, away: { from: "cancel-dropped" } };

/**
 * This function gives the expectation of each place in an arm. A level that goes up cancels the sends of the lower level.
 * A cancel of the incident cancels each send. A cancel of the area of a place ends the escalations of its person.
 */
export function expectationOf(arm: OrderArm): Readonly<Record<CopyPlace, PlaceExpectation>> {
  const same = (one: PlaceExpectation): Readonly<Record<CopyPlace, PlaceExpectation>> => ({ kept: one, dropped: one });
  switch (arm) {
    case "control":
    case "ipaws-late":
    case "duplicates":
      return same({ sends: RISE_SENDS, ends: 0, live: false, away: { from: "cancel" } });
    case "cancel-first":
      return same({ sends: [], ends: 0, live: false, away: { from: "cancel" } });
    case "update-first":
      return same({ sends: [sendOf("urgent", 0, 0, true), sendOf("urgent", 1, 0, true)], ends: 0, live: false, away: { from: "cancel" } });
    case "partial-lone":
    case "partial-nws":
      return { kept: KEPT_LIVE, dropped: DROPPED_AWAY };
    case "re-entry":
      return {
        kept: KEPT_LIVE,
        dropped: { sends: [...RISE_SENDS, sendOf("life-safety", 0, 1, false), sendOf("life-safety", 1, 1, false)], ends: 1, live: true, away: { from: "cancel-dropped", until: "extend" } },
      };
  }
}

/** One delivery of the log, with its time after the start of the arm. */
export interface OrderDelivery {
  readonly key: string;
  readonly incident: string;
  readonly person: string;
  readonly level: Level;
  readonly step: number;
  /** The time of the accept of the channel. */
  readonly at: number;
  /** The Pushover receipt of the delivery. */
  readonly receipt?: string;
}

/** A delivery key with a time after the start of the arm. */
export interface TimedKey {
  readonly key: string;
  readonly at: number;
}

/** What the log of the runtime holds at the end of an arm. Each time is after the start of the arm. */
export interface OrderLog {
  readonly deliveries: readonly OrderDelivery[];
  /** The start of each send. */
  readonly attempts: readonly TimedKey[];
  readonly cancelled: readonly TimedKey[];
  /** Each end of the escalations of a person in a live incident. The incident is a report of the incident at the end. */
  readonly ends: readonly { readonly incident: string; readonly person: string; readonly at: number }[];
  readonly starts: readonly { readonly incident: string; readonly person: string; readonly level: Level; readonly at: number }[];
}

/** This function reads the sends, the cancels, the starts and the ends of the escalations of a log. */
export function orderLogOf(log: Pick<RuntimeLog, "read">, start: number): OrderLog {
  const deliveries: OrderDelivery[] = [];
  const attempts: TimedKey[] = [];
  const cancelled: TimedKey[] = [];
  const ends: { incident: string; person: string; at: number }[] = [];
  const starts: { incident: string; person: string; level: Level; at: number }[] = [];
  for (const event of log.read()) {
    if (event.type === "delivery") {
      const { delivery } = event;
      const receipt = delivery.receipt?.["receipt"];
      deliveries.push({
        key: delivery.key,
        incident: delivery.incident,
        person: delivery.person,
        level: delivery.level,
        step: delivery.step,
        at: delivery.at - start,
        ...(receipt === undefined ? {} : { receipt }),
      });
    } else if (event.type === "attempt") {
      attempts.push({ key: event.key, at: event.time - start });
    } else if (event.type === "cancelled") {
      cancelled.push({ key: event.delivery, at: event.time - start });
    } else if (event.type === "escalation-end") {
      ends.push({ incident: event.end.incident, person: event.end.person, at: event.end.at - start });
    } else if (event.type === "escalation") {
      starts.push({ incident: event.start.incident, person: event.start.person, level: event.start.level, at: event.start.at - start });
    }
  }
  return { deliveries, attempts, cancelled, ends, starts };
}

/** One send that the Pushover fake read whole. */
export interface LedgerEntry {
  readonly receipt: string;
  readonly priority: number;
  /** True when a cancel after the send reached the message. */
  readonly cancelled: boolean;
}

/** One fetch of a source: the time of its end after the start of the arm, and its outcome. */
export type OrderFetch = Pick<CopyFetch, "at" | "ok" | "complete" | "observations">;

/** A failed call of one pass. */
export interface OrderFailure {
  readonly at: number;
  readonly call: string;
  readonly kind: string;
  readonly message: string;
}

/** An incident with the status `system`: a line of the runtime about the health or the coverage of its sources, or a quota. */
export interface OrderSystemIncident {
  readonly anchor: string;
  /** The reports of the incident in each pass, with the anchor. */
  readonly reports: readonly string[];
  /** The code of the kind at the last pass with the incident. */
  readonly kind: string;
  /** The time of the first pass with the incident, from the start of the case clock. */
  readonly at: number;
}

/** The records of one arm. */
export interface OrderRecord {
  readonly arm: OrderArm;
  readonly fetches: Readonly<Record<"nws" | "ipaws", readonly OrderFetch[]>>;
  readonly log: OrderLog;
  readonly ledger: readonly LedgerEntry[];
  /** The count of requests to the Pushover fake that are not requests of the Pushover builders. */
  readonly otherRequests: number;
  /** True for each place with a threat at the last pass. */
  readonly live: Readonly<Record<CopyPlace, boolean>>;
  readonly failures: readonly OrderFailure[];
  /** The keys that the channel accepted again after the log had their delivery. */
  readonly duplicates: readonly string[];
  /** The incidents with the status `system` in each pass. Only the gate `system` counts their sends. */
  readonly system: readonly OrderSystemIncident[];
  readonly passes: number;
  /** The message of a throw of a pass. */
  readonly error?: string;
}

const fetchOf = (outcome: FetchOutcome, at: number): OrderFetch => ({
  at,
  ok: outcome.ok,
  complete: outcome.ok && outcome.complete,
  observations: outcome.ok ? outcome.observations.length : 0,
});

/**
 * This function starts one arm: a scripted server of the two sources, a Pushover fake, a new runtime and its passes on a
 * new clock. The passes continue to the end of the last fetch interval, thus the last cancels get to the log.
 */
export async function runOrderArm(arm: OrderArm, settings: OrderSettings = CASE_9_SETTINGS, pair: PairFixtures = readPair()): Promise<OrderRecord> {
  const bodies = orderBodiesOf(arm, settings, pair);
  const server = await startScriptedServer({
    routes: [
      { path: ROUTE_PATHS.zone, replies: bodies.zone.map((body) => ({ fields: GEO_JSON, body })) },
      { path: ROUTE_PATHS.canary, replies: bodies.canary.map((body) => ({ fields: GEO_JSON, body })) },
      { path: ROUTE_PATHS.feed, replies: bodies.feed.map((body) => ({ fields: XML, body })) },
    ],
  });
  // The fake keeps each receipt pending, thus no acknowledgment ends an escalation.
  const pushover = await startScriptedServer(pushoverApi({ receipts: RECEIPTS, tags: "any", state: "pending" }));
  const clock = caseClock(settings.start, settings.speed);
  const channel = createPushoverChannel({ token: testKey("caseninetoken"), fetch: pushoverFetchTo(pushover.url), now: clock.now });
  const none: ReadonlySet<number> = new Set();
  const counts: Record<CopyRoute, RouteCounts> = { zone: { direct: 0, proxied: 0 }, wea: { direct: 0, proxied: 0 }, canary: { direct: 0, proxied: 0 }, feed: { direct: 0, proxied: 0 } };
  const transport = copyTransport({ inner: fetchTransport({ userAgent: USER_AGENT }), direct: server.url, proxies: {}, faulted: { zone: none, wea: none, canary: none, feed: none }, counts });
  const jitter = random(`${CASE_9_ID}-${arm}`);
  // The pace of production: one scheduler for the two hosts on the case clock, with the jitter of the arm.
  const pace = { ...sourcePace({ now: clock.now, after: clock.after }, clock, 2), random: () => jitter.next() };
  const records: Record<"nws" | "ipaws", OrderFetch[]> = { nws: [], ipaws: [] };
  // The wrapper gives each argument to the source. A fetch that throws is a failed fetch of the record.
  const captured = (inner: SourceProcedures, into: OrderFetch[]): SourceProcedures => ({
    ...inner,
    fetch: async (...args: Parameters<SourceProcedures["fetch"]>) => {
      try {
        const outcome = await inner.fetch(...args);
        into.push(fetchOf(outcome, clock.now() - settings.start));
        return outcome;
      } catch (error) {
        into.push({ at: clock.now() - settings.start, ok: false, complete: false, observations: 0 });
        throw error;
      }
    },
  });
  // The case has no WEA expectation, thus the NWS source does not ask for the national WEA list.
  const nws = captured(createNwsSource({ pace, transport, userAgent: USER_AGENT, baseUrl: CASE_8_NWS, weaCopies: false }), records.nws);
  const ipaws = captured(createIpawsSource({ pace, transport, userAgent: USER_AGENT, baseUrl: CASE_8_IPAWS }), records.ipaws);
  const log = openRuntimeLog(":memory:");
  const failures: OrderFailure[] = [];
  const duplicates: string[] = [];
  const system = new Map<string, { reports: Set<string>; kind: string; at: number }>();
  let incidents: readonly Incident[] = [];
  let passes = 0;
  let error: string | undefined;
  try {
    const runtime = openRuntime({
      log,
      clock,
      sources: [nws, ipaws],
      watch: () => WATCH,
      view: VIEW,
      run: `${CASE_9_ID}-${arm}`,
      delivery: { recipients: orderRecipientsOf(), channels: [channel], ...DELIVERY_TIMES },
    });
    const end = settings.start + settings.fetches * NWS_DESCRIPTOR.interval;
    const done = (): boolean => records.nws.length >= settings.fetches && records.ipaws.length >= settings.fetches && clock.now() >= end;
    while (!done() && passes < PASSES_PER_FETCH * settings.fetches) {
      const result = await runtime.pass();
      passes += 1;
      incidents = result.view.incidents;
      for (const incident of incidents) {
        if (incident.status !== "system") continue;
        const seen = system.get(incident.anchor) ?? { reports: new Set<string>(), kind: incident.kind.code, at: result.at - settings.start };
        for (const report of [incident.anchor, ...incident.reports]) seen.reports.add(report);
        system.set(incident.anchor, { ...seen, kind: incident.kind.code });
      }
      duplicates.push(...(result.delivery?.duplicates ?? []));
      for (const failure of result.delivery?.failures ?? []) failures.push({ at: result.at - settings.start, call: failure.call, kind: failure.kind, message: failure.message });
      const next = Math.min(result.wakeAt ?? Number.POSITIVE_INFINITY, clock.now() + TICK);
      await clock.sleep(Math.max(0, next - clock.now()));
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const summary = orderLogOf(log, settings.start);
  log.close();
  await server.close();
  const ledger = pushoverLedgerOf([...pushover.requests]);
  await pushover.close();
  const found = threats(incidents, COPY_PLACES);
  const liveAt = (place: CopyPlace): boolean => found.some((threat) => threat.place === placeIdOf(place));
  return {
    arm,
    fetches: records,
    log: summary,
    ledger: ledger.messages.map((message) => ({ receipt: message.receipt, priority: message.priority, cancelled: message.cancelledAt !== undefined })),
    otherRequests: ledger.counts.other,
    live: { kept: liveAt("kept"), dropped: liveAt("dropped") },
    failures,
    duplicates,
    system: [...system].map(([anchor, seen]) => ({ anchor, reports: [...seen.reports].sort(), kind: seen.kind, at: seen.at })),
    passes,
    ...(error === undefined ? {} : { error }),
  };
}

/** The names of the gates of each place, in their order. */
export const ORDER_GATES = ["sends", "oneKey", "quietAway", "episodes", "ends", "cancels", "receipts", "live", "system"] as const;

/** A gate of a place. */
export type OrderGate = (typeof ORDER_GATES)[number];

/** A gate of a place, as `place:gate`. */
export type GateKey = `${CopyPlace}:${OrderGate}`;

/** The gates of each arm, in their order. */
export const GATE_KEYS: readonly GateKey[] = ORDER_PLACES.flatMap((place) => ORDER_GATES.map((gate): GateKey => `${place}:${gate}`));

const ABBREVIATIONS: Readonly<Record<Level, string>> = { "life-safety": "ls", urgent: "u", notice: "n", digest: "d" };

/** This function gives the label of a send: the level (`u` or `ls`), the step and the episode, and `c` for a send with a cancel. */
export function sendLabel(send: Pick<ExpectedSend, "level" | "step" | "episode"> & { readonly cancelled?: boolean }): string {
  return `${ABBREVIATIONS[send.level]}${String(send.step)}${String(send.episode)}${send.cancelled === true ? "c" : ""}`;
}

/** This function gives the end time of the first fetch with a message of the line of an arm. It gives `undefined` when no fetch has the message. */
export function arrivalOf(record: Pick<OrderRecord, "arm" | "fetches">, name: string): number | undefined {
  const message = lineOf(record.arm).find((one) => one.name === name);
  if (message === undefined) return undefined;
  const times = [record.fetches.nws[message.nws]?.at, record.fetches.ipaws[message.ipaws]?.at].filter((at): at is number => at !== undefined);
  return times.length === 0 ? undefined : Math.min(...times);
}

/** The gates of an arm, and the facts that decide them. */
export interface OrderResult {
  readonly gates: Readonly<Record<GateKey, boolean>>;
  /** The labels of the sends of each place, in the order of the log. */
  readonly sends: Readonly<Record<CopyPlace, readonly string[]>>;
  /** The count of the ends of the escalations of each person. */
  readonly ends: Readonly<Record<CopyPlace, number>>;
  /** The start time of each send of a person while the threat is away from the place. */
  readonly awaySends: Readonly<Record<CopyPlace, readonly number[]>>;
  /** The labels of the sends of the system incidents to the person of each place. Only the gate `system` counts them. */
  readonly systemSends: Readonly<Record<CopyPlace, readonly string[]>>;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * This function gives the gates of an arm from its record. The start of a send is the time of its `attempt` row. The episode of
 * a send is the count of the ends of its person before its start.
 */
export function orderGatesOf(record: OrderRecord): OrderResult {
  const expected = expectationOf(record.arm);
  const { log } = record;
  const cancelled = new Set(log.cancelled.map((one) => one.key));
  const attempts = new Map<string, number[]>();
  for (const attempt of log.attempts) attempts.set(attempt.key, [...(attempts.get(attempt.key) ?? []), attempt.at]);
  const delivered = new Set(log.deliveries.map((delivery) => delivery.key));
  const duplicated = new Set(record.duplicates);
  const orphan = log.attempts.some((attempt) => !delivered.has(attempt.key));
  const receipts = new Map(record.ledger.map((entry) => [entry.receipt, entry.cancelled]));
  const systemReports = new Set(record.system.flatMap((incident) => incident.reports));
  const gates: Partial<Record<GateKey, boolean>> = {};
  const sends: Partial<Record<CopyPlace, string[]>> = {};
  const ends: Partial<Record<CopyPlace, number>> = {};
  const away: Partial<Record<CopyPlace, number[]>> = {};
  const systemSends: Partial<Record<CopyPlace, string[]>> = {};
  for (const place of ORDER_PLACES) {
    const person: string = personOf(place);
    const keyOf = (gate: OrderGate): GateKey => `${place}:${gate}`;
    const want = expected[place];
    const all = log.deliveries.filter((delivery) => delivery.person === person);
    const mine = all.filter((delivery) => !systemReports.has(delivery.incident));
    const closes = log.ends.filter((one) => one.person === person && !systemReports.has(one.incident)).map((one) => one.at);
    const episodeOf = (at: number): number => closes.filter((close) => close < at).length;
    const startsOf = (delivery: OrderDelivery): number[] => attempts.get(delivery.key) ?? [delivery.at];
    const actual = mine.map((delivery) => ({
      delivery,
      level: delivery.level,
      step: delivery.step,
      episode: episodeOf(Math.min(...startsOf(delivery))),
      cancelled: cancelled.has(delivery.key),
    }));
    const plain = (send: Pick<ExpectedSend, "level" | "step" | "episode">): string => sendLabel({ ...send, cancelled: false });
    const from = want.away === undefined ? undefined : arrivalOf(record, want.away.from);
    const until = want.away?.until === undefined ? Number.POSITIVE_INFINITY : (arrivalOf(record, want.away.until) ?? Number.POSITIVE_INFINITY);
    const awaySends = from === undefined ? [] : mine.flatMap((delivery) => startsOf(delivery).filter((at) => at > from && at < until));
    const matched = want.sends.map((send) => actual.find((one) => plain(one) === plain(send)));
    gates[keyOf("sends")] = sameList(actual.map(plain).sort(), want.sends.map(plain).sort());
    gates[keyOf("oneKey")] = !orphan && !mine.some((delivery) => duplicated.has(delivery.key)) && new Set(mine.map((delivery) => delivery.key)).size === mine.length && mine.every((delivery) => attempts.get(delivery.key)?.length === 1);
    gates[keyOf("quietAway")] = want.away === undefined || (from !== undefined && awaySends.length === 0);
    gates[keyOf("episodes")] = actual.every(
      (one) => one.delivery.key === messageKey({ incident: one.delivery.incident as ReportId, level: one.level, person: one.delivery.person as PersonId, step: one.step, episode: one.episode }),
    );
    gates[keyOf("ends")] = closes.length === want.ends;
    gates[keyOf("cancels")] = want.sends.every((send, index) => {
      const found = matched[index];
      return found === undefined || found.cancelled === send.cancelled;
    });
    gates[keyOf("receipts")] = mine.every((delivery) => delivery.receipt === undefined || receipts.get(delivery.receipt) === cancelled.has(delivery.key));
    gates[keyOf("live")] = record.live[place] === want.live;
    gates[keyOf("system")] = all.every((delivery) => !systemReports.has(delivery.incident));
    sends[place] = actual.map((one) => sendLabel(one));
    ends[place] = closes.length;
    away[place] = awaySends;
    systemSends[place] = all
      .filter((delivery) => systemReports.has(delivery.incident))
      .map((delivery) => sendLabel({ level: delivery.level, step: delivery.step, episode: episodeOf(Math.min(...startsOf(delivery))), cancelled: cancelled.has(delivery.key) }));
  }
  return {
    gates: gates as Record<GateKey, boolean>,
    sends: sends as Record<CopyPlace, string[]>,
    ends: ends as Record<CopyPlace, number>,
    awaySends: away as Record<CopyPlace, number[]>,
    systemSends: systemSends as Record<CopyPlace, string[]>,
  };
}

/** A gate of an arm that fails because of a known fault of the core. */
export interface OrderKnownFault {
  readonly arm: OrderArm;
  readonly gate: GateKey;
  /** The fault, with the link of its fix. */
  readonly reason: string;
}

/**
 * The gates that fail because of a known fault of the core. The verdict expects each one to fail. The fix of a fault
 * removes its gates from this list, in the same change. The list is empty: alerts #127 fixed the cancel of a part,
 * the fault that the arms `partial-lone` and `re-entry` found.
 */
export const ORDER_KNOWN_FAULTS: readonly OrderKnownFault[] = [];

/** This function gives the known fault of a gate of an arm, or `undefined` when the gate has no known fault. */
export function orderKnownFaultOf(arm: OrderArm, gate: GateKey, known: readonly OrderKnownFault[] = ORDER_KNOWN_FAULTS): OrderKnownFault | undefined {
  return known.find((fault) => fault.arm === arm && fault.gate === gate);
}

/** The verdict of the case. A case with no read does not pass. */
export interface OrderVerdict {
  /** True when the settings are valid, and each arm has each fetch with no error. Each fetch is complete, and each call of the delivery succeeded. */
  readonly read: boolean;
  readonly results: Readonly<Partial<Record<OrderArm, OrderResult>>>;
  /** True when the case has a read, each gate passes, and each gate of `ORDER_KNOWN_FAULTS` fails. */
  readonly pass: boolean;
  readonly problems: readonly string[];
  /** Each gate of `ORDER_KNOWN_FAULTS` that passes. The fix of its fault removes it from the list. */
  readonly fixed: readonly string[];
}

/** This function gives each problem of the settings and of the lines of the arms. */
export function orderSettingsProblems(settings: OrderSettings): string[] {
  const problems: string[] = [];
  const interval = NWS_DESCRIPTOR.interval;
  if (IPAWS_DESCRIPTOR.interval !== interval) problems.push(`The IPAWS interval ${String(IPAWS_DESCRIPTOR.interval)} is not the NWS interval ${String(interval)}.`);
  if (!Number.isFinite(settings.speed) || settings.speed < 1) problems.push(`The speed ${String(settings.speed)} is not a finite number of 1 or more.`);
  if (EVENT_SPAN <= (settings.fetches + 1) * interval) problems.push("The event ends in the arm.");
  // The second step of the last start comes in the arm, with one interval for its pass.
  const steps = Math.ceil(STEP_GAP / interval) + 1;
  for (const arm of ORDER_ARMS) {
    for (const message of lineOf(arm)) {
      if (message.nws < message.sent || message.ipaws < message.sent) problems.push(`${arm}: the message ${message.name} comes before its time sent.`);
      if (Math.max(message.nws, message.ipaws) + steps >= settings.fetches) problems.push(`${arm}: the message ${message.name} comes too late for a second step in the arm.`);
    }
  }
  return problems;
}

/** This function gives the verdict of the records of a run. The verdict expects each gate of `known` to fail. */
export function orderVerdictOf(records: readonly OrderRecord[], settings: OrderSettings = CASE_9_SETTINGS, known: readonly OrderKnownFault[] = ORDER_KNOWN_FAULTS): OrderVerdict {
  const problems = orderSettingsProblems(settings);
  for (const arm of ORDER_ARMS) {
    const count = records.filter((record) => record.arm === arm).length;
    if (count !== 1) problems.push(`${arm}: ${String(count)} records, not 1.`);
  }
  for (const record of records) {
    if (record.error !== undefined) problems.push(`${record.arm}: a pass threw: ${record.error}`);
    for (const source of ["nws", "ipaws"] as const) {
      const list = record.fetches[source];
      if (list.length < settings.fetches) problems.push(`${record.arm}: ${String(list.length)} ${source} fetches, not ${String(settings.fetches)}.`);
      const bad = list.flatMap((fetch, at) => (fetch.ok && fetch.complete ? [] : [at]));
      if (bad.length > 0) problems.push(`${record.arm}: the ${source} fetches ${bad.join(", ")} failed or are not complete.`);
    }
    if (record.failures.length > 0) problems.push(`${record.arm}: ${String(record.failures.length)} calls of the delivery failed, the first: ${record.failures[0]?.message ?? ""}`);
    if (record.otherRequests > 0) problems.push(`${record.arm}: the Pushover fake got ${String(record.otherRequests)} unknown requests.`);
  }
  const read = problems.length === 0;
  const results: Partial<Record<OrderArm, OrderResult>> = {};
  for (const record of records) results[record.arm] = orderGatesOf(record);
  const expected = (arm: OrderArm, gate: GateKey): boolean => orderKnownFaultOf(arm, gate, known) === undefined;
  const fixed = ORDER_ARMS.flatMap((arm) =>
    GATE_KEYS.filter((gate) => !expected(arm, gate) && results[arm]?.gates[gate] === true).map(
      (gate) => `${arm}: the gate ${gate} passes. Its known fault is fixed: remove it from ORDER_KNOWN_FAULTS.`,
    ),
  );
  const failed = ORDER_ARMS.flatMap((arm) => GATE_KEYS.filter((gate) => expected(arm, gate) && results[arm]?.gates[gate] !== true).map((gate) => `${arm}: the gate ${gate} fails.`));
  const pass = read && fixed.length === 0 && failed.length === 0;
  return { read, results, pass, problems: [...problems, ...failed], fixed };
}

/** The records of one run of the case. */
export interface OrderRun {
  readonly id: string;
  readonly seed: string;
  readonly settings: OrderSettings;
  readonly records: readonly OrderRecord[];
  readonly verdict: OrderVerdict;
}

/** This function starts the case: each arm at the same time. It gives the records and the verdict. */
export async function runOutOfOrder(given: Partial<OrderSettings> = {}): Promise<OrderRun> {
  const settings: OrderSettings = { ...CASE_9_SETTINGS, ...given };
  const pair = readPair();
  const records = await Promise.all(ORDER_ARMS.map((arm) => runOrderArm(arm, settings, pair)));
  return { id: CASE_9_ID, seed: CASE_9_ID, settings, records, verdict: orderVerdictOf(records, settings) };
}
