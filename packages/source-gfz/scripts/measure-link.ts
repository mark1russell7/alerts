/**
 * This script measures the link window of the geomagnetic storms (AL-14). The merge rule 3 joins a report of GFZ and
 * a storm report of the SWPC when their onsets are in the window. The script replays the storms of many years at each
 * window. It counts the runs of GFZ that join the SWPC, and the incidents that join two runs of GFZ.
 *
 * The inputs are files of the past, in the folder `--from`:
 *
 * - The monthly archive files of the SWPC, `alerts_YYYYMM.html`, from `ftp://ftp.swpc.noaa.gov/pub/alerts/`.
 * - One answer of GFZ, `gfz-kp-<name>.json`, for example from
 *   `https://kp.gfz.de/app/json/?start=2015-01-01T00:00:00Z&end=2025-12-31T23:59:59Z&index=Kp&status=def`.
 *
 * The SWPC uses its serial numbers again, so one key can come back after months. The runtime drops an incident 7 days
 * after its last change. Thus the replay gives a new key to a key or a watch id that comes back more than 8 days later.
 * Each year is one replay. The script prints counts and times only.
 *
 * Start it in the folder of the package: `node scripts/measure-link.ts --from=<folder>`. The option
 * `--windows=3,6,9` sets the windows in hours.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LINK_POLICY, hasKind, incidents, linkRule, normalize, observationId, type Instant, type LinkPolicy, type Report } from "@mark1russell7/alerts";
import { entryBody, mapObservation as mapSwpc, messageTime, SOURCE_ID as SWPC, WATCH_SYSTEM } from "@mark1russell7/alerts-source-swpc";
import { GEOMAGNETIC_STORM_KIND } from "@mark1russell7/alerts-space-weather";
import { INTERVAL_MS, mapObservation, readAnswer, RUN_SYSTEM, SOURCE_ID as GFZ } from "../src/index.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A key that comes back after this gap is a new key: the runtime drops an incident 7 days after its last change. */
const GENERATION_GAP_MS = 8 * DAY;
const DEFAULT_WINDOWS = [2, 3, 4, 5, 6, 7, 8, 9, 12];
/** The script lists the runs that do not join the SWPC at a window when they are this many or fewer. */
const LISTED_MISSES = 12;
/** The time of the merge. It is after each storm of the inputs. */
const AT = Date.UTC(2100, 0, 1);

interface Options {
  readonly from: string;
  readonly windows: readonly number[];
}

function parseOptions(argv: readonly string[]): Options {
  let from: string | undefined;
  let windows = DEFAULT_WINDOWS;
  for (const arg of argv) {
    const [name, value = ""] = arg.split("=", 2) as [string, string?];
    if (name === "--from") from = value;
    else if (name === "--windows") windows = value.split(",").map(Number);
    else throw new Error(`the option ${name} is not known: use --from=<folder> and --windows=<hours,...>`);
  }
  if (from === undefined || from === "") throw new Error("the option --from=<folder> is necessary");
  if (windows.length === 0 || windows.some((hours) => !Number.isFinite(hours) || hours <= 0)) throw new Error("each window of --windows must be a number of hours above 0");
  return { from, windows };
}

/** The reports of the archive files of the SWPC, and the count of the messages and of the messages with a fatal problem. */
function readSwpc(folder: string): { readonly reports: Report[]; readonly messages: number; readonly fatal: number } {
  const reports: Report[] = [];
  let messages = 0;
  let fatal = 0;
  const url = "ftp://ftp.swpc.noaa.gov/pub/alerts/";
  for (const file of readdirSync(folder).filter((name) => /^alerts_\d{6}\.html$/.test(name)).sort()) {
    for (const block of readFileSync(join(folder, file), "utf8").split(/<hr>/i).slice(1)) {
      // The rule of the fixtures of the SWPC source: each tag with its line break becomes one line break.
      const message = block.replace(/<[^>]+>\n?/g, "\n").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
      const issued = messageTime(/Issue Time: ([^\n]+)\n/.exec(message)?.[1] ?? "");
      if (issued === undefined) continue;
      // The archive has no list, so the issue time of the list is the issue time of the text.
      const body = entryBody({ product_id: "", issue_datetime: new Date(issued).toISOString().replace("T", " ").replace("Z", ""), message });
      const result = mapSwpc({ id: observationId({ source: SWPC, contentType: "application/json", url, body }), source: SWPC, fetched: issued, contentType: "application/json", body, transport: { url, latency: 0 } });
      messages += 1;
      if (result.problems.some((problem) => problem.fatal === true)) fatal += 1;
      reports.push(...result.reports);
    }
  }
  return { reports, messages, fatal };
}

