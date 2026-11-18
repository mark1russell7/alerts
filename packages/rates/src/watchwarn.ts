/**
 * The alerts of the NWS from the archive of the Iowa Environmental Mesonet (IEM): the watches, the
 * warnings, the advisories and the statements with a VTEC code. The service `watchwarn.py` gives one
 * CSV row for each event in each county or zone (UGC). It also gives one row with no UGC for each
 * polygon of a storm-based warning.
 *
 * The requests are national: they name no office and no state. One request asks for each pair of
 * `ALERT_PHENOMENA` and `ALERT_SIGNIFICANCES` in one month. The service selects a row by its start
 * (`issue`), so the rows of two months do not overlap.
 *
 * The reader keeps only the fields of `WATCHWARN_COLUMNS`. It does not keep the name of a
 * forecaster or the id of a product.
 */

import { isUgcCode, PHENOMENA } from "@mark1russell7/alerts-format-nws";
import { parseCsv } from "@procedures/json/csv";

import { queryTime, type CowWindow } from "./cow.ts";
import { RecordFramer } from "./ncei.ts";
import type { Years } from "./years.ts";

/** The URL of the CSV service of the VTEC alerts of IEM. */
export const WATCHWARN_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/gis/watchwarn.py";

/** The VTEC significances of the measure: warning, watch, advisory and statement. An outlook tells of no hazard in effect. */
export const ALERT_SIGNIFICANCES = ["W", "A", "Y", "S"] as const;

/** One significance of the measure. */
export type AlertSignificance = (typeof ALERT_SIGNIFICANCES)[number];

/** The marine phenomena: their alerts name marine zones. The measure does not ask for them (`MARINE_REASON`). */
export const MARINE_PHENOMENA = ["BW", "GL", "HF", "LO", "MA", "MF", "MH", "MS", "RB", "SC", "SE", "SI", "SR", "SW", "UP", "ZY"] as const;

/** The reason that the measure does not ask for the marine phenomena. */
export const MARINE_REASON =
  "The alerts of these phenomena name marine zones. NCEI keys a marine event by a code of its water, not by the letters of a marine UGC. Thus the join places no marine event, and the counts of these alerts give no rate.";

/** The VTEC phenomena of the requests: each phenomenon of the NWS tables that is not marine, in the order of the codes. */
export const ALERT_PHENOMENA: readonly string[] = Object.keys(PHENOMENA)
  .filter((phenomenon) => !(MARINE_PHENOMENA as readonly string[]).includes(phenomenon))
  .sort();

/**
 * The alerts with a national event number, and the reason. A key of two letters holds each significance of the
 * phenomenon. An office gives most alerts its own number, so a count of alerts keys each event by its office. A
 * national number is the same in each office of the event, so the count keys it with no office. The measure checks the
 * list against the data (`NumberingCheck`).
 */
export const NATIONAL_NUMBERS: Readonly<Record<string, string>> = {
  "TO.A": "The Storm Prediction Center gives each watch a number for the whole country. Each office of the watch sends the watch with that number.",
  "SV.A": "The Storm Prediction Center gives each watch a number for the whole country. Each office of the watch sends the watch with that number.",
  HU: "A tropical alert has the number of its storm from the hurricane center. Each office on the path of the storm sends that number.",
  TR: "A tropical alert has the number of its storm from the hurricane center. Each office on the path of the storm sends that number.",
  SS: "A storm surge alert has the number of its storm from the hurricane center. Each office on the path of the storm sends that number.",
  TY: "A typhoon alert has the number of its storm from the typhoon center. Each office on the path of the storm sends that number.",
};

/** This function tells if an alert has a national event number (`NATIONAL_NUMBERS`). */
export function nationalNumber(phenomenon: string, significance: string): boolean {
  return Object.hasOwn(NATIONAL_NUMBERS, `${phenomenon}.${significance}`) || Object.hasOwn(NATIONAL_NUMBERS, phenomenon);
}

/** The columns of the CSV text that the reader reads. */
export const WATCHWARN_COLUMNS = ["wfo", "utc_issue", "utc_expire", "phenomena", "significance", "eventid", "ugc", "vtec_year"] as const;

