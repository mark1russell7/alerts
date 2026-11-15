/**
 * The verified share of the NWS warnings, from the Cow service of the Iowa Environmental Mesonet (IEM
 * Cow). Cow compares each storm-based warning with the local storm reports in its polygon. A warning
 * with one or more reports is verified.
 *
 * The requests are national: they name no office and no state. One request asks for the six
 * phenomena of one month. Cow gives only the warnings that start and end in the window of a request.
 * Thus each request has a margin of one day before and after its month, and the reader keeps only the
 * warnings that start in the month.
 */

import { PHENOMENA } from "@mark1russell7/alerts-format-nws";

/** The URL of the Cow service of IEM. */
export const COW_URL = "https://mesonet.agron.iastate.edu/api/1/cow.json";

/** The VTEC phenomena of the measure: the warnings that Cow verifies with storm reports. */
export const COW_PHENOMENA = ["TO", "SV", "FF", "MA", "SQ", "EW"] as const;

/** One phenomenon of the measure. */
export type CowPhenomenon = (typeof COW_PHENOMENA)[number];

/**
 * The report types of Cow (`lsrtype`) for the hazard of each phenomenon. A warning with a report of
 * these types is verified by its own hazard. A tornado also verifies a severe thunderstorm warning,
 * as in the verification of the NWS. An extreme wind warning has no report type of its own, so the
 * wind and tornado reports verify it, at the wind limit of Cow.
 */
export const OWN_REPORT_TYPES: Readonly<Record<CowPhenomenon, readonly string[]>> = {
  TO: ["TO"],
  SV: ["SV", "TO"],
  FF: ["FF"],
  MA: ["MA"],
  SQ: ["SQ"],
  EW: ["SV", "TO"],
};

/** The margin of each request before and after its window: one day, in milliseconds. */
export const COW_MARGIN_MS = 86_400_000;

/** A window of the measure: the warnings that start from `start` to before `end`, in milliseconds since the epoch. */
export interface CowWindow {
  readonly start: number;
  readonly end: number;
}

/** One warning of a Cow answer. */
export interface CowWarning {
  /** The id of Cow: the year, the office, the event number, the phenomenon and the significance. */
  readonly id: string;
  readonly phenomenon: CowPhenomenon;
  /** The start of the warning, in milliseconds since the epoch. */
  readonly issue: number;
  /** True when Cow verified the warning with one or more storm reports of any type. */
  readonly verified: boolean;
  /** True when a storm report of `OWN_REPORT_TYPES` verified the warning. */
  readonly verifiedOwn: boolean;
}

/** The warnings of one Cow answer. */
export interface CowRead {
  /** The warnings of the measure that start in the window. */
  readonly warnings: readonly CowWarning[];
  /** The parameters that Cow used, from its answer. */
  readonly params: Readonly<Record<string, unknown>>;
  /** The count of the warnings in the answer, with the margins. */
  readonly total: number;
}

/** This function gives the windows of a measure: one window for each month of the years from `first` to `last`. */
export function cowWindows(first: number, last: number): CowWindow[] {
  if (!Number.isInteger(first) || !Number.isInteger(last) || first > last) throw new RangeError(`The years ${String(first)} to ${String(last)} are not a range of whole years.`);
  const windows: CowWindow[] = [];
  for (let year = first; year <= last; year += 1) {
    for (let month = 0; month < 12; month += 1) windows.push({ start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1) });
  }
  return windows;
}

/** The length of a day, in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * This function cuts a window in two halves at a whole day, for a request that Cow did not answer
 * in time. It gives undefined for a window of one day or less.
 */
export function splitWindow(window: CowWindow): readonly [CowWindow, CowWindow] | undefined {
  const days = Math.floor((window.end - window.start) / DAY_MS);
  if (days < 2) return undefined;
  const middle = window.start + Math.floor(days / 2) * DAY_MS;
  return [
    { start: window.start, end: middle },
    { start: middle, end: window.end },
  ];
}

