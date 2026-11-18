/**
 * The parser of the text of one message of the SWPC (the Space Weather Prediction Center of the NWS). Each message
 * has three lines of identity (the code, the serial number and the issue time), one head line and lines of fields.
 *
 * ```text
 * Space Weather Message Code: ALTK05
 * Serial Number: 2062
 * Issue Time: 2026 Nov 08 0203 UTC
 *
 * ALERT: Geomagnetic K-index of 5
 * Threshold Reached: 2026 Nov 08 0203 UTC
 * Synoptic Period: 0000-0300
 * ```
 *
 * The functions of this file read only the text. They know no product and give no report.
 */

import type { Instant } from "@mark1russell7/alerts";
import type { ScaleLevel } from "@mark1russell7/alerts-space-weather";

/** The head words of a message, as the SWPC writes them before the first colon of the head line. */
export const HEADS = ["ALERT", "WARNING", "WATCH", "SUMMARY", "EXTENDED WARNING", "CONTINUED ALERT", "CANCEL ALERT", "CANCEL WARNING", "CANCEL WATCH", "CANCEL SUMMARY"] as const;

/** One head word of a message. */
export type Head = (typeof HEADS)[number];

/** The parts of the text of one message. */
export interface MessageText {
  /** The code of the product, for example `ALTK05`. */
  readonly code: string;
  /** The serial number of the message. Each code has its own sequence of numbers. */
  readonly serial: number;
  /** The issue time that the text gives, to the minute. */
  readonly issued: Instant;
  /** The head word of the message. */
  readonly head: Head;
  /** The text after the head word, for example `Geomagnetic K-index of 5`. */
  readonly title: string;
  /**
   * The value of each field after the head line, by the name of the field in lower case with single spaces. The
   * first line of a name gives its value. For example, the text `Noaa Scale: G1 - Minor` gives `noaa scale`.
   */
  readonly fields: ReadonlyMap<string, string>;
  /** The full text of the message, with each line break as `\n`. */
  readonly text: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** This function gives the number of a month from its short English name (`Jan` is 0), or `undefined`. */
export function monthOf(name: string): number | undefined {
  const index = (MONTHS as readonly string[]).indexOf(name);
  return index < 0 ? undefined : index;
}

/** This function gives the instant of a date and a time in UTC, or `undefined` for a date that is not in the calendar. */
function utc(year: number, month: number, day: number, hour: number, minute: number): Instant | undefined {
  const time = Date.UTC(year, month, day, hour, minute);
  const date = new Date(time);
  const same = date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute;
  return same ? time : undefined;
}

const TIME = /^(\d{4}) ([A-Z][a-z]{2}) (\d{2}) (\d{2})(\d{2}) UTC$/;

/**
 * This function gives the instant of a time of a message, for example `2026 Nov 08 0203 UTC`. A text in a different
 * format gives `undefined`. A date or an hour that is not in the calendar gives `undefined` too.
 */
export function messageTime(text: string): Instant | undefined {
  const match = TIME.exec(text.trim());
  if (match === null) return undefined;
  const month = monthOf(match[2]!);
  if (month === undefined) return undefined;
  return utc(Number(match[1]), month, Number(match[3]), Number(match[4]), Number(match[5]));
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const PERIOD = /^(\d{2})00-(\d{2})00(?: UTC)?$/;

/**
 * This function gives the end of the synoptic period of a K-index alert, for example `1500-1800 UTC`. A period is
 * three hours of a UTC day, and the text gives no date. The period is the last one that starts at or before the
 * issue time. A text in a different format gives `undefined`.
 */
export function periodEnd(text: string, issued: Instant): Instant | undefined {
  const match = PERIOD.exec(text.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 21 || end !== start + 3) return undefined;
  const day = Math.floor(issued / DAY_MS) * DAY_MS;
  const begins = day + start * HOUR_MS <= issued ? day + start * HOUR_MS : day - DAY_MS + start * HOUR_MS;
  return begins + 3 * HOUR_MS;
}

const SCALE = /^([GSR])([1-5])\b/;

/** This function reads a level of a NOAA scale at the start of a text, for example `G1 - Minor`. A different text gives `undefined`. */
export function scaleLevel(text: string): ScaleLevel | undefined {
  const match = SCALE.exec(text.trim());
  if (match === null) return undefined;
  return { scale: match[1] as ScaleLevel["scale"], level: Number(match[2]) as ScaleLevel["level"] };
}

/** This function gives the level of a NOAA scale that a message states, from the field `NOAA Scale` or `Predicted NOAA Scale`. */
export function statedScale(message: MessageText): ScaleLevel | undefined {
  const text = message.fields.get("noaa scale") ?? message.fields.get("predicted noaa scale");
  return text === undefined ? undefined : scaleLevel(text);
}

const POLEWARD = /poleward of (\d{1,2}) degrees Geomagnetic Latitude/i;

/** This function gives the geomagnetic latitude of the line `Potential Impacts: Area of impact primarily poleward of 60 degrees Geomagnetic Latitude.` */
export function polewardOf(message: MessageText): number | undefined {
  const match = POLEWARD.exec(message.text);
  if (match === null) return undefined;
  const latitude = Number(match[1]);
  return latitude > 0 && latitude < 90 ? latitude : undefined;
}

/** The highest storm level that a watch predicts for one UTC day. `undefined` is the text `None (Below G1)`. */
export interface WatchDay {
  /** The UTC date of the day, for example `2026-11-17`. */
  readonly date: string;
  /** The start of the UTC day. */
  readonly start: Instant;
  readonly level: ScaleLevel | undefined;
}

const DAY = /([A-Z][a-z]{2}) (\d{2}):\s+(?:None \(Below G1\)|(G[1-5]) \([A-Za-z]+\))/g;

/**
 * This function gives the days of a geomagnetic watch from the lines after `Highest Storm Level Predicted by Day:`.
 * The text of a day has no year: `Nov 17:  G1 (Minor)`. The year comes from the issue time. A month before the month
 * of the issue time is in the next year, so a watch of 31 December can name 1 January.
 */
export function watchDays(message: MessageText): WatchDay[] | undefined {
  const at = message.text.search(/Highest Storm Level Predicted by Day:/i);
  if (at < 0) return undefined;
  const end = message.text.search(/THIS SUPERSEDES/i);
  const part = message.text.slice(at, end > at ? end : undefined);
  const issued = new Date(message.issued);
  const days: WatchDay[] = [];
  for (const match of part.matchAll(DAY)) {
    const month = monthOf(match[1]!);
    if (month === undefined) return undefined;
    const year = issued.getUTCFullYear() + (month < issued.getUTCMonth() ? 1 : 0);
    const start = utc(year, month, Number(match[2]), 0, 0);
    if (start === undefined) return undefined;
    days.push({ date: new Date(start).toISOString().slice(0, 10), start, level: match[3] === undefined ? undefined : scaleLevel(match[3]) });
  }
  return days.length > 0 ? days : undefined;
}

const IDENTITY = /^Space Weather Message Code: ([A-Z0-9]{3,8})\s*\nSerial Number: (\d{1,7})\s*\nIssue Time: ([^\n]+?)\s*\n/;
const HEAD_LINE = new RegExp(`^(${[...HEADS].sort((a, b) => b.length - a.length).join("|")}):\\s*(.*?)\\s*$`);
const FIELD = /^([A-Za-z][A-Za-z0-9 ()]*?):\s*(.*?)\s*$/;

/** The result of a parse: the parts, or the reason that the text is not a message. */
export type Parsed = { readonly ok: true; readonly message: MessageText } | { readonly ok: false; readonly reason: string };

/**
 * This function parses the text of one message. The text must start with the three lines of identity, and it must
 * have a head line. A line of the form `Name: value` after the head line is a field. Each other line is free text.
 */
export function parseMessage(raw: string): Parsed {
  const text = raw.replace(/\r\n?/g, "\n");
  const identity = IDENTITY.exec(text);
  if (identity === null) return { ok: false, reason: "the text does not start with the code, the serial number and the issue time" };
  const issued = messageTime(identity[3]!);
  if (issued === undefined) return { ok: false, reason: `the issue time ${JSON.stringify(identity[3])} is not a time of the UTC calendar` };
  const lines = text.slice(identity[0].length).split("\n");
  const headAt = lines.findIndex((line) => HEAD_LINE.test(line.trim()));
  if (headAt < 0) return { ok: false, reason: "the text has no head line, for example ALERT: or WARNING:" };
  const head = HEAD_LINE.exec(lines[headAt]!.trim())!;
  const fields = new Map<string, string>();
  for (const line of lines.slice(headAt + 1)) {
    const field = FIELD.exec(line.trim());
    if (field === null) continue;
    const name = field[1]!.toLowerCase().replace(/\s+/g, " ");
    if (!fields.has(name)) fields.set(name, field[2]!);
  }
  return {
    ok: true,
    message: { code: identity[1]!, serial: Number(identity[2]), issued, head: head[1] as Head, title: head[2]!, fields, text },
  };
}
