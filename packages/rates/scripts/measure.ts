/**
 * The measure of the base rates, for the workflow `rates.yml`. The script fetches the public data of
 * the whole country through polite-crawler, one request at a time for each host:
 *
 * - IEM Cow: the warnings of each month, with the verified ones.
 * - NCEI Storm Events: one file of details for each year, as a stream. The script keeps only the sums of each type.
 *
 * The requests name no office and no state. The script examines robots.txt of each host first. It
 * writes `rates.json` and `summary.md` in the folder of `--out`. With `--check`, it compares each
 * value with the gate interval of the committed file. A value out of its interval gives the exit
 * code 1. A value that the gate cannot read gives a warning annotation of the workflow, and no failure.
 *
 * Start: `node scripts/measure.ts --out=<folder> [--check=data/rates.json] [--cow-years=2021-2025] [--ncei-years=2016-2025]`
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceId } from "@mark1russell7/alerts";
import { createRequester, type Requester } from "@mark1russell7/alerts-fetch";
import { fetchTransport, send, type FetchLike, type Transport } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";
import { decide, robotsFromResponse } from "polite-crawler/robots";
import {
  checkRates,
  COW_URL,
  COW_YEARS,
  cowQuery,
  cowSettings,
  cowWindows,
  detailsFiles,
  measureYears,
  NCEI_FOLDER_URL,
  NCEI_YEARS,
  parseYears,
  RATES_FORMAT,
  ratesFile,
  ratesSummary,
  readCow,
  splitWindow,
  sumDetails,
  tallyCow,
  type CowWarning,
  type CowWindow,
  type DetailsFile,
  type GateResult,
  type RatesFile,
  type YearHarm,
  type Years,
} from "../src/index.ts";

/** The User-Agent of each request. It names no person and no project. */
const USER_AGENT = "alerts-measure";
/** The shortest time between two requests to one host. Cow computes each answer, so the pace is slow. */
const MIN_INTERVAL_MS = 5000;
/** The time limit of one Cow request. A request that ends at the limit goes again as two halves. */
const COW_TIMEOUT_MS = 300_000;
/** The time limit of the download of one NCEI file. */
const NCEI_TIMEOUT_MS = 600_000;
/** The count of tries of one request before the script cuts its window or stops. */
const TRIES = 3;

const option = (name: string): string | undefined => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = option("out");
if (out === undefined) throw new Error("Give the folder of the results: --out=<folder>.");
const check = option("check");

const pace = { scheduler: new HostScheduler(realClock, 1), now: realClock.now };
const started = realClock.now();
const cowYears: Years = option("cow-years") === undefined ? measureYears(started, COW_YEARS) : parseYears(option("cow-years") as string);
const nceiYears: Years = option("ncei-years") === undefined ? measureYears(started, NCEI_YEARS) : parseYears(option("ncei-years") as string);
const log = (text: string): void => console.log(`${new Date(realClock.now()).toISOString()} ${text}`);

/** This function makes a requester of one host, at the pace of its robots.txt. */
function requester(source: string, baseUrl: string, minIntervalMs: number, timeoutMs: number, transport: Transport): Requester {
  return createRequester({ source: source as SourceId, pace, transport, baseUrl, headers: {}, minIntervalMs, timeoutMs });
}

/**
 * This function reads robots.txt of the host of a URL. It throws an error when robots.txt does not
 * permit the path of the URL. It gives the time between two requests: the longer of the pace of the
 * script and the crawl delay of robots.txt.
 */
