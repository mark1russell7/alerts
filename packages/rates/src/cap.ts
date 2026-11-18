/**
 * The CAP fields of the NWS alerts of each VTEC code (AL-31 step 4b). The level of the table of an alert comes from its
 * CAP severity and urgency. The IEM archive of the VTEC alerts has no CAP fields, so the replay of the archive takes
 * them from this count.
 *
 * The NWS API keeps the alerts of approximately 7 days. Thus each run of the measure reads the days that no earlier run
 * read. The counts build up in `data/cap.json`, in the UTC month of the time `sent` of each alert. The windows of two
 * runs do not overlap, so no alert counts two times. The functions are pure. The script `scripts/measure-cap.ts`
 * fetches the pages.
 */

import { certaintySchema, severitySchema, urgencySchema, type Certainty, type Instant, type Severity, type Urgency } from "@mark1russell7/alerts";
import { parseVtec } from "@mark1russell7/alerts-format-nws";
import { compareCodeUnits } from "@mark1russell7/text/order";

/** The format of the file of the CAP fields. A change that breaks the file gets a new name. */
export const CAP_FORMAT = "alerts-cap/1";

/**
 * The origin of the NWS API. It is a documented API. Its `robots.txt` refuses the crawlers of pages, and the API asks a
 * program only for a `User-Agent`. The source `source-nws-api` uses it in the same way.
 */
export const CAP_ORIGIN = "https://api.weather.gov";

/** The most whole UTC days before the day of the run that one run reads. The NWS API keeps the alerts of approximately 7 days. */
export const CAP_DAYS = 6;

/** The most alerts on one page of the NWS API. */
export const CAP_LIMIT = 500;

/** The most pages of one run. A run with more pages stops, because the links of the pages can go in a circle. */
export const CAP_MAX_PAGES = 400;

const DAY_MS = 86_400_000;

/** The time window of the alerts of one run, in UTC. */
export interface CapWindow {
  readonly start: Instant;
  readonly end: Instant;
}

/** The reasons that an alert does not count. */
export const CAP_SKIPS = ["status", "message type", "repeat", "no new VTEC", "several codes", "fields"] as const;

/** One reason that an alert does not count. */
export type CapSkip = (typeof CAP_SKIPS)[number];

/** The CAP fields of an alert as one key, for example `extreme/immediate/observed`. */
export type CapKey = `${Severity}/${Urgency}/${Certainty}`;

/** For each VTEC code, as `TO.W`, the count of the alerts with each key. */
export type CapCodes = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** For each UTC month, as `2026-11`, the counts of its codes. */
export type CapMonths = Readonly<Record<string, CapCodes>>;

/** One alert of a page, with the fields that the count reads. */
export interface CapAlert {
  readonly id: string;
  /** The time of the message, as an ISO time with its offset. */
  readonly sent: string;
  readonly status: string;
  readonly messageType: string;
  readonly severity: string;
  readonly urgency: string;
  readonly certainty: string;
  /** The VTEC strings of the parameters of the alert. */
  readonly vtec: readonly string[];
}

/** One page of the alerts of the NWS API. */
export interface CapPage {
  readonly alerts: readonly CapAlert[];
  /** The link of the next page. The last page can have a link to an empty page. */
  readonly next?: string;
}

/** The record of one run of the measure, with no counts of codes. */
export interface CapRunHead {
  /** The start of the window, as an ISO time. */
  readonly start: string;
  /** The end of the window, as an ISO time. */
  readonly end: string;
  readonly pages: number;
  /** The count of the alerts on the pages. */
  readonly read: number;
  /** The count of the alerts that count. */
  readonly counted: number;
  readonly skipped: Readonly<Record<CapSkip, number>>;
  /** For each UTC day of the time `sent`, as `2026-11-14`, the count of the alerts with that day, repeats not included. */
  readonly days: Readonly<Record<string, number>>;
}

