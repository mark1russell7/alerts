/**
 * This script measures the IEM list against the NWS API (AL-8). The results give the count of misses
 * that ends a row of IEM (`SNAPSHOT_MISSES`), and the delay of IEM. The script fetches the national
 * list of each source at the interval of its descriptor. The requests name no state and no place.
 *
 * It writes one line for each fetch to `records.jsonl`, with the keys of the list. It writes the
 * results to `summary.json` and `summary.md`, and in a GitHub Actions job to the summary of the job.
 * The option `--from` reads the records of earlier measures and fetches nothing.
 *
 * The false ends count only with a horizon of complete lists after their start (`--horizon`). Each
 * false end has a bound by key and a bound by list, because one bad list can end many keys at once.
 * The script also counts the IEM product times that are not the sent time of an NWS API message of the
 * same event. A later IEM time lets the IEM rows replace the NWS API copy.
 *
 * Each IEM record has the time of the data of its list (`asOf`) and the sent time of each key. Thus the count
 * of the runs applies the rule of `snapshotStep` for an old list. The records of earlier measures have no
 * times, and count as before.
 *
 * Start it in the folder of the package:
 * `node scripts/measure.ts --minutes=55 --out=measure`, or `node scripts/measure.ts --from=a.jsonl,b.jsonl --out=sum`.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cursor, FetchOutcome, Instant, PlaceId, Report, SourceProcedures, Watch } from "@mark1russell7/alerts";
import { DELAY_LIMITS, flapCounts, listRuns, missesDecision, type FlapCount, type ListFetch, type ListRuns } from "@mark1russell7/alerts-runtime";
import { createNwsSource, NWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nws-api";
import { clopperPearson, quantile } from "@mark1russell7/rigor-statistics";
import { fetchTransport } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";
import { createIemSource, IEM_DESCRIPTOR } from "../src/index.ts";

/** A generic name: the requests carry no name of a person or a project. */
const USER_AGENT = "alerts-measure";
/** The largest count of misses in the results. */
const MOST_MISSES = 6;
/** The level of the upper bounds: the level of the limits of the delays. */
const LEVEL = DELAY_LIMITS.level;
/**
 * The largest share of the false ends in the true ends: the share of the copies after the limit of the delay. The rounding
 * removes the error of the subtraction of floats: 1 - 0.99 is not 0.01.
 */
const SHARE = Number((1 - DELAY_LIMITS.quantile).toPrecision(6));
const HOUR = 3_600_000;

/** One line of `records.jsonl`: one fetch of one source. */
interface MeasureRecord {
  readonly source: "iem" | "nws";
  readonly started: Instant;
  readonly at: Instant;
  readonly ok: boolean;
  readonly complete?: boolean;
  readonly failure?: string;
  /** The time of the data of a complete IEM list: the newest product time of the nation. */
  readonly asOf?: Instant;
  /** The ends of the observation ids of the live rows, each with its sent time. Only for IEM, the keys of `snapshotStep`. */
  readonly rowSents?: Readonly<Record<string, Instant>>;
  /** The VTEC events of the live reports, each with one UGC code (`<event>|<ugc>`) and the newest sent time of its reports. */
  readonly pairSents?: Readonly<Record<string, Instant>>;
  /** The keys of `rowSents`. The records before the sent times have only this field. */
  readonly rows?: readonly string[];
  /** The keys of `pairSents`. The records before the sent times have only this field. */
  readonly pairs?: readonly string[];
  /** The sent times of the live reports of each VTEC event. */
  readonly sents?: Readonly<Record<string, readonly Instant[]>>;
}

const option = (name: string): string | undefined => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = option("out") ?? "measure";
const from = option("from");
const minutes = Number(option("minutes") ?? "55");
if (!(minutes > 0)) throw new Error(`The length of the measure is ${String(minutes)} minutes, not a number above 0.`);
/** The count of complete lists after the start of an absence before it counts: 10 lists of IEM are 20 minutes. */
const horizon = Number(option("horizon") ?? "10");

