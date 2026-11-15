/**
 * The map function of the NWS API source: one observation (one alert of the API, a GeoJSON
 * feature) to reports in the one format of the system. The function is pure and total.
 */

import type {
  Area,
  Category,
  Certainty,
  CorrelationKey,
  Instant,
  MapProblem,
  MapResult,
  Observation,
  Operation,
  Position,
  Report,
  ResponseType,
  Severity,
  SourceId,
  Status,
  Urgency,
} from "@mark1russell7/alerts";
import { Problems, reportId } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";

import { categoryOf, isSameCode, isUgcCode, parseVtec, resolveKind, vtecKey, type Vtec } from "@mark1russell7/alerts-format-nws";

/** The id of this source. */
export const SOURCE_ID = "nws-api" as SourceId;

/** The authority that issues each message of this source: the NWS. The descriptor lists it in `origins`. */
export const ORIGIN = "nws";

/** The fields of the properties of an NWS alert that the map function knows. A different field is a problem. */
export const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "@id",
  "@type",
  "id",
  "areaDesc",
  "geocode",
  "affectedZones",
  "references",
  "sent",
  "effective",
  "onset",
  "expires",
  "ends",
  "status",
  "messageType",
  "category",
  "severity",
  "certainty",
  "urgency",
  "event",
  "sender",
  "senderName",
  "headline",
  "description",
  "instruction",
  "response",
  "note",
  "parameters",
  "scope",
  "code",
  "language",
  "web",
  "eventCode",
]);

const STATUS: ReadonlySet<string> = new Set<Status>(["actual", "exercise", "system", "test", "draft"]);
const OPERATIONS: ReadonlySet<string> = new Set<Operation>(["alert", "update", "cancel"]);
const SEVERITY: ReadonlySet<string> = new Set<Severity>(["extreme", "severe", "moderate", "minor", "unknown"]);
const URGENCY: ReadonlySet<string> = new Set<Urgency>(["immediate", "expected", "future", "past", "unknown"]);
const CERTAINTY: ReadonlySet<string> = new Set<Certainty>(["observed", "likely", "possible", "unlikely", "unknown"]);
const RESPONSES: ReadonlySet<string> = new Set<ResponseType>([
  "shelter",
  "evacuate",
  "prepare",
  "execute",
  "avoid",
  "monitor",
  "assess",
  "allclear",
  "none",
]);
const CATEGORIES: ReadonlySet<string> = new Set<Category>([
  "geo",
  "met",
  "safety",
  "security",
  "rescue",
  "fire",
  "health",
  "env",
  "transport",
  "infra",
  "cbrne",
  "other",
]);
/** The CAP message types that are not alerts. They give no report and no problem. */
const NOT_ALERTS: ReadonlySet<string> = new Set(["ack", "error"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
/** This function gives a list of the texts of a value: a text, or a list of texts. */
const textsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** This function reads a time of the message. An absent time gives `undefined`, and a bad time is a problem. */
function timeOf(value: unknown, path: string, problems: Problems): Instant | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    problems.add(path, `the time ${JSON.stringify(value)} is not an ISO 8601 time with a zone`);
    return undefined;
  }
  return Date.parse(value);
}

/** This function reads one value of a CAP list of values, in lower case. An unknown value is a problem. */
function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>, fallback: T, path: string, problems: Problems): T {
  const text = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  if (text !== undefined && allowed.has(text)) return text as T;
  if (value !== null && value !== undefined) problems.add(path, `the value ${JSON.stringify(value)} is not known: the map uses ${fallback}`);
  else if (fallback !== "unknown") problems.add(path, `the value is absent: the map uses ${fallback}`);
  return fallback;
}

const isPosition = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length >= 2 &&
  typeof value[0] === "number" &&
  typeof value[1] === "number" &&
  Math.abs(value[0]) <= 180 &&
  Math.abs(value[1]) <= 90;