/** The count of one run of the measure. */
export interface CapRun extends CapRunHead {
  readonly months: CapMonths;
}

/** The file of the CAP fields: the record of each run, in the order of the windows, and the counts of each month. */
export interface CapFile {
  readonly format: typeof CAP_FORMAT;
  readonly origin: typeof CAP_ORIGIN;
  readonly runs: readonly CapRunHead[];
  readonly months: CapMonths;
}

const iso = (time: Instant): string => new Date(time).toISOString().replace(".000Z", "Z");

/**
 * This function gives the window of a run. The window is the whole UTC days before the day of the run, at most `days`
 * of them. It starts at the end of the last run of the file, or later. It gives `undefined` when no whole day is new.
 */
export function capWindow(now: Instant, file?: CapFile, days: number = CAP_DAYS): CapWindow | undefined {
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  const last = file?.runs.at(-1);
  const start = Math.max(end - days * DAY_MS, last === undefined ? Number.NEGATIVE_INFINITY : Date.parse(last.end));
  return start < end ? { start, end } : undefined;
}

/** This function gives the path of the first page of the alerts of a window. */
export function capQuery(window: CapWindow): string {
  return `/alerts?${new URLSearchParams({ start: iso(window.start), end: iso(window.end), limit: String(CAP_LIMIT) }).toString()}`;
}