async function allow(url: string): Promise<number> {
  const { origin, host, pathname } = new URL(url);
  const transport = fetchTransport({ userAgent: USER_AGENT });
  const answer = await send(pace, transport, { source: "robots", host, minIntervalMs: MIN_INTERVAL_MS, what: "robots.txt", exchange: { method: "GET", url: `${origin}/robots.txt`, headers: {}, body: null } });
  const robots = robotsFromResponse(answer.reply.status, answer.reply.headers["content-type"], answer.reply.body);
  const decision = decide(robots, [USER_AGENT], pathname);
  if (!decision.allowed) throw new Error(`robots.txt of ${host} does not permit ${pathname}.`);
  const intervalMs = Math.max(MIN_INTERVAL_MS, (decision.crawlDelaySeconds ?? 0) * 1000);
  log(`robots.txt of ${host} permits ${pathname}, with ${String(intervalMs / 1000)} s between requests`);
  return intervalMs;
}

/** This function gives a window in the form of a message, for example `2024-05-01 to 2024-06-01`. */
const windowText = ({ start, end }: CowWindow): string => `${new Date(start).toISOString().slice(0, 10)} to ${new Date(end).toISOString().slice(0, 10)}`;

/** The Cow measure: the warnings of each window, the queries and the settings of Cow. */
async function measureCow(): Promise<{ warnings: CowWarning[]; queries: string[]; params: Record<string, unknown> }> {
  const intervalMs = await allow(COW_URL);
  const cow = requester("iem-cow", COW_URL, intervalMs, COW_TIMEOUT_MS, fetchTransport({ userAgent: USER_AGENT, timeoutMs: COW_TIMEOUT_MS }));
  const warnings: CowWarning[] = [];
  const queries: string[] = [];
  let settings: string | undefined;
  let params: Record<string, unknown> = {};
  const take = async (window: CowWindow): Promise<void> => {
    const query = cowQuery(window);
    for (let attempt = 1; attempt <= TRIES; attempt += 1) {
      const result = await cow.get({ path: query, what: `the warnings of ${windowText(window)}` });
      if (result.ok) {
        const read = readCow(result.answer.reply.body, window);
        const these = JSON.stringify(cowSettings(read.params));
        if (settings === undefined) [settings, params] = [these, cowSettings(read.params)];
        else if (these !== settings) throw new Error(`Cow used different settings for ${windowText(window)}: ${these}, not ${settings}.`);
        warnings.push(...read.warnings);
        queries.push(query);
        log(`cow ${windowText(window)}: ${String(read.total)} events, ${String(read.warnings.length)} warnings in the window, ${String(Math.round(result.latency / 1000))} s`);
        return;
      }
      log(`cow ${windowText(window)}: try ${String(attempt)} failed: ${result.failure.kind}: ${result.failure.message}`);
      if (result.failure.kind === "timeout") break;
    }
    const halves = splitWindow(window);
    if (halves === undefined) throw new Error(`Cow gave no answer for ${windowText(window)}.`);
    log(`cow ${windowText(window)}: the script asks for two halves`);
    for (const half of halves) await take(half);
  };
  for (const window of cowWindows(cowYears.first, cowYears.last)) await take(window);
  if (!Array.isArray(params["wfo"]) || params["wfo"].length > 0) throw new Error(`Cow did not use all the offices: wfo is ${JSON.stringify(params["wfo"])}.`);
  return { warnings, queries, params };
}

/**
 * This function makes the fetch of one NCEI file. The body goes as a stream through the gzip
 * decoder to the sums, so the script does not keep the file. The text of the body is the count of rows.
 */
function streamingFetch(year: number, result: { harm?: YearHarm }): FetchLike {
  return async (url, init) => {
    const response = await globalThis.fetch(url, init);
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      async text(): Promise<string> {
        if (!response.ok || response.body === null) return await response.text();
        // The server sends the .gz file as data. Only a Content-Encoding makes fetch decode it.
        const gzip = /gzip/i.test(response.headers.get("content-encoding") ?? "") ? response.body : response.body.pipeThrough(new DecompressionStream("gzip"));
        const harm = await sumDetails(gzip.pipeThrough(new TextDecoderStream()), year);
        result.harm = harm;
        return String(harm.rows);
      },
    };
  };
}