/** The reports of the answer of GFZ. The script reads the answer at the start of its first interval, so each interval of G1 or more gives a report. */
function readGfz(folder: string): Report[] {
  const file = readdirSync(folder).find((name) => /^gfz-kp-.*\.json$/.test(name));
  if (file === undefined) throw new Error(`the folder ${folder} has no file gfz-kp-<name>.json`);
  const body = readFileSync(join(folder, file), "utf8");
  const first = Date.parse((JSON.parse(body) as { readonly datetime?: readonly string[] }).datetime?.[0] ?? "");
  const url = "https://kp.gfz.de/app/json/";
  const read = readAnswer({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body }, url, url, first, 0);
  if (read?.complete !== true) throw new Error(`the file ${file} is not a whole answer of GFZ`);
  return read.observations.flatMap((observation) => mapObservation(observation).reports);
}

/** This function gives the generation of a name at a time: a name that comes back more than `GENERATION_GAP_MS` later gets the next number. */
function generations(uses: ReadonlyMap<string, readonly Instant[]>): (name: string, at: Instant) => string {
  const starts = new Map<string, Instant[]>();
  for (const [name, times] of uses) {
    const sorted = [...new Set(times)].sort((a, b) => a - b);
    const list: Instant[] = [];
    sorted.forEach((time, index) => {
      if (index === 0 || time - sorted[index - 1]! > GENERATION_GAP_MS) list.push(time);
    });
    starts.set(name, list);
  }
  return (name, at) => {
    const list = starts.get(name) ?? [];
    const index = list.filter((start) => start <= at).length - 1;
    return index <= 0 ? name : `${name}#${String(index)}`;
  };
}

/** The storm reports of the SWPC with the retention of the runtime: each key, reference and watch id gets its generation. */
function retained(reports: readonly Report[]): Report[] {
  const keys = new Map<string, Instant[]>();
  const watches = new Map<string, Instant[]>();
  for (const report of reports) {
    keys.set(report.key, [...(keys.get(report.key) ?? []), report.sent]);
    for (const one of report.correlation) if (one.system === WATCH_SYSTEM) watches.set(one.id, [...(watches.get(one.id) ?? []), report.sent]);
  }
  const key = generations(keys);
  const watch = generations(watches);
  return reports.map((report) => ({
    ...report,
    key: key(report.key, report.sent),
    references: report.references.map((reference) => key(reference, report.sent)),
    correlation: report.correlation.map((one) => (one.system === WATCH_SYSTEM ? { ...one, id: watch(one.id, report.sent) } : one)),
  }));
}

/** The keys of the SWPC with two or more sent times, and the gaps between the sent times. A watch is out: its key has the day. */
function reuse(reports: readonly Report[]): { readonly keys: number; readonly reused: number; readonly gaps: readonly number[] } {
  const sents = new Map<string, Set<Instant>>();
  for (const report of reports) if (!report.key.startsWith("WAT")) sents.set(report.key, (sents.get(report.key) ?? new Set()).add(report.sent));
  const gaps: number[] = [];
  let reused = 0;
  for (const times of sents.values()) {
    const sorted = [...times].sort((a, b) => a - b);
    if (sorted.length > 1) reused += 1;
    for (let index = 1; index < sorted.length; index += 1) gaps.push(sorted[index]! - sorted[index - 1]!);
  }
  return { keys: sents.size, reused, gaps };
}

