/**
 * The replay of the table and the score over the archive of the NWS alerts (AL-31 step 4b). The replay gives each
 * alert type its table level and its score for each key of its CAP fields. It also gives the alerts of the type in one
 * place in each year. Then it gives the sends at `life-safety` in one place in each year at each risk value. A send at
 * `life-safety` wakes a person at night.
 *
 * The rule of step 4 sends an alert at `life-safety` in two cases. The table gives `life-safety`, or the expected
 * deaths of its score are at the risk value or higher. Thus the table stays the floor. The replay also gives the sends of the
 * score alone, so the pairs where the table and the score disagree are clear.
 *
 * The replay puts the CAP fields of the recent alerts of each VTEC code on the alerts of all the years. Thus it
 * supposes that the share of each key of a code does not change over the years.
 *
 * The functions are pure. A type with no read of a factor shows no read, not 0.
 */

import {
  certaintySchema,
  severitySchema,
  shadowScore,
  tableLevel,
  urgencySchema,
  type AssessedLevel,
  type AssessPolicy,
  type Certainty,
  type Kind,
  type ScorePriors,
  type Severity,
  type Urgency,
} from "@mark1russell7/alerts";
import { SIGNIFICANCE } from "@mark1russell7/alerts-format-nws";
import { compareCodeUnits } from "@mark1russell7/text/order";
import { capCounts, type CapKey, type CapMonths } from "./cap.ts";
import type { UnderRate, UnderSection } from "./under.ts";
import type { AlertSignificance, CodeCounts } from "./watchwarn.ts";
import { eachYear, type Years } from "./years.ts";

/** The format of a replay. */
export const REPLAY_FORMAT = "alerts-replay/1";

/** The risk values of the replay: the expected deaths in one place under one alert. Each step is approximately half a decade. */
export const RISK_VALUES: readonly number[] = [1e-6, 3e-6, 1e-5, 3e-5, 1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 3e-2, 1e-1];

/** The count of types in the table of the summary: the types with the most alerts in one place. */
export const TOP_REPLAY = 25;

/** The table level and the score of one key of the CAP fields of a type. */
export interface ReplayKey {
  readonly key: CapKey;
  /** The alerts of the type with this key in the file of the CAP fields. */
  readonly alerts: number;
  /** The level of the table for an alert with this key in a place of the person. */
  readonly level: AssessedLevel;
  /** The expected deaths of the score in one place under one alert. The value is absent when the score has no read. */
  readonly deaths?: number;
  /** The basis of the score (`ShadowScore`). The value is absent when the score has no read. */
  readonly basis?: "alert" | "event";
}

/** The alerts of a type in one place in each year: the mean of the years, and the lowest and the highest year. */
export interface PlaceRate {
  readonly mean: number;
  readonly low: number;
  readonly high: number;
}

/** The replay of one alert type: one kind of the taxonomy and one significance. */
export interface ReplayType {
  readonly kind: string;
  readonly significance: AlertSignificance;
  /** The VTEC codes of the type, for example `TO.W`. */
  readonly codes: readonly string[];
  /** The mean of the alerts of the type in each year, in the whole country. */
  readonly alerts: number;
  /** The alerts of the type in one place in each year. The value is absent when the file of the base rates has no codes. */
  readonly place?: PlaceRate;
  /** The alerts of the type in the file of the CAP fields. */
  readonly cap: number;
  /** The keys of the CAP fields of the type, with the most alerts first. */
  readonly keys: readonly ReplayKey[];
}

/** The sends at `life-safety` in one place in each year at one risk value. Only the types with a read of the place and the CAP fields count. */
export interface ReplayPoint {
  readonly risk: number;
  /** The sends of the score alone. */
  readonly score: number;
  /** The sends of the rule: the table or the score. */
  readonly rule: number;
  /** The sends of the rule that the table does not give. */
  readonly added: number;
  /** The sends of the table that the score alone does not give. The floor keeps them. */
  readonly kept: number;
}

/** The replay of the table and the score. */
export interface ReplayFile {
  readonly format: typeof REPLAY_FORMAT;
  /** The years of the alerts. */
  readonly years: Years;
  /** The months of the file of the CAP fields. */
  readonly months: readonly string[];
  readonly types: readonly ReplayType[];
  /** The sends of the table at `life-safety` in one place in each year, over the types of the curve. */
  readonly table: number;
  readonly curve: readonly ReplayPoint[];
  /**
   * The types with no read of each factor, as `kind|significance`. A type with no read of the place or of the CAP
   * fields is not in the curve. A key with no read of the score sends only by the table.
   */
  readonly noRead: { readonly place: readonly string[]; readonly cap: readonly string[]; readonly score: readonly string[] };
}