/** The fixed part of each query: the CSV form, and each pair of a phenomenon and a significance. */
export const WATCHWARN_PARAMS: string = (() => {
  const pairs = ALERT_PHENOMENA.flatMap((phenomenon) => ALERT_SIGNIFICANCES.map((significance) => [phenomenon, significance] as const));
  return `accept=csv&limitps=yes&phenomena=${pairs.map(([phenomenon]) => phenomenon).join(",")}&significance=${pairs.map(([, significance]) => significance).join(",")}`;
})();

/** This function gives the query of one window: the alerts that start from `start` to before `end`. */
export function watchwarnQuery(window: CowWindow): string {
  return `?sts=${queryTime(window.start)}&ets=${queryTime(window.end)}&${WATCHWARN_PARAMS}`;
}

/**
 * This function gives the windows of a measure: one window for each month. The first window is the month before the
 * first year. Its alerts do not count, but an alert that starts in it can be active at an event of the first year.
 */
export function alertWindows(years: Years): CowWindow[] {
  if (!Number.isInteger(years.first) || !Number.isInteger(years.last) || years.first > years.last) throw new RangeError(`The years ${String(years.first)} to ${String(years.last)} are not a range of whole years.`);
  const windows: CowWindow[] = [{ start: Date.UTC(years.first - 1, 11, 1), end: Date.UTC(years.first, 0, 1) }];
  for (let year = years.first; year <= years.last; year += 1) {
    for (let month = 0; month < 12; month += 1) windows.push({ start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1) });
  }
  return windows;
}

/** One row of the CSV text: one alert in one county or zone, or one polygon with no UGC. */
export interface AlertRow {
  /** The office, with no first letter, for example `TOP`. */
  readonly wfo: string;
  readonly phenomenon: string;
  readonly significance: AlertSignificance;
  readonly eventId: number;
  /** The VTEC year of the event number. */
  readonly year: number;
  /** The UGC code, for example `KSZ083`, or empty text for a polygon. */
  readonly ugc: string;
  /** The start of the alert in the area, in milliseconds since the epoch, or undefined when the row has no start. */
  readonly issue: number | undefined;
  /** The end of the alert in the area, or undefined when the row has no end. */
  readonly expire: number | undefined;
}

/** The rows of one CSV text, and the count of rows with each fault. */
export interface WatchwarnRead {
  readonly rows: readonly AlertRow[];
  /** The rows that the reader skipped or that the join cannot use, by fault. */
  readonly faults: Readonly<Record<string, number>>;
}

/** This function reads a UTC time of the service: `2024-07-01 23:58` or `202407012358`. It gives undefined for other text. */
export function watchwarnTime(text: string): number | undefined {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2})$/.exec(text.trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const time = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(time);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59) return undefined;
  return time;
}

/** The count of characters that the reader parses at one time. Thus a large answer does not become one large array. */
const PARSE_CHARS = 1_000_000;

/**
 * This function reads one CSV text of the service. It throws an error when the header does not have a column of
 * `WATCHWARN_COLUMNS`. It also throws an error for a pair of a phenomenon and a significance that the query did not
 * ask for.
 *
 * - A row with no office, a bad event number or a bad year has no key. The reader skips it, with the fault `key`.
 * - A row with a bad UGC, no start or no end stays a row for the count of alerts. Its fault tells that the join cannot
 *   use it.
 */