/** This function tells if a report is live at a time, with the rules of `snapshotStep`. */
const live = (report: Report, at: Instant): boolean => report.status === "actual" && report.op !== "cancel" && !(report.expires !== undefined && report.expires <= at);

/** This function gives the keys `<event>|<ugc>` of a report. */
const pairsOf = (report: Report): string[] =>
  report.correlation.filter((key) => key.system === "vtec").flatMap((key) => report.areas.flatMap((area) => (area.type === "code" && area.system === "ugc" ? [`${key.id}|${area.code}`] : [])));

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
/** This function gives a record of times in the order of its keys. */
const ordered = (times: Readonly<Record<string, Instant>>): Record<string, Instant> => Object.fromEntries(Object.entries(times).sort(([a], [b]) => (a < b ? -1 : 1)));
/** This function keeps the newest time of a key. */
const newest = (times: Record<string, Instant>, key: string, time: Instant): void => {
  const known = times[key];
  if (known === undefined || time > known) times[key] = time;
};
/** This function gives the keys of a record of the times: `rows` and `pairs` come from the times when the record has them. */
const keyed = (record: MeasureRecord): MeasureRecord => ({
  ...record,
  ...(record.rowSents === undefined ? {} : { rows: sorted(Object.keys(record.rowSents)) }),
  ...(record.pairSents === undefined ? {} : { pairs: sorted(Object.keys(record.pairSents)) }),
});

/** This function fetches one source one time, and gives its record and its next cursor. */
async function fetchOne(name: "iem" | "nws", source: SourceProcedures, watch: Watch, cursor: Cursor | undefined): Promise<{ record: MeasureRecord; cursor?: Cursor }> {
  const started = Date.now();
  let outcome: FetchOutcome;
  try {
    outcome = await source.fetch({ watch, ...(cursor === undefined ? {} : { cursor }) });
  } catch (error) {
    return { record: { source: name, started, at: Date.now(), ok: false, failure: `thrown: ${String(error)}` } };
  }
  const at = Date.now();
  if (!outcome.ok) return { record: { source: name, started, at, ok: false, failure: outcome.failure.kind } };
  const rowSents: Record<string, Instant> = {};
  const pairSents: Record<string, Instant> = {};
  const sents = new Map<string, Set<Instant>>();
  for (const observation of outcome.observations) {
    const reports = source.map({ observation }).reports.filter((report) => live(report, at));
    for (const report of reports) {
      newest(rowSents, observation.id.slice(-16), report.sent);
      for (const pair of pairsOf(report)) newest(pairSents, pair, report.sent);
      for (const key of report.correlation) if (key.system === "vtec") sents.set(key.id, (sents.get(key.id) ?? new Set()).add(report.sent));
    }
  }
  const times = Object.fromEntries([...sents].sort(([a], [b]) => (a < b ? -1 : 1)).map(([event, set]) => [event, [...set].sort((a, b) => a - b)]));
  const iem = name === "iem" ? { ...(outcome.asOf === undefined ? {} : { asOf: outcome.asOf }), rowSents: ordered(rowSents) } : {};
  const record: MeasureRecord = { source: name, started, at, ok: true, complete: outcome.complete, ...iem, pairSents: ordered(pairSents), sents: times };
  return { record, ...(outcome.cursor === undefined ? {} : { cursor: outcome.cursor }) };
}

/** This function fetches the two sources for the length of the measure, and writes each record at once. */
async function measure(path: string): Promise<MeasureRecord[]> {
  const pace = { scheduler: new HostScheduler(realClock, 1), now: realClock.now };
  const transport = fetchTransport({ userAgent: USER_AGENT });
  // A place with no code gives the national query of each source.
  const watch: Watch = { places: [{ id: "place:national" as PlaceId, codes: [], bufferKm: 0 }] };
  const sides = [
    { name: "iem" as const, source: createIemSource({ pace, transport, userAgent: USER_AGENT }), interval: IEM_DESCRIPTOR.interval, next: 0, cursor: undefined as Cursor | undefined },
    { name: "nws" as const, source: createNwsSource({ pace, transport, userAgent: USER_AGENT }), interval: NWS_DESCRIPTOR.interval, next: 0, cursor: undefined as Cursor | undefined },
  ];
  const records: MeasureRecord[] = [];
  const end = Date.now() + minutes * 60_000;
  for (;;) {
    const side = sides.reduce((a, b) => (b.next < a.next ? b : a));
    const wait = side.next - Date.now();
    if (Date.now() + Math.max(0, wait) >= end) break;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    side.next = Date.now() + side.interval;
    const { record, cursor } = await fetchOne(side.name, side.source, watch, side.cursor);
    side.cursor = cursor;
    records.push(record);
    await appendFile(path, `${JSON.stringify(record)}\n`);
  }
  return records;
}