/**
 * This function reads the rings of one GeoJSON polygon. A bad hole is a problem, and the area does not
 * have it. A bad outside ring is a problem, and the function gives no area.
 */
function polygonOf(rings: unknown, path: string, problems: Problems): Area | undefined {
  if (!Array.isArray(rings) || rings.length === 0) {
    problems.add(path, "the polygon has no rings");
    return undefined;
  }
  const good: Position[][] = [];
  for (const [index, ring] of rings.entries()) {
    if (!Array.isArray(ring) || ring.length < 3 || !ring.every(isPosition)) {
      problems.add(`${path}[${index}]`, "the ring has fewer than 3 positions, or a position that is not a longitude and a latitude");
      if (index === 0) return undefined;
      continue;
    }
    const positions: Position[] = ring.map(([lon, lat]) => [lon, lat] as const);
    const first = positions[0]!;
    const last = positions[positions.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      problems.add(`${path}[${index}]`, "the ring does not close: the map closes it");
      positions.push(first);
    }
    good.push(positions);
  }
  return { type: "polygon", rings: good };
}

/**
 * This function reads the areas of an alert: its geometry and its region codes. A code of an unknown form
 * is a problem, and the function drops it, because it matches no watch.
 */
function areasOf(feature: JsonObject, properties: JsonObject, problems: Problems): Area[] {
  const areas: Area[] = [];
  const geometry = feature["geometry"];
  if (isObject(geometry)) {
    const type = geometry["type"];
    if (type === "Polygon") {
      const polygon = polygonOf(geometry["coordinates"], "geometry.coordinates", problems);
      if (polygon !== undefined) areas.push(polygon);
    } else if (type === "MultiPolygon" && Array.isArray(geometry["coordinates"])) {
      geometry["coordinates"].forEach((rings, index) => {
        const polygon = polygonOf(rings, `geometry.coordinates[${index}]`, problems);
        if (polygon !== undefined) areas.push(polygon);
      });
    } else {
      problems.add("geometry.type", `the geometry ${JSON.stringify(type)} is not a Polygon or a MultiPolygon`);
    }
  } else if (geometry !== null && geometry !== undefined) {
    problems.add("geometry", "the geometry is not an object");
  }
  const geocode = properties["geocode"];
  if (!isObject(geocode)) {
    problems.add("properties.geocode", geocode === undefined ? "the alert has no geocode" : "the geocode is not an object");
    return areas;
  }
  for (const field of Object.keys(geocode)) {
    if (!(field in REGION_CODES)) problems.add(`properties.geocode.${field}`, "the map function does not know this field");
  }
  for (const [field, { system, normal, valid }] of Object.entries(REGION_CODES)) {
    const value = geocode[field];
    const items: readonly Json[] | undefined = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
    if (items === undefined) {
      problems.add(`properties.geocode.${field}`, `the geocode has no ${field} list`);
      continue;
    }
    items.forEach((item, index) => {
      const code = typeof item === "string" ? normal(item) : undefined;
      if (code !== undefined && valid(code)) areas.push({ type: "code", system, code });
      else problems.add(`properties.geocode.${field}[${index}]`, `the value ${JSON.stringify(item)} is not a ${field} code`);
    });
  }
  return areas;
}

/** The region code lists of the geocode of an NWS alert, with the system, the normal form and the check of each code. */
const REGION_CODES: Readonly<Record<string, { system: string; normal: (text: string) => string; valid: (code: string) => boolean }>> = {
  UGC: { system: "ugc", normal: (text) => text.trim().toUpperCase(), valid: isUgcCode },
  SAME: { system: "same", normal: (text) => text.trim(), valid: isSameCode },
};