/** The NCEI measure: the sums of each year, from the latest file of each year. */
async function measureNcei(): Promise<{ files: DetailsFile[]; harms: YearHarm[] }> {
  const intervalMs = await allow(NCEI_FOLDER_URL);
  const folder = requester("ncei", NCEI_FOLDER_URL, intervalMs, NCEI_TIMEOUT_MS, fetchTransport({ userAgent: USER_AGENT }));
  const listed = await folder.get({ path: "/", what: "the list of the Storm Events files" });
  if (!listed.ok) throw new Error(`NCEI did not give the list of files: ${listed.failure.kind}: ${listed.failure.message}`);
  const all = detailsFiles(listed.answer.reply.body);
  const files: DetailsFile[] = [];
  for (let year = nceiYears.first; year <= nceiYears.last; year += 1) {
    const file = all.find((item) => item.year === year);
    if (file === undefined) throw new Error(`The NCEI folder has no file of details of ${String(year)}.`);
    files.push(file);
  }
  const harms: YearHarm[] = [];
  for (const file of files) {
    const result: { harm?: YearHarm } = {};
    const download = requester("ncei", NCEI_FOLDER_URL, intervalMs, NCEI_TIMEOUT_MS, fetchTransport({ userAgent: USER_AGENT, timeoutMs: NCEI_TIMEOUT_MS, fetch: streamingFetch(file.year, result) }));
    for (let attempt = 1; attempt <= TRIES && result.harm === undefined; attempt += 1) {
      const answer = await download.get({ path: `/${file.name}`, what: `the events of ${String(file.year)}` });
      if (!answer.ok) log(`ncei ${file.name}: try ${String(attempt)} failed: ${answer.failure.kind}: ${answer.failure.message}`);
    }
    if (result.harm === undefined) throw new Error(`NCEI did not give ${file.name}.`);
    harms.push(result.harm);
    log(`ncei ${file.name}: ${String(result.harm.rows)} rows, ${String(Object.keys(result.harm.types).length)} types, ${String(result.harm.months.length)} months`);
  }
  return { files, harms };
}

/** This function reads the committed file. It gives undefined when there is no file. */
async function committedFile(path: string): Promise<RatesFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const file = JSON.parse(text) as RatesFile;
  if (file.format !== RATES_FORMAT) throw new Error(`The committed file has the format ${JSON.stringify(file.format)}, not ${RATES_FORMAT}.`);
  return file;
}

log(`the measure starts: Cow ${String(cowYears.first)} to ${String(cowYears.last)}, NCEI ${String(nceiYears.first)} to ${String(nceiYears.last)}`);
const cow = await measureCow();
const ncei = await measureNcei();
const file = ratesFile({
  fetched: started,
  cow: { years: cowYears, params: cow.params, queries: cow.queries, tally: tallyCow(cow.warnings) },
  ncei: { years: nceiYears, files: ncei.files, harms: ncei.harms },
});
const committed = check === undefined ? undefined : await committedFile(check);
const gate: GateResult = committed === undefined ? { committed: false } : { committed: true, ...checkRates(committed, file) };
const summary = ratesSummary(file, gate);
await mkdir(out, { recursive: true });
await writeFile(join(out, "rates.json"), `${JSON.stringify(file, null, 2)}\n`);
await writeFile(join(out, "summary.md"), summary);
const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
if (stepSummary !== undefined && stepSummary !== "") await appendFile(stepSummary, summary);
console.log(summary);
/** This function escapes the text of a workflow command, as the runner of GitHub reads it. */
const command = (text: string): string => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
// A no read is a warning on the check line of the run, not only a line of the log. A no read is not a pass.
if (gate.committed) for (const item of gate.noReads) console.log(`::warning title=No read of the gate::${command(`${item.path}: ${item.reason}`)}`);
if (gate.committed && gate.breaks.length > 0) {
  for (const item of gate.breaks) console.error(`The value ${String(item.value)} of ${item.path} is out of its gate interval ${String(item.gate[0])} to ${String(item.gate[1])}.`);
  process.exitCode = 1;
}