/** The results of the flaps of one kind of key. */
interface FlapResult {
  readonly misses: number;
  readonly flaps: number;
  /** The count of ends that did not come back: the true ends. */
  readonly ends: number;
  /** The count of runs of misses in the horizon at the end of a window. They do not count. */
  readonly censored: number;
  readonly trials: number;
  /** The upper bound of the rate of the false ends for each trial (a key at a list), at `LEVEL`. */
  readonly high: number;
  /** The count of observed lists where one or more false ends start. */
  readonly starts: number;
  /** The count of observed lists. */
  readonly lists: number;
  /** The upper bound of the rate of the lists where false ends start, at `LEVEL`. The decision reads this bound. */
  readonly highByList: number;
  /** The largest count of false ends that start at one list. */
  readonly largest: number;
  /** The upper bound of the lists in one day where false ends start. */
  readonly startsPerDay: number;
}

/** This function sums the flaps of the windows. Each window is one measure, so no absence goes over a gap. */
function flapResults(windows: readonly ListRuns[], hours: number): FlapResult[] {
  const results: FlapResult[] = [];
  const bound = (count: number, total: number): number => (total === 0 ? 1 : clopperPearson(count, total, LEVEL).high);
  const listsPerHour = hours > 0 ? windows.reduce((sum, runs) => sum + runs.lists, 0) / hours : Number.POSITIVE_INFINITY;
  for (let misses = 1; misses <= MOST_MISSES; misses += 1) {
    const counts = windows.map((runs) => flapCounts(runs)[misses - 1]!);
    const total = (pick: (count: FlapCount) => number): number => counts.reduce((sum, count) => sum + pick(count), 0);
    const starts = total((count) => count.starts);
    const lists = total((count) => count.lists);
    const highByList = bound(starts, lists);
    results.push({
      misses,
      flaps: total((count) => count.flaps),
      ends: total((count) => count.ends),
      censored: total((count) => count.censored),
      trials: total((count) => count.trials),
      high: bound(total((count) => count.flaps), total((count) => count.trials)),
      starts,
      lists,
      highByList,
      largest: Math.max(0, ...counts.map((count) => count.largest)),
      startsPerDay: highByList * listsPerHour * 24,
    });
  }
  return results;
}

/** This function gives the quantiles 0.1, 0.5 and 0.9 of a sample, in minutes. */
function minutesOf(values: readonly number[]): { count: number; q10?: number; q50?: number; q90?: number } {
  if (values.length === 0) return { count: 0 };
  const round = (value: number): number => Math.round((value / 60_000) * 10) / 10;
  return { count: values.length, q10: round(quantile(values, 0.1)), q50: round(quantile(values, 0.5)), q90: round(quantile(values, 0.9)) };
}

/** The comparison of the pairs of one window with the NWS API. */
interface Comparison {
  /** The delay of the first list of IEM with a new pair after the first list of the NWS API with it. */
  readonly delays: number[];
  readonly onlyIem: number;
  readonly onlyNws: number;
  /** The time from the end of a pair in IEM to its end in the NWS API. Below 0: the NWS API ended it first. */
  readonly endLags: number[];
  readonly endsNotInNws: number;
  readonly endsStillInNws: number;
  /** The IEM products (an event and a time) with the same time as an NWS API message of the event. */
  readonly ties: number;
  /** For each other IEM product: its time minus the nearest sent time of the event in the NWS API. */
  readonly skews: number[];
  /** The IEM products of an event that the NWS API did not list in the window. */
  readonly productsNotInNws: number;
}