export function readWatchwarn(body: string): WatchwarnRead {
  const rows: AlertRow[] = [];
  const faults: Record<string, number> = {};
  const fault = (name: string): void => {
    faults[name] = (faults[name] ?? 0) + 1;
  };
  let columns: Readonly<Record<(typeof WATCHWARN_COLUMNS)[number], number>> | undefined;
  const take = (text: string): void => {
    if (text.trim() === "") return;
    for (const fields of parseCsv(text)) {
      if (columns === undefined) {
        const found = Object.fromEntries(WATCHWARN_COLUMNS.map((name) => [name, fields.indexOf(name)])) as Record<(typeof WATCHWARN_COLUMNS)[number], number>;
        const missing = WATCHWARN_COLUMNS.filter((name) => found[name] < 0);
        if (missing.length > 0) throw new Error(`The CSV text of the alerts has no column ${missing.join(", ")}.`);
        columns = found;
        continue;
      }
      const at = (name: (typeof WATCHWARN_COLUMNS)[number]): string => (fields[(columns as Record<string, number>)[name] as number] ?? "").trim();
      const phenomenon = at("phenomena");
      const significance = at("significance");
      if (!ALERT_PHENOMENA.includes(phenomenon) || !(ALERT_SIGNIFICANCES as readonly string[]).includes(significance)) {
        throw new Error(`The CSV text of the alerts has the pair ${JSON.stringify(`${phenomenon}.${significance}`)}, and the query did not ask for it.`);
      }
      const wfo = at("wfo");
      const eventId = at("eventid");
      const year = at("vtec_year");
      if (!/^[A-Z0-9]{3,4}$/.test(wfo) || !/^\d{1,4}$/.test(eventId) || !/^\d{4}$/.test(year)) {
        fault("key");
        continue;
      }
      const ugc = at("ugc");
      if (ugc !== "" && !isUgcCode(ugc)) fault("ugc");
      const issue = watchwarnTime(at("utc_issue"));
      const expire = watchwarnTime(at("utc_expire"));
      if (issue === undefined) fault("issue");
      if (expire === undefined) fault("expire");
      rows.push({ wfo, phenomenon, significance: significance as AlertSignificance, eventId: Number(eventId), year: Number(year), ugc: isUgcCode(ugc) ? ugc : "", issue, expire });
    }
  };
  const framer = new RecordFramer();
  for (let index = 0; index < body.length; index += PARSE_CHARS) take(framer.push(body.slice(index, index + PARSE_CHARS)));
  take(framer.end());
  if (columns === undefined) throw new Error("The CSV text of the alerts is empty.");
  return { rows, faults };
}

/**
 * This function gives the key of the event of a row. Two rows with one key are one alert. The key has the office,
 * the phenomenon, the significance, the event number and the year. A national number (`NATIONAL_NUMBERS`) has no
 * office in its key.
 */
export function alertKey(row: Pick<AlertRow, "wfo" | "phenomenon" | "significance" | "eventId" | "year">): string {
  const event = `${row.phenomenon}.${row.significance}.${String(row.eventId)}.${String(row.year)}`;
  return nationalNumber(row.phenomenon, row.significance) ? event : `${row.wfo}.${event}`;
}

/** The time in which the first rows of two offices start, for a number that they share as a national number: one hour. */
export const TOGETHER_MS = 3_600_000;

/** The least count of shared numbers for a doubt of `numberingDoubts`. With fewer, a chance match of two offices decides too much. */
export const NUMBERING_MIN_SHARED = 20;

/**
 * The share of the shared numbers that start together, above which a pair has a national number. The measure of 2021
 * to 2025 gave 0.82 or more for each national pair and 0.58 or less for each pair of the offices. Weather starts many
 * offices at one time, for example the first freeze of a season. Thus a pair of the offices can come near 0.5.
 */
export const NUMBERING_TOGETHER_SHARE = 0.7;

/**
 * The check of the numbers of one pair of a phenomenon and a significance. A number here has no office: the
 * phenomenon, the significance, the event number and the year.
 *
 * Each office counts its own numbers from 1. Thus two offices often use one number for two alerts, at different
 * times. A national number is one alert in each office of the alert, and these offices start it at the same time.
 */
export interface NumberingCheck {
  /** True when `NATIONAL_NUMBERS` has the pair. */
  readonly national: boolean;
  /** The count of numbers. */
  readonly numbers: number;
  /** The count of numbers that two or more offices use. */
  readonly shared: number;
  /** The count of shared numbers whose first rows in two offices start less than `TOGETHER_MS` apart. */
  readonly together: number;
}

/** The counts of the alerts of a measure. */
export interface AlertCounts {
  /** The count of rows that the tally read, with the rows of the first window. */
  readonly rows: number;
  /** The alerts of each pair of a phenomenon and a significance (for example `RP.S`), in each year. Each year has a value. */
  readonly alerts: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The rows of each pair in counties (`C`) and in zones (`Z`), in the years. */
  readonly areas: Readonly<Record<string, { readonly counties: number; readonly zones: number }>>;
  /** The check of the numbers of each pair. */
  readonly numbering: Readonly<Record<string, NumberingCheck>>;
  /** The rows with each fault (`readWatchwarn`). */
  readonly faults: Readonly<Record<string, number>>;
}

/**
 * A tally counts the alerts of the rows of each window. An alert counts in the VTEC year of its number, and only
 * in the years of the tally. Two rows with one key (`alertKey`) count one time.
 */
export class AlertTally {
  readonly #years: Years;
  readonly #keys = new Map<string, Map<number, Set<string>>>();
  readonly #areas = new Map<string, { counties: number; zones: number }>();
  readonly #numbers = new Map<string, Map<string, Map<string, number>>>();
  readonly #faults = new Map<string, number>();
  #rows = 0;