/** This function reads the CAP references: the current list and the expired list of the NWS. */
function referencesOf(properties: JsonObject, key: string, parameters: JsonObject | undefined): string[] {
  const keys = new Set<string>();
  const references = properties["references"];
  if (Array.isArray(references)) {
    for (const reference of references) {
      const identifier = isObject(reference) ? textOf(reference["identifier"]) : undefined;
      if (identifier !== undefined) keys.add(identifier);
    }
  }
  // Each expired reference is "sender,identifier,sent", and the references are separated by spaces
  for (const text of textsOf(parameters?.["expiredReferences"])) {
    for (const reference of text.trim().split(/\s+/)) {
      const identifier = reference.split(",")[1];
      if (identifier !== undefined && identifier !== "") keys.add(identifier);
    }
  }
  keys.delete(key);
  return [...keys];
}

/** This function gives the name and value pairs of the message that the report does not hold in a field of its own. */
function parametersOf(properties: JsonObject, parameters: JsonObject | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(parameters ?? {})) {
    if (name === "expiredReferences") continue;
    result[name] = Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))) : [typeof value === "string" ? value : JSON.stringify(value)];
  }
  const eventCode = properties["eventCode"];
  if (isObject(eventCode)) {
    for (const [name, value] of Object.entries(eventCode)) result[`eventCode.${name}`] = textsOf(value);
  }
  for (const name of ["note", "scope", "code", "language", "@id"]) {
    const value = textOf(properties[name]);
    if (value !== undefined) result[name] = [value];
  }
  return result;
}

/** The fields of an object that have a value. A field with the value `undefined` is not in the result. */
type Present<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** This function removes the fields with the value `undefined` from an object. */
function withoutAbsent<T extends object>(value: T): Present<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Present<T>;
}