/** The input of a replay. */
export interface ReplayInput {
  /** The section `under` of the file of the base rates. */
  readonly under: UnderSection;
  /** The counts of the file of the CAP fields. */
  readonly months: CapMonths;
  readonly priors: ScorePriors;
  readonly policy: AssessPolicy;
  /** The risk values of the curve. The default is `RISK_VALUES`. */
  readonly risks?: readonly number[];
}

/** This function reads a key of the CAP fields. It throws an error for a key that is not of the form `severity/urgency/certainty`. */
export function readCapKey(key: string): { readonly severity: Severity; readonly urgency: Urgency; readonly certainty: Certainty } {
  const [severity, urgency, certainty, ...rest] = key.split("/");
  const read = { severity: severitySchema.safeParse(severity), urgency: urgencySchema.safeParse(urgency), certainty: certaintySchema.safeParse(certainty) };
  if (rest.length > 0 || !read.severity.success || !read.urgency.success || !read.certainty.success) throw new Error(`The key ${JSON.stringify(key)} is not of the form severity/urgency/certainty.`);
  return { severity: read.severity.data, urgency: read.urgency.data, certainty: read.certainty.data };
}

/**
 * This function gives the alerts of a type in one place in each year. A place is in one county and in one zone. Thus
 * the alerts in one place in a year come from the areas. The areas in counties go over the counties of that year, and
 * the areas in zones over the zones. The value is absent when the codes are absent or a year has no codes.
 */
export function placeRate(rate: UnderRate, codes: Readonly<Record<string, CodeCounts>> | undefined, years: Years): PlaceRate | undefined {
  if (codes === undefined) return undefined;
  const values: number[] = [];
  for (const year of eachYear(years).map(String)) {
    const count = codes[year];
    if (count === undefined) return undefined;
    let value = 0;
    for (const type of ["counties", "zones"] as const) {
      const areas = rate.byArea[type].areas[year] ?? 0;
      if (areas === 0) continue;
      if (count[type] === 0) throw new Error(`The year ${year} has ${String(areas)} areas in ${type}, but no codes in ${type}.`);
      value += areas / count[type];
    }
    values.push(value);
  }
  if (values.length === 0) return undefined;
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, low: Math.min(...values), high: Math.max(...values) };
}

/** This function gives the replay of the table and the score. */
export function replayOf(input: ReplayInput): ReplayFile {
  const risks = input.risks ?? RISK_VALUES;
  const years = eachYear(input.under.years).map(String);
  const types: ReplayType[] = [];
  const noRead = { place: [] as string[], cap: [] as string[], score: [] as string[] };
  for (const [code, entry] of Object.entries(input.under.kinds)) {
    for (const [letter, rate] of Object.entries(entry.significances)) {
      const significance = letter as AlertSignificance;
      const id = `${code}|${significance}`;
      const codes = Object.keys(rate.phenomena)
        .map((phenomenon) => `${phenomenon}.${significance}`)
        .sort(compareCodeUnits);
      const kind: Kind = { code, label: codes.join(" "), ...(SIGNIFICANCE[significance] === undefined ? {} : { significance: SIGNIFICANCE[significance] }) };
      const counts = new Map<string, number>();
      for (const each of codes) for (const [key, alerts] of Object.entries(capCounts(input.months, each).keys)) counts.set(key, (counts.get(key) ?? 0) + alerts);
      const keys = [...counts.entries()]
        .sort(([keyA, a], [keyB, b]) => b - a || compareCodeUnits(keyA, keyB))
        .map(([key, alerts]): ReplayKey => {
          const fields = readCapKey(key);
          const level = tableLevel(input.policy, { kind, severity: fields.severity, urgency: fields.urgency }).level;
          const score = shadowScore({ kind, certainty: fields.certainty }, input.priors);
          return { key: key as CapKey, alerts, level, ...(score.read ? { deaths: score.expected.deaths.value, basis: score.basis } : {}) };
        });
      const place = placeRate(rate, input.under.codes, input.under.years);
      if (place === undefined) noRead.place.push(id);
      if (keys.length === 0) noRead.cap.push(id);
      if (keys.some((key) => key.deaths === undefined)) noRead.score.push(id);
      const alerts = years.reduce((sum, year) => sum + (rate.alerts[year] ?? 0), 0) / years.length;
      types.push({ kind: code, significance, codes, alerts, ...(place === undefined ? {} : { place }), cap: keys.reduce((sum, key) => sum + key.alerts, 0), keys });
    }
  }

  let table = 0;
  const points = risks.map((risk) => ({ risk, score: 0, rule: 0, added: 0, kept: 0 }));
  for (const type of types) {
    if (type.place === undefined || type.cap === 0) continue;
    for (const key of type.keys) {
      const weight = (type.place.mean * key.alerts) / type.cap;
      const floor = key.level === "life-safety";
      if (floor) table += weight;
      for (const point of points) {
        const sends = key.deaths !== undefined && key.deaths >= point.risk;
        if (sends) point.score += weight;
        if (floor || sends) point.rule += weight;
        if (!floor && sends) point.added += weight;
        if (floor && !sends) point.kept += weight;
      }
    }
  }
  const months = Object.keys(input.months).sort(compareCodeUnits);
  return { format: REPLAY_FORMAT, years: input.under.years, months, types, table, curve: points, noRead };
}