  constructor(years: Years) {
    this.#years = years;
  }

  /** This function adds the rows and the faults of one window. */
  add(read: WatchwarnRead): void {
    for (const [name, count] of Object.entries(read.faults)) this.#faults.set(name, (this.#faults.get(name) ?? 0) + count);
    for (const row of read.rows) {
      this.#rows += 1;
      if (row.year < this.#years.first || row.year > this.#years.last) continue;
      const pair = `${row.phenomenon}.${row.significance}`;
      let byYear = this.#keys.get(pair);
      if (byYear === undefined) this.#keys.set(pair, (byYear = new Map()));
      let keys = byYear.get(row.year);
      if (keys === undefined) byYear.set(row.year, (keys = new Set()));
      keys.add(alertKey(row));
      if (row.ugc !== "") {
        let areas = this.#areas.get(pair);
        if (areas === undefined) this.#areas.set(pair, (areas = { counties: 0, zones: 0 }));
        if (row.ugc[2] === "C") areas.counties += 1;
        else areas.zones += 1;
      }
      if (row.issue !== undefined) {
        let numbers = this.#numbers.get(pair);
        if (numbers === undefined) this.#numbers.set(pair, (numbers = new Map()));
        const number = `${String(row.eventId)}.${String(row.year)}`;
        let offices = numbers.get(number);
        if (offices === undefined) numbers.set(number, (offices = new Map()));
        const first = offices.get(row.wfo);
        if (first === undefined || row.issue < first) offices.set(row.wfo, row.issue);
      }
    }
  }

  /** This function gives the counts. The keys of each record are in order, so the JSON text is stable. */
  counts(): AlertCounts {
    const pairs = [...this.#keys.keys()].sort();
    const years: number[] = [];
    for (let year = this.#years.first; year <= this.#years.last; year += 1) years.push(year);
    const alerts = Object.fromEntries(pairs.map((pair) => [pair, Object.fromEntries(years.map((year) => [String(year), this.#keys.get(pair)?.get(year)?.size ?? 0]))]));
    const areas = Object.fromEntries([...this.#areas.keys()].sort().map((pair) => [pair, { ...(this.#areas.get(pair) as { counties: number; zones: number }) }]));
    const numbering = Object.fromEntries(
      [...this.#numbers.keys()].sort().map((pair) => {
        const numbers = this.#numbers.get(pair) as Map<string, Map<string, number>>;
        let shared = 0;
        let together = 0;
        for (const offices of numbers.values()) {
          if (offices.size < 2) continue;
          shared += 1;
          const starts = [...offices.values()].sort((a, b) => a - b);
          if (starts.some((start, index) => index > 0 && start - (starts[index - 1] as number) < TOGETHER_MS)) together += 1;
        }
        const [phenomenon = "", significance = ""] = pair.split(".");
        return [pair, { national: nationalNumber(phenomenon, significance), numbers: numbers.size, shared, together }];
      }),
    );
    const faults = Object.fromEntries([...this.#faults.keys()].sort().map((name) => [name, this.#faults.get(name) as number]));
    return { rows: this.#rows, alerts, areas, numbering, faults };
  }
}

/**
 * This function gives each pair whose data do not agree with `NATIONAL_NUMBERS`, with the reason. A pair needs
 * `NUMBERING_MIN_SHARED` or more shared numbers for a doubt.
 *
 * - A national pair with a share below `NUMBERING_TOGETHER_SHARE` is a doubt: its offices start at different times.
 * - A pair of the offices with that share or more is a doubt: its offices start at the same time.
 */
export function numberingDoubts(numbering: Readonly<Record<string, NumberingCheck>>): string[] {
  const doubts: string[] = [];
  for (const [pair, check] of Object.entries(numbering)) {
    if (check.shared < NUMBERING_MIN_SHARED) continue;
    const share = check.together / check.shared;
    const counts = `${String(check.together)} of ${String(check.shared)} shared numbers start together`;
    if (check.national && share < NUMBERING_TOGETHER_SHARE) doubts.push(`${pair} has a national number, but only ${counts}.`);
    if (!check.national && share >= NUMBERING_TOGETHER_SHARE) doubts.push(`${pair} has a number of each office, but ${counts}.`);
  }
  return doubts;
}