/** This function gives the path of the next page from its link. A link to another origin gives an error, so the script asks no other host. */
export function nextPath(link: string): string {
  const url = new URL(link);
  if (url.origin !== CAP_ORIGIN) throw new Error(`The next page is on ${url.origin}, not on ${CAP_ORIGIN}.`);
  return `${url.pathname}${url.search}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** This function reads one page of the alerts. A text that is not a collection of alerts with ids gives an error. */
export function readCapPage(body: string): CapPage {
  const json: unknown = JSON.parse(body);
  if (!isRecord(json) || !Array.isArray(json["features"])) throw new Error("The text is not a collection of alerts: it has no list features.");
  const alerts = json["features"].map((feature: unknown, index): CapAlert => {
    const properties = isRecord(feature) ? feature["properties"] : undefined;
    if (!isRecord(properties) || typeof properties["id"] !== "string") throw new Error(`The alert ${String(index)} of the page has no properties with an id.`);
    const parameters = isRecord(properties["parameters"]) ? properties["parameters"] : {};
    const vtec = Array.isArray(parameters["VTEC"]) ? parameters["VTEC"].filter((text): text is string => typeof text === "string") : [];
    return {
      id: properties["id"],
      sent: textOf(properties["sent"]),
      status: textOf(properties["status"]),
      messageType: textOf(properties["messageType"]),
      severity: textOf(properties["severity"]),
      urgency: textOf(properties["urgency"]),
      certainty: textOf(properties["certainty"]),
      vtec,
    };
  });
  const pagination = json["pagination"];
  const next = isRecord(pagination) && typeof pagination["next"] === "string" ? pagination["next"] : undefined;
  return next === undefined ? { alerts } : { alerts, next };
}

/** The place of one alert in the counts: its UTC month, its VTEC code and its key. */
export interface CapPlace {
  readonly month: string;
  readonly code: string;
  readonly key: CapKey;
}

/**
 * This function gives the place of an alert in the counts, or the reason that it does not count. Only the first message
 * of an actual alert counts, with one operational VTEC code of the action `NEW`. Thus each alert counts one time.
 */
export function capCount(alert: CapAlert): CapPlace | { readonly skip: Exclude<CapSkip, "repeat"> } {
  if (alert.status !== "Actual") return { skip: "status" };
  if (alert.messageType !== "Alert") return { skip: "message type" };
  const codes = new Set<string>();
  for (const text of alert.vtec) {
    const vtec = parseVtec(text);
    if (vtec?.productClass === "O" && vtec.action === "NEW") codes.add(`${vtec.phenomenon}.${vtec.significance}`);
  }
  const [code, ...others] = codes;
  if (code === undefined) return { skip: "no new VTEC" };
  if (others.length > 0) return { skip: "several codes" };
  const sent = Date.parse(alert.sent);
  const severity = severitySchema.safeParse(alert.severity.toLowerCase());
  const urgency = urgencySchema.safeParse(alert.urgency.toLowerCase());
  const certainty = certaintySchema.safeParse(alert.certainty.toLowerCase());
  if (Number.isNaN(sent) || !severity.success || !urgency.success || !certainty.success) return { skip: "fields" };
  return { month: new Date(sent).toISOString().slice(0, 7), code, key: `${severity.data}/${urgency.data}/${certainty.data}` };
}

type Counts = Map<string, Map<string, Map<string, number>>>;

const sortedRecord = <T>(map: ReadonlyMap<string, T>): Record<string, T> =>
  Object.fromEntries([...map.keys()].sort(compareCodeUnits).map((key) => [key, map.get(key) as T]));

const monthsOf = (counts: Counts): CapMonths =>
  sortedRecord(new Map([...counts].map(([month, codes]) => [month, sortedRecord(new Map([...codes].map(([code, keys]) => [code, sortedRecord(keys)])))])));

function addTo(counts: Counts, month: string, code: string, key: string, count: number): void {
  const codes = counts.get(month) ?? new Map<string, Map<string, number>>();
  const keys = codes.get(code) ?? new Map<string, number>();
  keys.set(key, (keys.get(key) ?? 0) + count);
  codes.set(code, keys);
  counts.set(month, codes);
}

function addMonths(counts: Counts, months: CapMonths): void {
  for (const [month, codes] of Object.entries(months)) {
    for (const [code, keys] of Object.entries(codes)) for (const [key, count] of Object.entries(keys)) addTo(counts, month, code, key, count);
  }
}

/** The count of the alerts of one run. An alert with an id that the tally has counts as a repeat. */
export class CapTally {
  readonly #ids = new Set<string>();
  readonly #counts: Counts = new Map();
  readonly #skipped = new Map<CapSkip, number>(CAP_SKIPS.map((skip) => [skip, 0]));
  readonly #days = new Map<string, number>();
  #read = 0;
  #counted = 0;

  /** This method adds one alert to the tally. */
  add(alert: CapAlert): void {
    this.#read += 1;
    const repeat = this.#ids.has(alert.id);
    const found = repeat ? { skip: "repeat" as const } : capCount(alert);
    this.#ids.add(alert.id);
    const sent = Date.parse(alert.sent);
    if (!repeat && !Number.isNaN(sent)) {
      const day = new Date(sent).toISOString().slice(0, 10);
      this.#days.set(day, (this.#days.get(day) ?? 0) + 1);
    }
    if ("skip" in found) {
      this.#skipped.set(found.skip, (this.#skipped.get(found.skip) ?? 0) + 1);
      return;
    }
    this.#counted += 1;
    addTo(this.#counts, found.month, found.code, found.key, 1);
  }

  /** This method gives the run of a window, with the months, the codes and the keys in their order. */
  run(window: CapWindow, pages: number): CapRun {
    return {
      start: iso(window.start),
      end: iso(window.end),
      pages,
      read: this.#read,
      counted: this.#counted,
      skipped: Object.fromEntries(CAP_SKIPS.map((skip) => [skip, this.#skipped.get(skip) ?? 0])) as Record<CapSkip, number>,
      days: sortedRecord(this.#days),
      months: monthsOf(this.#counts),
    };
  }
}

/**
 * This function adds a run to the committed file: its record, in the order of the windows, and its counts of each
 * month. A run whose window overlaps the window of a committed run gives an error. Its alerts can count
 * two times.
 */
export function capFile(committed: CapFile | undefined, run: CapRun): CapFile {
  const runs = committed?.runs ?? [];
  const [start, end] = [Date.parse(run.start), Date.parse(run.end)];
  const overlap = runs.find((other) => Date.parse(other.start) < end && start < Date.parse(other.end));
  if (overlap !== undefined) throw new Error(`The window ${run.start} to ${run.end} overlaps the window ${overlap.start} to ${overlap.end} of the file.`);
  const counts: Counts = new Map();
  addMonths(counts, committed?.months ?? {});
  addMonths(counts, run.months);
  const head: CapRunHead = { start: run.start, end: run.end, pages: run.pages, read: run.read, counted: run.counted, skipped: run.skipped, days: run.days };
  return {
    format: CAP_FORMAT,
    origin: CAP_ORIGIN,
    runs: [...runs, head].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
    months: monthsOf(counts),
  };
}

/**
 * This function gives the UTC days of the window of a run with no alert. The NWS sends alerts each day. Thus a day with
 * no alert is a gap of the API, for example a day older than the alerts that the API keeps.
 */
export function capGaps(run: CapRunHead): string[] {
  const gaps: string[] = [];
  for (let time = Date.parse(run.start); time < Date.parse(run.end); time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    if ((run.days[day] ?? 0) === 0) gaps.push(day);
  }
  return gaps;
}

/** This function reads the text of a file of the CAP fields. A text of another format gives an error. */
export function readCapFile(text: string): CapFile {
  const json: unknown = JSON.parse(text);
  if (!isRecord(json) || json["format"] !== CAP_FORMAT || !Array.isArray(json["runs"]) || !isRecord(json["months"])) {
    throw new Error(`The text is not a file of the format ${CAP_FORMAT}.`);
  }
  return json as unknown as CapFile;
}

/** This function gives the count of the alerts of one VTEC code with each key, over each month, or over the months of `only`. */
export function capCounts(months: CapMonths, code: string, only?: readonly string[]): { readonly alerts: number; readonly keys: Readonly<Record<string, number>> } {
  const keys = new Map<string, number>();
  for (const [month, codes] of Object.entries(months)) {
    if (only !== undefined && !only.includes(month)) continue;
    for (const [key, count] of Object.entries(codes[code] ?? {})) keys.set(key, (keys.get(key) ?? 0) + count);
  }
  return { alerts: [...keys.values()].reduce((sum, count) => sum + count, 0), keys: sortedRecord(keys) };
}

/** This function gives the summary of a run in Markdown: the window, the counts and the most frequent key of each code of the run. */
export function capSummary(file: CapFile, run: CapRun): string {
  const lines = [
    "## The CAP fields of the NWS alerts",
    "",
    `The run read ${String(run.read)} alerts on ${String(run.pages)} pages, from ${run.start} to ${run.end}. Of them, ${String(run.counted)} count.`,
    `The other alerts: ${CAP_SKIPS.map((skip) => `${skip} ${String(run.skipped[skip])}`).join(", ")}.`,
    `The file has ${String(file.runs.length)} runs over ${String(Object.keys(file.months).length)} months.`,
    capGaps(run).length === 0 ? "Each day of the window has alerts." : `These days of the window have no alert: ${capGaps(run).join(", ")}.`,
    "",
    "| Code | Alerts in the run | Alerts in the file | Most frequent key | Share |",
    "| --- | ---: | ---: | --- | ---: |",
  ];
  const codes = [...new Set(Object.values(run.months).flatMap((each) => Object.keys(each)))].sort(compareCodeUnits);
  for (const code of codes) {
    const all = capCounts(file.months, code);
    const top = Object.entries(all.keys).reduce((best, entry) => (entry[1] > best[1] ? entry : best));
    lines.push(`| ${code} | ${String(capCounts(run.months, code).alerts)} | ${String(all.alerts)} | ${top[0]} | ${(top[1] / all.alerts).toFixed(2)} |`);
  }
  return `${lines.join("\n")}\n`;
}
