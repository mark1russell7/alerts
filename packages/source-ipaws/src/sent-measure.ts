/**
 * The measure of the sent times of the WEA copies (AL-8). The core finds the IPAWS copy of an NWS
 * message by its incident and by its sent time, to the millisecond (`carriages`). A copy with a
 * different sent time is not a copy for the core, so its check is a miss. The functions of this
 * module give the counts that show if the real copies keep the sent time of the NWS message.
 *
 * The functions are pure. They read no clock and no network. The script `scripts/measure.ts` gives
 * them the reports of the two sources.
 */

import { carriages, incidents, normalize, type Duration, type Expectation, type Instant, type Report, type ReportId } from "@mark1russell7/alerts";
import { WEA_EXPECTATION } from "./expectation.ts";

/** The end of the id of an IPAWS copy. The copy has the id of the NWS message and then this text. */
export const COPY_SUFFIX = ".IPAWS";

/**
 * The class of one message of the source `from` in the measure.
 *
 * - `same`: the incident of the message has a copy with the same sent time. The check of the core finds it.
 * - `shifted`: the incident has the copy with the id of the message, but at a different sent time. The check of the core is a miss.
 * - `lost`: the incident has copies, but no copy with the id of the message and no copy at its sent time. The check of the core is a miss.
 * - `apart`: the incident has no copy, but a copy with the id of the message is in a different incident.
 * - `none`: the reports have no copy of the message.
 * - `censored`: the message comes after the censor time, and no copy has its sent time. Its copy can come later.
 *
 * The class `lost` is a different fault from `shifted`, for example the lost copy of an extension.
 */
export type SentClass = "same" | "shifted" | "lost" | "apart" | "none" | "censored";

/** One report of the source `to`: its key and its sent time. */
export interface CopyTime {
  /** The key of the report, for example the CAP identifier of the IPAWS copy. */
  readonly key: string;
  readonly sent: Instant;
}

/** One message of the source `from` that the expectation checks, and its class. */
export interface SentCheck {
  /** The id of the first report of the message. It is the key of the check of the core. */
  readonly report: ReportId;
  /** The key of that report: the id of the NWS message. */
  readonly key: string;
  /** The event code of the message: its SAME code, or else its NWS code, or else its kind. */
  readonly event: string;
  readonly sent: Instant;
  readonly class: SentClass;
  /** The reports of the source `to` in the incident of the message, from the earliest sent time. */
  readonly copies: readonly CopyTime[];
}

/** A message with a copy, but with no copy at its sent time: the pair of the message and its copy. */
export interface SentGap {
  readonly report: ReportId;
  readonly key: string;
  readonly event: string;
  readonly sent: Instant;
  readonly class: "shifted" | "lost" | "apart";
  /** The copy: the copy with the id of the message, or for the class `lost` the copy of the incident with the nearest sent time. */
  readonly copy: CopyTime;
  /** The rule that found the copy: the id of the message (`shifted` and `apart`), or the nearest sent time (`lost`). */
  readonly match: "id" | "nearest";
  /** The sent time of the copy minus the sent time of the message, in milliseconds. */
  readonly difference: Duration;
}

/** The count of the messages of each class. The sum of `shifted` and `lost` must be 0 (`sentFails`). */
export interface SentCounts {
  readonly messages: number;
  readonly same: number;
  /** The messages with the copy with their id in the incident, at a different sent time. The sum of `shifted` and `lost` must be 0. */
  readonly shifted: number;
  /** The messages with copies in the incident, but no copy with their id and no copy at their sent time. The sum of `shifted` and `lost` must be 0. */
  readonly lost: number;
  readonly apart: number;
  readonly none: number;
  readonly censored: number;
}

/** The result of the measure. */
export interface SentMeasure {
  readonly counts: SentCounts;
  /** The checks, in the order of their sent times. */
  readonly checks: readonly SentCheck[];
  /** The messages of the classes `shifted`, `lost` and `apart`, each with its copy, in the order of their sent times. */
  readonly gaps: readonly SentGap[];
}

/** The options of the measure. */
export interface SentMeasureOptions {
  /** The expectation. The default is `WEA_EXPECTATION`. */
  readonly expectation?: Expectation;
  /**
   * The censor time. A message with a later sent time and no copy at its sent time is censored,
   * because its copy can come after the data. With no censor time, no message is censored.
   */
  readonly censorAfter?: Instant;
}

