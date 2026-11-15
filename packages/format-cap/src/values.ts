/**
 * The CAP 1.2 values (OASIS CAP 1.2, section 3.2) and the readers of the texts of a CAP message. The
 * readers give the values of each list, the times and the lists that CAP separates with spaces.
 *
 * Each source of CAP messages uses these readers: the NWS API, FEMA IPAWS and NWWS-OI.
 */

import type { Category, Certainty, Instant, Operation, ProblemSink, ResponseType, Severity, Status, Urgency } from "@mark1russell7/alerts";

/** The CAP status values, in lower case. */
export const CAP_STATUS: ReadonlySet<string> = new Set<Status>(["actual", "exercise", "system", "test", "draft"]);

/** The CAP message types that give a report, in lower case. */
export const CAP_OPERATIONS: ReadonlySet<string> = new Set<Operation>(["alert", "update", "cancel"]);

/** The CAP message types that are not alerts. They give no report and no problem. */
export const CAP_NOT_ALERTS: ReadonlySet<string> = new Set(["ack", "error"]);

/** The CAP severity values, in lower case. */
export const CAP_SEVERITY: ReadonlySet<string> = new Set<Severity>(["extreme", "severe", "moderate", "minor", "unknown"]);

/** The CAP urgency values, in lower case. */
export const CAP_URGENCY: ReadonlySet<string> = new Set<Urgency>(["immediate", "expected", "future", "past", "unknown"]);

/** The CAP certainty values, in lower case. */
export const CAP_CERTAINTY: ReadonlySet<string> = new Set<Certainty>(["observed", "likely", "possible", "unlikely", "unknown"]);

/** The CAP response types, in lower case. */
export const CAP_RESPONSES: ReadonlySet<string> = new Set<ResponseType>([
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

/** The CAP categories, in lower case. The core adds categories that CAP does not have. */
export const CAP_CATEGORIES: ReadonlySet<string> = new Set<Category>([
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

/**
 * A time with a zone. CAP 1.2 gives `2026-11-08T13:23:00-06:00`. The reader also takes `Z` and parts
 * of a second, because the NWS API and other sources give them.
 */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** This function reads a time of a message. An absent time gives `undefined`, and a bad time is a problem. */
export function capTime(value: unknown, path: string, problems: ProblemSink): Instant | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    problems.add(path, `the time ${JSON.stringify(value)} is not an ISO 8601 time with a zone`);
    return undefined;
  }
  return Date.parse(value);
}

/**
 * This function reads one value of a CAP list of values, in lower case. An unknown value is a problem,
 * and the function gives the fallback. An absent value is a problem only if the fallback is not `unknown`.
 */
export function capValue<T extends string>(value: unknown, allowed: ReadonlySet<string>, fallback: T, path: string, problems: ProblemSink): T {
  const text = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  if (text !== undefined && text !== "" && allowed.has(text)) return text as T;
  if (value !== null && value !== undefined && text !== "") problems.add(path, `the value ${JSON.stringify(value)} is not known: the map uses ${fallback}`);
  else if (fallback !== "unknown") problems.add(path, `the value is absent: the map uses ${fallback}`);
  return fallback;
}

/**
 * This function splits a CAP list that uses spaces as separators: `addresses` and `incidents`. An item
 * with spaces is in double quotes. A quote with no end goes to the end of the text.
 */
export function capList(text: string | undefined): string[] {
  if (text === undefined) return [];
  const items: string[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at] as string;
    if (/\s/.test(char)) {
      at += 1;
    } else if (char === '"') {
      const end = text.indexOf('"', at + 1);
      const stop = end < 0 ? text.length : end;
      const item = text.slice(at + 1, stop);
      if (item !== "") items.push(item);
      at = stop + 1;
    } else {
      let stop = at;
      while (stop < text.length && !/\s/.test(text[stop] as string)) stop += 1;
      items.push(text.slice(at, stop));
      at = stop;
    }
  }
  return items;
}