function compare(iem: readonly MeasureRecord[], nws: readonly MeasureRecord[], iemPairs: ListRuns): Comparison {
  const completeOf = (records: readonly MeasureRecord[]) => records.filter((record) => record.ok && record.complete === true).sort((a, b) => a.at - b.at);
  const firstSeen = (records: readonly MeasureRecord[]): Map<string, Instant> => {
    const first = new Map<string, Instant>();
    const [start, ...rest] = records;
    const old = new Set(start?.pairs ?? []);
    for (const record of rest) for (const pair of record.pairs ?? []) if (!old.has(pair) && !first.has(pair)) first.set(pair, record.at);
    return first;
  };
  const iemLists = completeOf(iem);
  const nwsLists = completeOf(nws);
  const firstIem = firstSeen(iemLists);
  const firstNws = firstSeen(nwsLists);
  const delays: number[] = [];
  let onlyIem = 0;
  for (const [pair, time] of firstIem) {
    const other = firstNws.get(pair);
    if (other === undefined) onlyIem += 1;
    else delays.push(time - other);
  }
  const onlyNws = [...firstNws.keys()].filter((pair) => !firstIem.has(pair)).length;
  const endLags: number[] = [];
  let endsNotInNws = 0;
  let endsStillInNws = 0;
  // The true ends at 1 miss: the pairs that left IEM and did not come back in a newer list.
  for (const end of iemPairs.limits[0]!.ends) {
    if (end.back !== undefined) continue;
    const seen = nwsLists.filter((record) => record.pairs?.includes(end.key));
    if (seen.length === 0) {
      endsNotInNws += 1;
      continue;
    }
    // The first list of the NWS API without the pair, after its last list with the pair.
    const lastWith = seen.at(-1)!.at;
    const gone = nwsLists.find((record) => record.at > lastWith);
    if (gone === undefined) endsStillInNws += 1;
    else endLags.push(gone.at - end.left);
  }
  // The sent times of each event over the window, in each source.
  const timesOf = (records: readonly MeasureRecord[]): Map<string, Set<Instant>> => {
    const times = new Map<string, Set<Instant>>();
    for (const record of records) for (const [event, sents] of Object.entries(record.sents ?? {})) for (const sent of sents) times.set(event, (times.get(event) ?? new Set()).add(sent));
    return times;
  };
  const nwsTimes = timesOf(nwsLists);
  let ties = 0;
  let productsNotInNws = 0;
  const skews: number[] = [];
  for (const [event, sents] of timesOf(iemLists)) {
    const other = nwsTimes.get(event);
    for (const sent of sents) {
      if (other === undefined) productsNotInNws += 1;
      else if (other.has(sent)) ties += 1;
      else skews.push([...other].map((time) => sent - time).reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)));
    }
  }
  return { delays, onlyIem, onlyNws, endLags, endsNotInNws, endsStillInNws, ties, skews, productsNotInNws };
}

/** This function gives the count and the quantiles 0.1, 0.5 and 0.9 of a sample, in seconds. */
function secondsOf(values: readonly number[]): { count: number; q10?: number; q50?: number; q90?: number } {
  if (values.length === 0) return { count: 0 };
  return { count: values.length, q10: quantile(values, 0.1) / 1000, q50: quantile(values, 0.5) / 1000, q90: quantile(values, 0.9) / 1000 };
}

/** This function gives the windows of the records: one window for each file. */
async function windowsOf(): Promise<MeasureRecord[][]> {
  if (from === undefined) {
    await mkdir(out, { recursive: true });
    const path = join(out, "records.jsonl");
    await writeFile(path, "");
    return [(await measure(path)).map(keyed)];
  }
  const files = from.split(",").filter((file) => file !== "");
  return Promise.all(files.map(async (file) => (await readFile(file, "utf8")).split("\n").filter((line) => line !== "").map((line) => keyed(JSON.parse(line) as MeasureRecord))));
}