/** This function gives the event code of a report: its SAME code, or else its NWS code, or else its kind. */
export function eventOf(report: Report): string {
  return report.parameters["eventCode.SAME"]?.[0] ?? report.parameters["eventCode.NationalWeatherService"]?.[0] ?? report.kind.code;
}

/**
 * This function measures the sent times of the copies over the reports of the two sources. It uses
 * the path of the core: `normalize`, `incidents` and `carriages` with the expectation. Then it gives
 * a class to each check with no copy, from the reports of the source `to` in the same incident.
 *
 * The result is a function of the set of reports, so the order of the reports does not change it.
 */
export function sentMeasure(reports: readonly Report[], options: SentMeasureOptions = {}): SentMeasure {
  const expectation = options.expectation ?? WEA_EXPECTATION;
  const state = normalize({ reports });
  // The groups of the incidents do not use the time. The time is the latest receipt, so the result reads no clock.
  const at = state.reports.reduce((latest, report) => Math.max(latest, report.received), 0);
  const found = incidents(state, at);
  const byId = new Map(state.reports.map((report) => [report.id, report]));
  const copiesOf = new Map<ReportId, CopyTime[]>();
  for (const incident of found) {
    const copies = incident.reports
      .flatMap((id) => byId.get(id) ?? [])
      .filter((report) => report.source === expectation.to)
      .map((report) => ({ key: report.key, sent: report.sent }))
      .sort(byTime);
    for (const id of incident.reports) copiesOf.set(id, copies);
  }
  const byKey = new Map<string, CopyTime>();
  for (const report of state.reports) {
    if (report.source !== expectation.to) continue;
    const held = byKey.get(report.key);
    if (held === undefined || byTime({ key: report.key, sent: report.sent }, held) < 0) byKey.set(report.key, { key: report.key, sent: report.sent });
  }

  const checks: SentCheck[] = [];
  const gaps: SentGap[] = [];
  for (const check of carriages(state, found, [expectation])) {
    const report = byId.get(check.report);
    if (report === undefined) continue;
    const copies = copiesOf.get(report.id) ?? [];
    const own = byKey.get(`${report.key}${COPY_SUFFIX}`);
    const base = { report: report.id, key: report.key, event: eventOf(report), sent: report.sent };
    let kind: SentClass;
    if (check.arrived !== undefined) kind = "same";
    else if (options.censorAfter !== undefined && report.sent > options.censorAfter) kind = "censored";
    else if (copies.length > 0) {
      const byIdInIncident = copies.find((copy) => copy.key === own?.key);
      if (byIdInIncident !== undefined) {
        kind = "shifted";
        gaps.push({ ...base, class: kind, copy: byIdInIncident, match: "id", difference: byIdInIncident.sent - report.sent });
      } else {
        kind = "lost";
        const copy = nearest(copies, report.sent);
        gaps.push({ ...base, class: kind, copy, match: "nearest", difference: copy.sent - report.sent });
      }
    } else if (own !== undefined) {
      kind = "apart";
      gaps.push({ ...base, class: kind, copy: own, match: "id", difference: own.sent - report.sent });
    } else kind = "none";
    checks.push({ ...base, class: kind, copies });
  }
  const order = (a: { sent: Instant; key: string }, b: { sent: Instant; key: string }): number => a.sent - b.sent || compare(a.key, b.key);
  checks.sort(order);
  gaps.sort(order);
  const count = (kind: SentClass): number => checks.filter((check) => check.class === kind).length;
  return {
    counts: {
      messages: checks.length,
      same: count("same"),
      shifted: count("shifted"),
      lost: count("lost"),
      apart: count("apart"),
      none: count("none"),
      censored: count("censored"),
    },
    checks,
    gaps,
  };
}

/**
 * This function tells if the counts of a measure show a fault: the sum of `shifted` and `lost` is above 0.
 * The classes `same`, `apart`, `none` and `censored` do not change the result.
 */
export function sentFails(counts: SentCounts): boolean {
  return counts.shifted + counts.lost > 0;
}

// The copy with the nearest sent time. A tie goes to the earlier copy. The list is not empty.
function nearest(copies: readonly CopyTime[], sent: Instant): CopyTime {
  return copies.reduce((best, copy) => (Math.abs(copy.sent - sent) < Math.abs(best.sent - sent) ? copy : best));
}

// The order of the copies: the earlier sent time first, then the smaller key.
function byTime(a: CopyTime, b: CopyTime): number {
  return a.sent - b.sent || compare(a.key, b.key);
}

// The order of the code units, the same in each copy and each locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
