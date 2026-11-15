/**
 * The map function of the IPAWS source: one observation (one CAP alert of the public feed of FEMA
 * IPAWS) to one report in the one format of the system. The function is pure and total.
 */

import type {
  Area,
  Category,
  Certainty,
  CorrelationKey,
  MapProblem,
  MapResult,
  Observation,
  Operation,
  Report,
  ResponseType,
  Severity,
  SourceId,
  Status,
  Urgency,
} from "@mark1russell7/alerts";
import { categoryOf, Problems, reportId } from "@mark1russell7/alerts";
import {
  CAP_CATEGORIES,
  CAP_CERTAINTY,
  CAP_NOT_ALERTS,
  CAP_OPERATIONS,
  CAP_RESPONSES,
  CAP_SEVERITY,
  CAP_STATUS,
  CAP_URGENCY,
  capCircle,
  capPolygon,
  capTime,
  capValue,
  chooseInfo,
  DEFAULT_LANGUAGES,
  readCap,
  type CapAlert,
  type CapInfo,
  type CapPair,
} from "@mark1russell7/alerts-format-cap";
import { parseVtec, resolveKind, vtecKey, type Vtec } from "@mark1russell7/alerts-format-nws";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "ipaws" as SourceId;

/**
 * The authorities of the messages of IPAWS. The NWS sends its messages for Wireless Emergency
 * Alerts (WEA) to IPAWS. Each other message comes from an alerting authority of IPAWS: a state, a
 * county, a city or a federal agency. The descriptor lists both in `origins`.
 */
export const ORIGINS = { nws: "nws", authority: "ipaws-authority" } as const;

/** The sender of each message of the NWS in IPAWS. */
export const NWS_SENDER = "w-nws.webmaster@noaa.gov";

/** The names of the event codes of the NWS. IPAWS gives `NationalWeatherService`, and the NWS API also gives `NWS`. */
const NWS_CODE_NAMES: readonly string[] = ["NationalWeatherService", "NWS"];

/** The names of the geocodes that the map knows, and the system of the region code of each. */
const GEOCODES: Readonly<Record<string, string>> = { UGC: "ugc", SAME: "same" };

/** This function gives the authority of a message from its sender. */
export function originOf(sender: string): string {
  return sender.trim().toLowerCase() === NWS_SENDER ? ORIGINS.nws : ORIGINS.authority;
}

/** This function gives the values of each pair with the name, in order. The case of the name is significant. */
const valuesOf = (pairs: readonly CapPair[], name: string): string[] => pairs.filter((pair) => pair.valueName === name).map((pair) => pair.value);

/** This function gives the name and value pairs as lists of values by name, in the order of the message. */
function grouped(pairs: readonly CapPair[], prefix = ""): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const pair of pairs) (result[`${prefix}${pair.valueName}`] ??= []).push(pair.value);
  return result;
}

/** This function reads the areas of the chosen info blocks: the polygons, the circles and the geocodes. */
function areasOf(blocks: readonly { readonly info: CapInfo; readonly index: number }[], problems: Problems): Area[] {
  const areas: Area[] = [];
  const codes = new Set<string>();
  for (const { info, index } of blocks) {
    info.areas.forEach((area, at) => {
      const path = `info[${String(index)}].area[${String(at)}]`;
      area.polygons.forEach((text, one) => {
        const polygon = capPolygon(text, `${path}.polygon[${String(one)}]`, problems);
        if (polygon !== undefined) areas.push(polygon);
      });
      area.circles.forEach((text, one) => {
        const circle = capCircle(text, `${path}.circle[${String(one)}]`, problems);
        if (circle !== undefined) areas.push(circle);
      });
      for (const geocode of area.geocodes) {
        const system = GEOCODES[geocode.valueName];
        if (system === undefined) {
          problems.add(`${path}.geocode`, `the map function does not know the geocode ${JSON.stringify(geocode.valueName)}`);
          continue;
        }
        const code = system === "ugc" ? geocode.value.trim().toUpperCase() : geocode.value.trim();
        // Two blocks of one language can name one region: the report has it one time
        if (code === "" || codes.has(`${system}:${code}`)) continue;
        codes.add(`${system}:${code}`);
        areas.push({ type: "code", system, code });
      }
    });
  }
  return areas;
}