const windows = await windowsOf();
await mkdir(out, { recursive: true });
/** This function gives the IEM lists of a window. A list has its time and the sent time of each key when the records have them. */
const listsOf = (records: readonly MeasureRecord[], keys: (record: MeasureRecord) => readonly string[] | undefined, sents: (record: MeasureRecord) => MeasureRecord["rowSents"]): ListFetch[] =>
  records.flatMap((record): ListFetch[] => {
    if (record.source !== "iem") return [];
    if (!(record.ok && record.complete === true)) return [{ at: record.at }];
    const times = sents(record);
    return [{ at: record.at, keys: keys(record) ?? [], ...(record.asOf === undefined ? {} : { asOf: record.asOf }), ...(times === undefined ? {} : { sents: times }) }];
  });
const rowRuns = windows.map((records) => listRuns(listsOf(records, (record) => record.rows, (record) => record.rowSents), horizon, MOST_MISSES));
const pairRuns = windows.map((records) => listRuns(listsOf(records, (record) => record.pairs, (record) => record.pairSents), horizon, MOST_MISSES));
const hours = windows.reduce((sum, records) => {
  const times = records.map((record) => record.at);
  return sum + (times.length < 2 ? 0 : (Math.max(...times) - Math.min(...times)) / HOUR);
}, 0);
const comparisons = windows.map((records, index) => compare(records.filter((record) => record.source === "iem"), records.filter((record) => record.source === "nws"), pairRuns[index]!));
const fetches = (source: "iem" | "nws") => {
  const records = windows.flat().filter((record) => record.source === source);
  const failures: Record<string, number> = {};
  for (const record of records) if (!record.ok) failures[record.failure ?? "unknown"] = (failures[record.failure ?? "unknown"] ?? 0) + 1;
  return { fetches: records.length, complete: records.filter((record) => record.ok && record.complete === true).length, failures };
};
/** This function sums one count of the runs of the windows. */
const runsSum = (runs: readonly ListRuns[], pick: (one: ListRuns) => number): number => runs.reduce((total, one) => total + pick(one), 0);
/** This function gives the old lists and the trials with no miss because the key is newer than its list. */
const oldOf = (runs: readonly ListRuns[]) => ({ lists: runsSum(runs, (one) => one.lists), old: runsSum(runs, (one) => one.old), held: runsSum(runs, (one) => one.held) });
const sum = (pick: (comparison: Comparison) => number): number => comparisons.reduce((total, comparison) => total + pick(comparison), 0);
const summary = {
  windows: windows.length,
  hours: Math.round(hours * 100) / 100,
  level: LEVEL,
  horizon,
  iem: fetches("iem"),
  nws: fetches("nws"),
  rows: { flaps: flapResults(rowRuns, hours), ...oldOf(rowRuns) },
  share: SHARE,
  pairs: { flaps: flapResults(pairRuns, hours), ...oldOf(pairRuns) },
  start: { delay: minutesOf(comparisons.flatMap((comparison) => comparison.delays)), onlyIem: sum((c) => c.onlyIem), onlyNws: sum((c) => c.onlyNws) },
  end: { lag: minutesOf(comparisons.flatMap((comparison) => comparison.endLags)), notInNws: sum((c) => c.endsNotInNws), stillInNws: sum((c) => c.endsStillInNws) },
  tie: {
    ties: sum((c) => c.ties),
    later: secondsOf(comparisons.flatMap((comparison) => comparison.skews.filter((skew) => skew > 0))),
    earlier: secondsOf(comparisons.flatMap((comparison) => comparison.skews.filter((skew) => skew < 0))),
    notInNws: sum((c) => c.productsNotInNws),
  },
};

// The decision reads the fewest true ends of the counts of misses. Fewer true ends are on the safe side.
const trueEnds = Math.min(...summary.rows.flaps.map((result) => result.ends));
const decision = missesDecision(summary.rows.flaps, trueEnds, SHARE);
const decisionText = decision.decided
  ? `The count of misses is ${String(decision.misses)}. Its false ends are ${decision.share.toExponential(2)} or less of the true ends of the rows, at ${String(LEVEL)}.`
  : `No decision. ${decision.reason}`;

