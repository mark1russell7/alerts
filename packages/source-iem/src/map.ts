/**
 * The map function of the IEM source. One observation is one row of the IEM list. A row is one VTEC
 * event of the NWS in one county or zone, with its start and its end there. The map gives one report
 * of the row.
 *
 * The list of IEM is a snapshot: it holds the rows that are in effect. A row that is cancelled
 * or ends leaves the list. A row of the list has no id of its own. Thus the key of a report holds
 * the id of its observation: two different rows always give two different reports.
 */

import { categoryOf, Problems, reportId, UNKNOWN_KIND, type Area, type Kind, type MapResult, type Observation, type Report, type SourceId } from "@mark1russell7/alerts";
import { capTime } from "@mark1russell7/alerts-format-cap";
import { fromPhenomenon, NWS_ORIGIN, sameOfCountyUgc, vtecEventKey, vtecOffice, vtecYear } from "@mark1russell7/alerts-format-nws";
import { errorMessage } from "@mark1russell7/text";

/** The id of this source. */
export const SOURCE_ID = "iem" as SourceId;

/**
 * The fields of a row that the fetch keeps in the body of an observation, in this order. The key and
 * the sent time of a report hold each of them. A field that IEM adds later does not change the body.
 */
export const ROW_FIELDS = ["wfo", "phenomena", "significance", "eventid", "ugc", "utc_issue", "utc_expire", "utc_product_issue"] as const;

/** The page of IEM for one VTEC event. The map adds `<year>-O-NEW-<office>-<phenomenon>-<significance>-<number>`. */
export const EVENT_PAGE = "https://mesonet.agron.iastate.edu/vtec/#";

type Row = Readonly<Record<string, unknown>>;

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);

/** This function reads one text field of a row with a pattern. A different value is a fatal problem. */
function textField(row: Row, field: string, pattern: RegExp, what: string, problems: Problems): string | undefined {
  const value = row[field];
  if (typeof value === "string" && pattern.test(value)) return value;
  problems.add(field, `the value ${JSON.stringify(value)} is not ${what}: the map makes no report`, "fatal");
  return undefined;
}

/** This function maps one row, and can throw. `mapObservation` catches each error. */
function mapRow(row: Row, observation: Observation, problems: Problems): Report | undefined {
  const wfo = textField(row, "wfo", /^[A-Z]{3}$/, "an office id of three letters", problems);
  const phenomenon = textField(row, "phenomena", /^[A-Z]{2}$/, "a VTEC phenomenon", problems);
  const significance = textField(row, "significance", /^[A-Z]$/, "a VTEC significance", problems);
  const ugc = textField(row, "ugc", /^[A-Z]{2}[CZ]\d{3}$/, "a UGC code", problems);
  const eventNumber = row["eventid"];
  const numbered = typeof eventNumber === "number" && Number.isInteger(eventNumber) && eventNumber >= 1 && eventNumber <= 9999;
  if (!numbered) problems.add("eventid", `the value ${JSON.stringify(eventNumber)} is not a VTEC event number: the map makes no report`, "fatal");
  const issue = capTime(row["utc_issue"], "utc_issue", problems);
  const sent = capTime(row["utc_product_issue"], "utc_product_issue", problems);
  if (issue === undefined) problems.add("utc_issue", "the row has no start: the map cannot find the year of the event", "fatal");
  if (sent === undefined) problems.add("utc_product_issue", "the row has no time of its product: the map makes no report", "fatal");
  const expires = capTime(row["utc_expire"], "utc_expire", problems);
  const office = wfo === undefined ? undefined : vtecOffice(wfo);
  if (office === undefined || phenomenon === undefined || significance === undefined || ugc === undefined || !numbered || issue === undefined || sent === undefined) {
    return undefined;
  }

  // The start of a row can be after the first issuance of the event. Thus the year comes from the earlier time.
  const year = vtecYear(sent, issue);
  const correlation = vtecEventKey({ office, phenomenon, significance, eventNumber, year });
  const found = fromPhenomenon(phenomenon, significance);
  if (found === undefined) problems.add("phenomena", `the kind tables do not know the event ${phenomenon}.${significance}`);
  const kind: Kind =
    found === undefined
      ? { code: UNKNOWN_KIND, label: `${phenomenon}.${significance}` }
      : found.significance === undefined
        ? { code: found.code, label: found.label }
        : { code: found.code, significance: found.significance, label: found.label };
  const same = sameOfCountyUgc(ugc);
  const areas: Area[] = [{ type: "code", system: "ugc", code: ugc }, ...(same === undefined ? [] : [{ type: "code" as const, system: "same", code: same }])];
  const key = `${correlation.id}.${ugc}@${observation.id}`;
  const number = String(eventNumber).padStart(4, "0");
  return {
    id: reportId({ source: SOURCE_ID, key, sent }),
    source: SOURCE_ID,
    origin: NWS_ORIGIN,
    key,
    references: [],
    correlation: [correlation],
    status: "actual",
    op: "alert",
    kind,
    categories: [categoryOf(kind.code)],
    // The list of IEM has no severity, urgency or certainty. The merge ranks unknown lowest.
    severity: "unknown",
    urgency: "unknown",
    certainty: "unknown",
    response: [],
    sent,
    received: observation.fetched,
    onset: issue,
    ...(expires === undefined ? {} : { expires, ends: expires }),
    areas,
    about: [],
    sender: office,
    headline: `${kind.label} by ${office}`,
    web: `${EVENT_PAGE}${String(year)}-O-NEW-${office}-${phenomenon}-${significance}-${number}`,
    observation: observation.id,
    parameters: {},
  };
}

/** This function maps one observation, and can throw. `mapObservation` catches each error. */
function mapOrThrow(observation: Observation): MapResult {
  let row: unknown;
  try {
    row = JSON.parse(observation.body);
  } catch {
    return { reports: [], problems: [{ path: "", message: "the body is not JSON", fatal: true }] };
  }
  // The fetch gives the whole answer as one observation when the answer is not the list
  if (!isRow(row) || !ROW_FIELDS.some((field) => field in row)) {
    return { reports: [], problems: [{ path: "", message: "the observation is not a row of the IEM list: the format changed", fatal: true }] };
  }
  const problems = new Problems();
  const report = mapRow(row, observation, problems);
  return { reports: report === undefined ? [] : [report], problems: problems.list };
}

/**
 * This function maps one observation of the IEM source to a report. The body is one row of the list.
 * The function does not throw: an error is a fatal problem.
 */
export function mapObservation(observation: Observation): MapResult {
  try {
    return mapOrThrow(observation);
  } catch (error) {
    return { reports: [], problems: [{ path: "", message: `the map function failed: ${errorMessage(error)}`, fatal: true }] };
  }
}