/** This function gives a time in the form of the queries: `2024-05-01T00:00:00Z`. */
export function queryTime(time: number): string {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * This function gives the query of one window: the window with its margins, and each phenomenon of
 * the measure. The query names no office and no state. Cow uses its defaults for each other parameter.
 */
export function cowQuery(window: CowWindow): string {
  const phenomena = COW_PHENOMENA.map((phenomenon) => `&phenomena=${phenomenon}`).join("");
  return `?begints=${queryTime(window.start - COW_MARGIN_MS)}&endts=${queryTime(window.end + COW_MARGIN_MS)}${phenomena}`;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** This function gives the features of a GeoJSON collection of a Cow answer. */
function featuresOf(answer: Readonly<Record<string, unknown>>, name: string): readonly Readonly<Record<string, unknown>>[] {
  const collection = answer[name];
  if (!isRecord(collection) || !Array.isArray(collection["features"])) throw new Error(`The Cow answer has no feature list "${name}".`);
  return collection["features"].map((feature: unknown, index: number) => {
    if (!isRecord(feature) || !isRecord(feature["properties"])) throw new Error(`The feature ${String(index)} of "${name}" has no properties.`);
    return feature;
  });
}

const isPhenomenon = (value: unknown): value is CowPhenomenon => typeof value === "string" && (COW_PHENOMENA as readonly string[]).includes(value);

/**
 * This function reads one Cow answer. It keeps the warnings of the measure that start in the window.
 * It throws an error when the answer does not have the structure of Cow, or when its counts do not
 * agree with its warnings.
 */
export function readCow(body: string, window: CowWindow): CowRead {
  const answer: unknown = JSON.parse(body);
  if (!isRecord(answer) || !isRecord(answer["params"]) || !isRecord(answer["stats"])) throw new Error("The Cow answer has no params or no stats.");
  const reportTypes = new Map<string, string>();
  for (const report of featuresOf(answer, "stormreports")) {
    const type = (report["properties"] as Readonly<Record<string, unknown>>)["lsrtype"];
    if ((typeof report["id"] !== "string" && typeof report["id"] !== "number") || typeof type !== "string") throw new Error("A storm report of the Cow answer has no id or no lsrtype.");
    reportTypes.set(String(report["id"]), type);
  }
  const events = featuresOf(answer, "events");
  const warnings: CowWarning[] = [];
  let verifiedTotal = 0;
  for (const event of events) {
    const properties = event["properties"] as Readonly<Record<string, unknown>>;
    const { phenomena, significance, issue, verify, stormreports } = properties;
    if (typeof event["id"] !== "string" || typeof phenomena !== "string" || typeof issue !== "string" || typeof verify !== "boolean" || typeof stormreports !== "string") {
      throw new Error(`The Cow event ${JSON.stringify(event["id"])} does not have the fields id, phenomena, issue, verify and stormreports.`);
    }
    if (verify) verifiedTotal += 1;
    const start = Date.parse(issue);
    if (Number.isNaN(start)) throw new Error(`The Cow event ${event["id"]} has the bad issue time ${JSON.stringify(issue)}.`);
    if (!isPhenomenon(phenomena) || significance !== "W" || start < window.start || start >= window.end) continue;
    const own = OWN_REPORT_TYPES[phenomena];
    const reports = stormreports.split(",").filter((id) => id !== "");
    const verifiedOwn = reports.some((id) => {
      const type = reportTypes.get(id);
      if (type === undefined) throw new Error(`The Cow event ${String(event["id"])} names the storm report ${id}, and the answer does not have it.`);
      return own.includes(type);
    });
    warnings.push({ id: event["id"], phenomenon: phenomena, issue: start, verified: verify, verifiedOwn });
  }
  const { events_total: total, events_verified: verified } = answer["stats"];
  if (total !== events.length || verified !== verifiedTotal) {
    throw new Error(`The stats of Cow (${String(total)} events, ${String(verified)} verified) do not agree with its events (${String(events.length)}, ${String(verifiedTotal)}).`);
  }
  return { warnings, params: answer["params"], total: events.length };
}

/** This function gives the parameters of a Cow answer without its window (`begints` and `endts`). The answers of one measure have the same settings. */
export function cowSettings(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([name]) => name !== "begints" && name !== "endts"));
}

/** The counts of the warnings of one phenomenon. */
export interface CowCount {
  readonly warnings: number;
  /** The warnings with one or more storm reports of any type. */
  readonly verified: number;
  /** The warnings with one or more storm reports of `OWN_REPORT_TYPES`. */
  readonly verifiedOwn: number;
}

/** The counts of one phenomenon over the measure, and of each year. */
export interface CowTally extends CowCount {
  readonly byYear: Readonly<Record<string, CowCount>>;
}

/**
 * This function counts the warnings of each phenomenon, over all the windows and in each year. A
 * warning with the id of an earlier warning does not count again.
 */
export function tallyCow(warnings: Iterable<CowWarning>): Record<CowPhenomenon, CowTally> {
  const seen = new Set<string>();
  const empty = (): { warnings: number; verified: number; verifiedOwn: number } => ({ warnings: 0, verified: 0, verifiedOwn: 0 });
  const totals = Object.fromEntries(COW_PHENOMENA.map((phenomenon) => [phenomenon, { ...empty(), byYear: {} as Record<string, ReturnType<typeof empty>> }])) as Record<
    CowPhenomenon,
    ReturnType<typeof empty> & { byYear: Record<string, ReturnType<typeof empty>> }
  >;
  for (const warning of warnings) {
    if (seen.has(warning.id)) continue;
    seen.add(warning.id);
    const total = totals[warning.phenomenon];
    const year = String(new Date(warning.issue).getUTCFullYear());
    const yearly = (total.byYear[year] ??= empty());
    for (const count of [total, yearly]) {
      count.warnings += 1;
      if (warning.verified) count.verified += 1;
      if (warning.verifiedOwn) count.verifiedOwn += 1;
    }
  }
  return totals;
}

/** This function gives the kind of the taxonomy and the plain name of a phenomenon, from the tables of `format-nws`. */
export function phenomenonKind(phenomenon: CowPhenomenon): { readonly kind: string; readonly label: string } {
  const hazard = PHENOMENA[phenomenon];
  if (hazard === undefined) throw new Error(`The NWS tables have no phenomenon ${phenomenon}.`);
  return { kind: hazard.code, label: hazard.label };
}