/** This function maps one alert (a GeoJSON feature) to a report, or to no report and its problems. */
function mapFeature(feature: unknown, observation: Observation, problems: Problems): Report | undefined {
  if (!isObject(feature) || feature["type"] !== "Feature") {
    problems.add("", "the message is not a GeoJSON feature", true);
    return undefined;
  }
  const properties = feature["properties"];
  if (!isObject(properties)) {
    problems.add("properties", "the feature has no properties", true);
    return undefined;
  }
  for (const field of Object.keys(properties)) {
    if (!KNOWN_FIELDS.has(field)) problems.add(`properties.${field}`, "the map function does not know this field");
  }
  const key = textOf(properties["id"]);
  if (key === undefined) {
    problems.add("properties.id", "the alert has no identifier", true);
    return undefined;
  }
  const sent = timeOf(properties["sent"], "properties.sent", problems);
  if (sent === undefined) {
    problems.add("properties.sent", "the alert has no valid sent time", true);
    return undefined;
  }
  const messageType = typeof properties["messageType"] === "string" ? properties["messageType"].trim().toLowerCase() : undefined;
  if (messageType !== undefined && NOT_ALERTS.has(messageType)) return undefined;

  const parameters = isObject(properties["parameters"]) ? properties["parameters"] : undefined;
  const vtec: Vtec[] = [];
  for (const text of textsOf(parameters?.["VTEC"])) {
    const parsed = parseVtec(text);
    if (parsed === undefined) problems.add("properties.parameters.VTEC", `the text ${JSON.stringify(text)} is not a P-VTEC string`);
    else vtec.push(parsed);
  }
  const eventCode = isObject(properties["eventCode"]) ? properties["eventCode"] : undefined;
  const nwsCode = textsOf(eventCode?.["NationalWeatherService"])[0];
  const sameCode = textsOf(eventCode?.["SAME"])[0];
  const name = textOf(properties["event"]);
  const resolved = resolveKind({
    vtec,
    ...(nwsCode === undefined ? {} : { nwsCode }),
    ...(sameCode === undefined ? {} : { sameCode }),
    ...(name === undefined ? {} : { name }),
  });
  if (!resolved.known) problems.add("properties.event", `the kind tables do not know the event ${JSON.stringify(name ?? nwsCode ?? sameCode)}`);

  const categories = textsOf(properties["category"])
    .map((category) => category.trim().toLowerCase())
    .filter((category) => {
      if (CATEGORIES.has(category)) return true;
      problems.add("properties.category", `the category ${JSON.stringify(category)} is not a CAP category`);
      return false;
    }) as Category[];
  if (categories.length === 0) categories.push(categoryOf(resolved.kind.code));

  const response = textsOf(properties["response"])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => {
      if (RESPONSES.has(value)) return true;
      problems.add("properties.response", `the response ${JSON.stringify(value)} is not a CAP response`);
      return false;
    }) as ResponseType[];

  const correlation = new Map<string, CorrelationKey>();
  for (const one of vtec) {
    if (one.productClass !== "O") continue;
    const correlationKey = vtecKey(one, sent);
    correlation.set(correlationKey.id, correlationKey);
  }

  // A field with no value is absent from the report, so two copies of one report are equal
  const optional = withoutAbsent({
    effective: timeOf(properties["effective"], "properties.effective", problems),
    onset: timeOf(properties["onset"], "properties.onset", problems),
    expires: timeOf(properties["expires"], "properties.expires", problems),
    ends: timeOf(properties["ends"], "properties.ends", problems),
    areaText: textOf(properties["areaDesc"]),
    description: textOf(properties["description"]),
    instruction: textOf(properties["instruction"]),
    web: textOf(properties["web"]),
  });
  // Each NWS alert has region codes. Only a code matches a watch until the core can match shapes, so an
  // alert with no valid code reaches nobody. A changed format gives this case, and health must show it.
  const areas = areasOf(feature, properties, problems);
  if (!areas.some((area) => area.type === "code")) {
    problems.add("properties.geocode", "the alert has no valid region code: no watch can match it", true);
    return undefined;
  }
  const report: Report = {
    id: reportId({ source: SOURCE_ID, key, sent }),
    source: SOURCE_ID,
    origin: ORIGIN,
    key,
    references: referencesOf(properties, key, parameters),
    correlation: [...correlation.values()],
    status: oneOf<Status>(properties["status"], STATUS, "actual", "properties.status", problems),
    op: oneOf<Operation>(messageType, OPERATIONS, "alert", "properties.messageType", problems),
    kind: resolved.kind,
    categories,
    severity: oneOf<Severity>(properties["severity"], SEVERITY, "unknown", "properties.severity", problems),
    urgency: oneOf<Urgency>(properties["urgency"], URGENCY, "unknown", "properties.urgency", problems),
    certainty: oneOf<Certainty>(properties["certainty"], CERTAINTY, "unknown", "properties.certainty", problems),
    response,
    sent,
    received: observation.fetched,
    areas,
    about: [],
    sender: textOf(properties["senderName"]) ?? textOf(properties["sender"]) ?? "NWS",
    headline: textOf(properties["headline"]) ?? textsOf(parameters?.["NWSheadline"])[0] ?? name ?? key,
    observation: observation.id,
    parameters: parametersOf(properties, parameters),
    ...optional,
  };
  return report;
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation): MapResult {
  let body: unknown;
  try {
    body = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  const features = isObject(body) && body["type"] === "FeatureCollection" && Array.isArray(body["features"]) ? body["features"] : undefined;
  const messages: { readonly feature: unknown; readonly path: string }[] =
    features === undefined ? [{ feature: body, path: "" }] : features.map((feature, index) => ({ feature, path: `features[${index}]` }));
  const reports: Report[] = [];
  const problems: MapProblem[] = [];
  for (const message of messages) {
    const own = new Problems(message.path);
    const report = mapFeature(message.feature, observation, own);
    if (report !== undefined) reports.push(report);
    problems.push(...own.list);
  }
  return { reports, problems };
}

/**
 * This function maps one observation of the NWS API to reports. The body is one alert (a GeoJSON
 * feature) or a list of alerts (a feature collection). The function does not throw: an error is a fatal problem.
 */
export function mapObservation(observation: Observation): MapResult {
  try {
    return mapOrThrow(observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