/**
 * This function gives the name and value pairs that the report does not hold in a field of its own.
 * These are the parameters, the event codes and some elements of the message.
 */
function parametersOf(alert: CapAlert, info: CapInfo | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = info === undefined ? {} : { ...grouped(info.parameters), ...grouped(info.eventCodes, "eventCode.") };
  const single = { note: alert.note, scope: alert.scope, source: alert.source, restriction: alert.restriction, language: info?.language, audience: info?.audience, contact: info?.contact };
  for (const [name, value] of Object.entries(single)) if (value !== undefined && value.trim() !== "") result[name] = [value];
  if (alert.codes.length > 0) result["code"] = [...alert.codes];
  if (alert.incidents.length > 0) result["incidents"] = [...alert.incidents];
  return result;
}

/** The fields of an object that have a value. A field with the value `undefined` is not in the result. */
type Present<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** This function removes the fields with the value `undefined` from an object. */
function withoutAbsent<T extends object>(value: T): Present<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Present<T>;
}

/** This function reads the values of a CAP list that the core knows, in lower case. A different value is a problem. */
function knownValues<T extends string>(values: readonly string[], allowed: ReadonlySet<string>, path: string, what: string, problems: Problems): T[] {
  const known: T[] = [];
  for (const value of values) {
    const text = value.trim().toLowerCase();
    if (allowed.has(text)) known.push(text as T);
    else problems.add(path, `the ${what} ${JSON.stringify(value)} is not a CAP ${what}`);
  }
  return known;
}