/** This function gives a number in two significant digits, and 0 as `0`. */
const digits = (value: number): string => (value === 0 ? "0" : value.toPrecision(2));

/** This function gives the expected deaths of a type: the mean of its keys with a read, by their alerts. */
function typeDeaths(type: ReplayType): number | undefined {
  const read = type.keys.filter((key) => key.deaths !== undefined);
  const alerts = read.reduce((sum, key) => sum + key.alerts, 0);
  return alerts === 0 ? undefined : read.reduce((sum, key) => sum + (key.deaths as number) * key.alerts, 0) / alerts;
}

/** This function gives the share of the CAP alerts of a type at `life-safety` by the table. */
const lifeSafetyShare = (type: ReplayType): number | undefined =>
  type.cap === 0 ? undefined : type.keys.reduce((sum, key) => sum + (key.level === "life-safety" ? key.alerts : 0), 0) / type.cap;

/** This function gives the summary of a replay in Markdown. */
export function replaySummary(replay: ReplayFile): string {
  const lines = [
    `### The replay of the table and the score (${String(replay.years.first)} to ${String(replay.years.last)})`,
    "",
    `The replay takes the CAP fields of ${String(replay.months.length)} months. A send at \`life-safety\` wakes a person at night. The rule sends at \`life-safety\` when the table gives \`life-safety\` or the expected deaths are at the risk value or higher.`,
    "",
  ];
  const curve = replay.types.filter((type) => type.place !== undefined && type.cap > 0).length;
  if (curve === 0) {
    lines.push("No type has a read of the place and of the CAP fields. The curve has no read.", "");
  } else {
    lines.push(`The curve has ${String(curve)} types. The table gives ${digits(replay.table)} sends at \`life-safety\` in one place in each year.`, "");
    lines.push("| Risk value | The score alone | The table or the score | Added by the score | Kept by the table |", "| --- | --- | --- | --- | --- |");
    for (const point of replay.curve) lines.push(`| ${digits(point.risk)} | ${digits(point.score)} | ${digits(point.rule)} | ${digits(point.added)} | ${digits(point.kept)} |`);
    lines.push("");
  }
  const top = replay.types
    .filter((type) => type.place !== undefined)
    .sort((a, b) => (b.place?.mean ?? 0) - (a.place?.mean ?? 0) || compareCodeUnits(`${a.kind}|${a.significance}`, `${b.kind}|${b.significance}`))
    .slice(0, TOP_REPLAY);
  if (top.length > 0) {
    lines.push("| Type | Codes | Alerts in each year | In one place in each year | CAP alerts | Share at `life-safety` | Expected deaths |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const type of top) {
      const share = lifeSafetyShare(type);
      const deaths = typeDeaths(type);
      const place = type.place as PlaceRate;
      lines.push(
        `| \`${type.kind}\` ${type.significance} | ${type.codes.join(", ")} | ${digits(type.alerts)} | ${digits(place.mean)} (${digits(place.low)} to ${digits(place.high)}) | ${String(type.cap)} | ${share === undefined ? "no read" : share.toFixed(2)} | ${deaths === undefined ? "no read" : digits(deaths)} |`,
      );
    }
    lines.push("");
  }
  const gaps = [
    ["the place", replay.noRead.place],
    ["the CAP fields", replay.noRead.cap],
    ["the score", replay.noRead.score],
  ] as const;
  for (const [factor, ids] of gaps) if (ids.length > 0) lines.push(`No read of ${factor} (${String(ids.length)} types): ${ids.map((id) => `\`${id}\``).join(", ")}.`, "");
  return `${lines.join("\n")}\n`;
}