const withWindow = (hours: number): LinkPolicy => ({
  families: DEFAULT_LINK_POLICY.families.map((family) => (family.family === GEOMAGNETIC_STORM_KIND ? { ...family, windowMs: hours * HOUR } : family)),
});
const yearOf = (report: Report): number => new Date(report.onset ?? report.sent).getUTCFullYear();
const runOf = (report: Report): string => report.correlation.find((one) => one.system === RUN_SYSTEM)?.id ?? "";
const hoursText = (ms: number): string => String(Math.round((ms / HOUR) * 10) / 10);

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const swpc = readSwpc(options.from);
  const gfz = readGfz(options.from);
  const storms = retained(swpc.reports.filter((report) => hasKind([GEOMAGNETIC_STORM_KIND], report.kind.code)));
  const runs = new Map<string, { start: Instant; end: Instant }>();
  for (const report of gfz) {
    const run = runs.get(runOf(report)) ?? { start: Infinity, end: -Infinity };
    runs.set(runOf(report), { start: Math.min(run.start, report.onset ?? Infinity), end: Math.max(run.end, (report.onset ?? -Infinity) + INTERVAL_MS) });
  }
  const years = [...new Set(gfz.map(yearOf))].sort((a, b) => a - b);
  console.log(`SWPC: ${String(swpc.messages)} messages (${String(swpc.fatal)} with a fatal problem), ${String(swpc.reports.length)} reports, ${String(storms.length)} of a geomagnetic storm. GFZ: ${String(gfz.length)} reports, ${String(runs.size)} runs, years ${String(years[0])} to ${String(years.at(-1))}.`);

  const keys = reuse(swpc.reports);
  const count = (low: number, high: number): number => keys.gaps.filter((gap) => gap > low && gap <= high).length;
  console.log(`SWPC keys with two or more sent times: ${String(keys.reused)} of ${String(keys.keys)}. Gaps: up to 1 day ${String(count(0, DAY))}, 1 to 8 days ${String(count(DAY, GENERATION_GAP_MS))}, above 8 days ${String(count(GENERATION_GAP_MS, Infinity))}.`);

  for (const hours of options.windows) {
    const link = linkRule(withWindow(hours));
    const joined = new Set<string>();
    const gaps: number[] = [];
    let found = 0;
    for (const year of years) {
      const reports = [...gfz.filter((report) => yearOf(report) === year), ...storms.filter((report) => yearOf(report) === year)];
      const byId = new Map(reports.map((report) => [report.id, report]));
      for (const incident of incidents(normalize({ reports }), AT, { link })) {
        found += 1;
        const members = incident.reports.flatMap((id) => byId.get(id) ?? []);
        const inside = [...new Set(members.filter((report) => report.source === GFZ).map(runOf))].sort((a, b) => runs.get(a)!.start - runs.get(b)!.start);
        if (members.some((report) => report.source === SWPC)) for (const run of inside) joined.add(run);
        for (let index = 1; index < inside.length; index += 1) gaps.push(runs.get(inside[index]!)!.start - runs.get(inside[index - 1]!)!.end);
      }
    }
    const atLeast = (limit: number): number => gaps.filter((gap) => gap >= limit).length;
    const misses = [...runs.keys()].filter((run) => !joined.has(run)).sort();
    const listed = misses.length > 0 && misses.length <= LISTED_MISSES ? ` Runs apart: ${misses.join(" ")}.` : "";
    console.log(
      `window ${String(hours)} h: runs of GFZ that join the SWPC ${String(joined.size)} of ${String(runs.size)}, incidents ${String(found)}, pairs of runs in one incident ${String(gaps.length)} (gap under 12 h ${String(gaps.length - atLeast(12 * HOUR))}, 12 to 24 h ${String(atLeast(12 * HOUR) - atLeast(DAY))}, 24 h or more ${String(atLeast(DAY))}, largest ${hoursText(Math.max(0, ...gaps))} h).${listed}`,
    );
  }
}

main();