/** This function maps one CAP message to a report, or to no report and its problems. */
function mapAlert(alert: CapAlert, observation: Observation, languages: readonly string[], problems: Problems): Report | undefined {
  const key = alert.identifier.trim();
  if (key === "") {
    problems.add("identifier", "the alert has no identifier", true);
    return undefined;
  }
  const sent = capTime(alert.sent, "sent", problems);
  if (sent === undefined) {
    problems.add("sent", "the alert has no valid sent time", true);
    return undefined;
  }
  const messageType = alert.msgType.trim().toLowerCase();
  if (CAP_NOT_ALERTS.has(messageType)) return undefined;

  const chosen = chooseInfo(alert.infos, languages);
  const info = chosen?.info;
  if (chosen === undefined) problems.add("info", "the message has no info block: the report has no kind and no area");
  // CAP can split one message into blocks of one language, each with its areas. The report has the areas of each block.
  const blocks = chosen === undefined ? [] : alert.infos.flatMap((one, index) => (one.language.toLowerCase() === chosen.info.language.toLowerCase() ? [{ info: one, index }] : []));
  if (chosen !== undefined && chosen.sameLanguage > 1) {
    problems.add("info", `the message has ${String(chosen.sameLanguage)} info blocks in the language ${chosen.info.language}: the report has the fields of block ${String(chosen.index)} and the areas of each block`);
  }
  const at = chosen === undefined ? "info" : `info[${String(chosen.index)}]`;
  const parameters = info?.parameters ?? [];

  const vtec: Vtec[] = [];
  for (const text of valuesOf(parameters, "VTEC")) {
    const parsed = parseVtec(text);
    if (parsed === undefined) problems.add(`${at}.parameter.VTEC`, `the text ${JSON.stringify(text)} is not a P-VTEC string`);
    else vtec.push(parsed);
  }
  const eventCodes = info?.eventCodes ?? [];
  const nwsCode = NWS_CODE_NAMES.map((name) => valuesOf(eventCodes, name)[0]).find((value) => value !== undefined);
  const sameCode = valuesOf(eventCodes, "SAME")[0];
  const name = info?.event.trim() === "" ? undefined : info?.event.trim();
  const resolved = resolveKind({
    vtec,
    ...(nwsCode === undefined ? {} : { nwsCode }),
    ...(sameCode === undefined ? {} : { sameCode }),
    ...(name === undefined ? {} : { name }),
  });
  if (!resolved.known && info !== undefined) problems.add(`${at}.event`, `the kind tables do not know the event ${JSON.stringify(name ?? nwsCode ?? sameCode)}`);

  const categories = knownValues<Category>(info?.categories ?? [], CAP_CATEGORIES, `${at}.category`, "category", problems);
  if (categories.length === 0) categories.push(categoryOf(resolved.kind.code));
  const response = knownValues<ResponseType>(info?.responseTypes ?? [], CAP_RESPONSES, `${at}.responseType`, "response", problems);

  // Only an operational VTEC (class O) names an event of the NWS. A test or an experiment does not join an incident.
  const correlation = new Map<string, CorrelationKey>();
  for (const one of vtec) {
    if (one.productClass !== "O") continue;
    const correlationKey = vtecKey(one, sent);
    correlation.set(correlationKey.id, correlationKey);
  }

  const references = new Set(alert.references.map((reference) => reference.identifier.trim()).filter((identifier) => identifier !== ""));
  references.delete(key);
  const areaText = [...new Set(blocks.flatMap(({ info: one }) => one.areas.map((area) => area.areaDesc.trim())).filter((text) => text !== ""))].join("; ");

  // A field with no value is absent from the report, so two copies of one report are equal
  const optional = withoutAbsent({
    effective: capTime(info?.effective, `${at}.effective`, problems),
    onset: capTime(info?.onset, `${at}.onset`, problems),
    expires: capTime(info?.expires, `${at}.expires`, problems),
    ends: capTime(valuesOf(parameters, "eventEndingTime")[0], `${at}.parameter.eventEndingTime`, problems),
    areaText: areaText === "" ? undefined : areaText,
    description: info?.description,
    instruction: info?.instruction,
    web: info?.web,
  });
  return {
    id: reportId({ source: SOURCE_ID, key, sent }),
    source: SOURCE_ID,
    origin: originOf(alert.sender),
    key,
    references: [...references],
    correlation: [...correlation.values()],
    status: capValue<Status>(alert.status, CAP_STATUS, "actual", "status", problems),
    op: capValue<Operation>(messageType, CAP_OPERATIONS, "alert", "msgType", problems),
    kind: resolved.kind,
    categories,
    severity: capValue<Severity>(info?.severity, CAP_SEVERITY, "unknown", `${at}.severity`, problems),
    urgency: capValue<Urgency>(info?.urgency, CAP_URGENCY, "unknown", `${at}.urgency`, problems),
    certainty: capValue<Certainty>(info?.certainty, CAP_CERTAINTY, "unknown", `${at}.certainty`, problems),
    response,
    sent,
    received: observation.fetched,
    areas: areasOf(blocks, problems),
    about: [],
    sender: info?.senderName?.trim() || alert.sender,
    headline: info?.headline?.trim() || valuesOf(parameters, "NWSheadline")[0] || name || key,
    observation: observation.id,
    parameters: parametersOf(alert, info),
    ...optional,
  };
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation, languages: readonly string[]): MapResult {
  const read = readCap(observation.body);
  if (!read.ok) return { reports: [], problems: [{ path: "", message: `the body is not a CAP message: ${read.reason}`, fatal: true }] };
  const problems = new Problems();
  const report = mapAlert(read.alert, observation, languages, problems);
  const all: MapProblem[] = [...read.problems, ...problems.list];
  return { reports: report === undefined ? [] : [report], problems: all };
}

/**
 * This function maps one observation of IPAWS to reports. The body is one CAP alert. The report
 * has the fields of the info block in the first language of `languages` that the message has. The
 * function does not throw: an error is a fatal problem. It does not read the transport of the observation.
 */
export function mapObservation(observation: Observation, languages: readonly string[] = DEFAULT_LANGUAGES): MapResult {
  try {
    return mapOrThrow(observation, languages);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
