/**
 * The plain words of the page: the text of each reason of an assessment, and the facts that join
 * the reports of an incident. These functions only write text. The core makes each decision.
 */

import type { AssessedLevel, AssessReason, HealthState, HealthStep, Incident, Report } from "@mark1russell7/alerts";
import { NAMES, SHORT_NAMES } from "./demo.ts";

/** This function gives the name of a person or a place on the page. */
export function nameOf(id: string): string {
  return NAMES[id] ?? id;
}

/** This function gives the short name of a home or a source, for a list. */
export function shortName(id: string): string {
  return SHORT_NAMES[id] ?? id;
}

/**
 * This function writes the label of a step for a reader, for example `Step 5 of 10`. The reader
 * counts the steps from 1. The code counts them from 0.
 */
export function stepLabel(index: number, count: number): string {
  return `Step ${String(index + 1)} of ${String(count)}`;
}

/** The words of each health state of a source. */
export const HEALTH_WORDS: Readonly<Record<HealthState, string>> = {
  unknown: "Unknown",
  healthy: "Healthy",
  slow: "Slow",
  failing: "Failing",
  silent: "Silent",
  changed: "Changed",
};

/** The words of the kinds that the coverage examines. */
export const KIND_WORDS: Readonly<Record<string, string>> = {
  "met.flood.flash": "Flash flood",
  "met.wind": "Wind",
};

/** This function writes one change of the health machine of a source. */
export function changeText(change: HealthStep["transitions"][number]): string {
  const what = `the state went from ${change.from} to ${change.to}, on the event ${change.on}.`;
  return change.at === undefined ? `T${what.slice(1)}` : `At ${clock(change.at)}, ${what}`;
}

const COVERAGE_PREFIX = "system.coverage.";

/**
 * This function gives the label of an incident. A system report of a coverage gets the words of
 * its kind and the name of its place, for example `Coverage gap: Flash flood, Home of A`.
 */
export function incidentLabel(incident: Pick<Incident, "kind" | "areas">): string {
  const place = incident.areas.find((area) => area.type === "place");
  const code = incident.kind.code;
  const words = code.startsWith(COVERAGE_PREFIX) ? KIND_WORDS[code.slice(COVERAGE_PREFIX.length)] : undefined;
  const label = words === undefined ? incident.kind.label : `Coverage gap: ${words}`;
  return place === undefined ? label : `${label}, ${shortName(place.place)}`;
}

/** The words of each level. */
export const LEVEL_WORDS: Readonly<Record<AssessedLevel, string>> = {
  "life-safety": "Life-safety",
  urgent: "Urgent",
  notice: "Notice",
  digest: "Digest",
  none: "No message",
};

/** The meaning of each level, from the table of the levels in `docs/CONTRACTS.md`. */
export const LEVEL_MEANINGS: Readonly<Record<AssessedLevel, string>> = {
  "life-safety": "It wakes the person, sounds through silent mode and escalates until acknowledged.",
  urgent: "A push at once, without the break through Do Not Disturb.",
  notice: "A push in the day, else the digest.",
  digest: "The next digest.",
  none: "No message.",
};

/** This function gives the text of one reason of an assessment. */
export function reasonText(reason: AssessReason, incident: Pick<Incident, "severity" | "urgency">): string {
  switch (reason.kind) {
    case "ended":
      return "The incident ended: each of its messages is cancelled or expired.";
    case "status":
      return `The policy sends only actual messages, and this message has the status "${reason.status}".`;
    case "no-place":
      return "No place of this person is in the areas of the incident.";
    case "no-subject":
      return "The incident has no area, and the person watches none of its subjects.";
    case "no-codes":
      return "The areas are shapes with no codes. The core matches places by their codes only.";
    case "unknown-place":
      return `The configuration has no place "${reason.place}".`;
    case "place":
      // A system report names the place itself, so its match has no codes.
      if (reason.codes.length === 0) return `The area of the report is ${nameOf(reason.place)}.`;
      return `The incident covers ${nameOf(reason.place)}: ${reason.codes.map((code) => code.code).join(", ")}.`;
    case "subject":
      return `The person watches the subject ${reason.subject.system}${reason.subject.id === undefined ? "" : ` ${reason.subject.id}`}.`;
    case "table": {
      const table = reason.class === undefined ? "the table of the other kinds" : `the table "${reason.class}"`;
      return `In ${table}, the severity "${incident.severity}" gives ${reason.bySeverity}, and the urgency "${incident.urgency}" gives ${reason.byUrgency}. The level is the lower of the two: ${reason.level}.`;
    }
    case "rule":
      return `Rule ${String(reason.index + 1)} of the person sets ${reason.max} as the highest level${reason.place === undefined ? "" : ` at ${nameOf(reason.place)}`}.`;
  }
}

/** A fact that joins a report to an earlier report of its incident. */
export interface JoinFact {
  readonly rule: 1 | 2;
  readonly text: string;
}

/**
 * This function tells which facts of a report point to the earlier reports of its incident. A
 * reference to an earlier key is merge rule 1. A shared VTEC key is merge rule 2.
 */
export function joinFacts(report: Report, earlier: readonly Report[]): JoinFact[] {
  const facts: JoinFact[] = [];
  const keys = new Set(earlier.map((other) => other.key));
  const named = report.references.filter((reference) => keys.has(reference));
  if (named.length > 0) facts.push({ rule: 1, text: `It names ${String(named.length)} earlier message${named.length === 1 ? "" : "s"} in its references.` });
  const shared = report.correlation.filter((key) => earlier.some((other) => other.correlation.some((own) => own.system === key.system && own.id === key.id)));
  for (const key of shared) facts.push({ rule: 2, text: `It has the same ${key.system.toUpperCase()} key: ${key.id}.` });
  return facts;
}

/** The words of each operation of a message. */
export const OP_WORDS: Readonly<Record<Report["op"], string>> = {
  alert: "New",
  update: "Update",
  cancel: "Cancel",
};

/** This function writes a time of the replay as `HH:MM UTC`. */
export function clock(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}