const table = (results: readonly FlapResult[]): string =>
  [
    "| Count of misses | False ends | True ends | Runs in the horizon | Trials | Bound by key | Lists with a start | Observed lists | Bound by list | Most keys of one start | Bound of the lists with a start in a day |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map((result) => `| ${String(result.misses)} | ${String(result.flaps)} | ${String(result.ends)} | ${String(result.censored)} | ${String(result.trials)} | ${result.high.toExponential(2)} | ${String(result.starts)} | ${String(result.lists)} | ${result.highByList.toExponential(2)} | ${String(result.largest)} | ${result.startsPerDay.toFixed(2)} |`),
  ].join("\n");
const markdown = [
  from === undefined ? `# The measure of the IEM list` : `# All the measures of the IEM list`,
  "",
  `${String(summary.windows)} window(s), ${String(summary.hours)} hours. IEM: ${String(summary.iem.complete)} complete lists of ${String(summary.iem.fetches)} fetches. NWS API: ${String(summary.nws.complete)} complete lists of ${String(summary.nws.fetches)} fetches.`,
  "",
  `A false end is a key that ends at the count of misses and comes back, with the rules of \`snapshotStep\`. A key that is newer than an old list counts no miss, and an ended key comes back only in a newer list. An end counts only when ${String(summary.horizon)} complete lists follow the start of its misses. The bounds are Clopper-Pearson bounds at ${String(LEVEL)}. One bad list can end many keys at once, so the decision reads the bound by list.`,
  "",
  `## The decision of \`SNAPSHOT_MISSES\``,
  "",
  `The decision is the smallest count of misses whose false ends are ${String(SHARE)} or less of the true ends of the rows.`,
  "",
  decisionText,
  "",
  `## The rows (the keys of \`snapshotStep\`)`,
  "",
  table(summary.rows.flaps),
  "",
  `The decision reads ${String(trueEnds)} true ends: the fewest of the counts of misses. Old lists: ${String(summary.rows.old)} of ${String(summary.rows.lists)} complete lists have a time before an earlier list. Trials with no miss, because the row is newer than its list: ${String(summary.rows.held)}. The records before the times of the lists count with no times.`,
  "",
  `## The events by UGC code (the liveness of an incident)`,
  "",
  table(summary.pairs.flaps),
  "",
  `## IEM against the NWS API`,
  "",
  `- The delay of a new event and code in IEM after the NWS API, in minutes: ${JSON.stringify(summary.start.delay)}. Only in IEM: ${String(summary.start.onlyIem)}. Only in the NWS API: ${String(summary.start.onlyNws)}.`,
  `- The time from the end in IEM to the end in the NWS API, in minutes: ${JSON.stringify(summary.end.lag)}. Ends that the NWS API did not have: ${String(summary.end.notInNws)}. Ends that the NWS API still had at the end of the window: ${String(summary.end.stillInNws)}.`,
  "",
  `## The tie of the sent time of one product`,
  "",
  `An IEM product is an event and the time of a product of the event. A later IEM time lets the IEM rows replace the NWS API copy, and then a false end of the rows ends the incident.`,
  "",
  `- The same time as an NWS API message of the event: ${String(summary.tie.ties)}.`,
  `- Later than the nearest NWS API time, in seconds: ${JSON.stringify(summary.tie.later)}.`,
  `- Earlier than the nearest NWS API time, in seconds: ${JSON.stringify(summary.tie.earlier)}.`,
  `- Events that the NWS API did not list in the window: ${String(summary.tie.notInNws)}.`,
  "",
].join("\n");
await writeFile(join(out, "summary.json"), `${JSON.stringify({ ...summary, decision }, null, 2)}\n`);
await writeFile(join(out, "summary.md"), markdown);
if (process.env["GITHUB_STEP_SUMMARY"] !== undefined) await appendFile(process.env["GITHUB_STEP_SUMMARY"], markdown);
console.log(markdown);
