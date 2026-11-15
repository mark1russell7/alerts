/**
 * This script measures the sent times of the IPAWS copies of the WEA messages of the NWS (AL-8). The core
 * finds the copy of a message only at the same sent time, to the millisecond. A message with copies in its
 * incident, but no copy at its sent time, gives a false miss. The class `shifted` counts the messages with
 * the copy with their id in the incident. The class `lost` counts the other messages. The sum of the two counts must be 0.
 *
 * The two sources keep their history, so the measure reads a range of the past:
 *
 * - The NWS API gives the actual messages with the WEA event codes (`/alerts?start=&end=`). It keeps 7 days.
 * - The OpenFEMA dataset `IpawsArchivedAlerts` gives the IPAWS copies with the original CAP text. The query
 *   asks only for the messages of the NWS sender, and the script keeps only these.
 *
 * The requests name no state and no place. The script maps each body with the map of its source, and
 * gives the reports to `sentMeasure`. It writes the bodies, one line for each request, the checks and the
 * summary to the folder `--out`. It ends with the code 1 when a request fails, or when the sum of `shifted`
 * and `lost` is above 0 (`sentFails`).
 *
 * Start it in the folder of the package: `node scripts/measure.ts --out=measure`, with the options
 * `--start=<ISO time>` and `--end=<ISO time>`. The option `--from=<folder>` reads the bodies of an earlier measure.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { observationId, type Instant, type Observation, type Report, type SourceId } from "@mark1russell7/alerts";
import { createRequester, type Requester } from "@mark1russell7/alerts-fetch";
import { WEA_EVENT_CODES } from "@mark1russell7/alerts-format-nws";
import { mapObservation as mapApi, NWS_BASE_URL, SOURCE_ID as API } from "@mark1russell7/alerts-source-nws-api";
import { fetchTransport } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";
import { mapObservation as mapIpaws, NWS_SENDER, SOURCE_ID as IPAWS, sentFails, sentMeasure, type SentGap } from "../src/index.ts";

/** A generic name: the requests carry no name of a person or a project. */
const USER_AGENT = "alerts-measure";
const HOUR = 3_600_000;
/** The default length of the range: 6.5 days, inside the 7 days of history of the NWS API. */
const DEFAULT_RANGE_MS = 156 * HOUR;
/** The history of the NWS API. A range that starts earlier has no messages in its first part. */
const NWS_HISTORY_MS = 168 * HOUR;
/** The archive query starts this time before the range, and ends this time after it, so it holds a copy with a different sent time. */
const COPY_MARGIN_MS = HOUR;
/**
 * The archive can get a copy after the refresh of the data. Thus a message in this time before the refresh is
 * censored when no copy has its sent time. The daily run measures it again on the next day.
 */
const CENSOR_MS = 6 * HOUR;
/** The largest count of messages in one page of the NWS API. */
const NWS_PAGE = 500;
/** The largest count of pages of one query. A larger count stops the measure as a failure. */
const MOST_PAGES = 100;
/** The largest count of rows in one page of the archive. */
const ARCHIVE_PAGE = 1000;
const OPENFEMA_BASE_URL = "https://www.fema.gov/api/open/v1";
const ARCHIVE = "IpawsArchivedAlerts";
/** The tries of one request, and the wait between two tries. */
const TRIES = 3;
const RETRY_WAIT_MS = 30_000;

/** One line of `fetches.jsonl`: one request. */
interface FetchRecord {
  readonly source: "nws-api" | "ipaws-archive" | "openfema-datasets";
  readonly path: string;
  readonly at: Instant;
  readonly ok: boolean;
  readonly count?: number;
  readonly latency?: number;
  readonly failure?: string;
}

/** One line of `nws-api.jsonl`: one message of the NWS API, as the API gives it. */
interface NwsLine {
  readonly fetched: Instant;
  readonly url: string;
  readonly feature: unknown;
}

/** One line of `ipaws.jsonl`: one row of the archive of the NWS sender, with the original CAP text. */
interface ArchiveLine {
  readonly fetched: Instant;
  readonly url: string;
  readonly row: { readonly id: string; readonly identifier: string; readonly sender: string; readonly sent: string; readonly originalMessage: string };
}

/** The facts of one measure: `meta.json`. */
interface Meta {
  readonly start: Instant;
  readonly end: Instant;
  readonly fetchedAt: Instant;
  /** The time of the last refresh of the archive, from the OpenFEMA dataset list. */
  readonly refreshed?: Instant;
  readonly censorAfter: Instant;
  /** The requests that failed. The measure is not complete. */
  readonly failures: readonly string[];
  /** The facts that do not stop the measure, for example a missing refresh time. */
  readonly notes: readonly string[];
}

const option = (name: string): string | undefined => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = option("out") ?? "measure";
const from = option("from");
const iso = (time: Instant): string => new Date(time).toISOString();

/** This function reads a time option. An empty value gives the default. */
function timeOption(name: string, fallback: Instant): Instant {
  const text = option(name);
  if (text === undefined || text.trim() === "") return fallback;
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Error(`The option --${name}=${text} is not an ISO time.`);
  return time;
}

/** This function sends one request with three tries, and writes its record. It gives the body, or `undefined` after the last failure. */
async function request(requester: Requester, source: FetchRecord["source"], path: string, records: FetchRecord[], count: (body: string) => number): Promise<string | undefined> {
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    const requested = await requester.get({ path, what: `the history ${source}` });
    const at = Date.now();
    if (requested.ok) {
      const body = requested.answer.reply.body;
      let size: number;
      try {
        size = count(body);
      } catch (error) {
        records.push({ source, path, at, ok: false, failure: `the body does not parse: ${String(error)}` });
        if (attempt < TRIES) await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
        continue;
      }
      records.push({ source, path, at, ok: true, count: size, latency: requested.latency });
      return body;
    }
    records.push({ source, path, at, ok: false, failure: `${requested.failure.kind}: ${requested.failure.message}` });
    if (attempt < TRIES) await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
  }
  return undefined;
}

/** This function fetches the range from the two sources, and writes the bodies and the records to the folder. */
async function fetchRange(folder: string, start: Instant, end: Instant): Promise<Meta> {
  const pace = { scheduler: new HostScheduler(realClock, 1), now: realClock.now };
  const transport = fetchTransport({ userAgent: USER_AGENT, timeoutMs: 120_000 });
  const requester = (source: SourceId, baseUrl: string, accept: string): Requester =>
    createRequester({ source, pace, transport, baseUrl, headers: { accept, "user-agent": USER_AGENT }, timeoutMs: 120_000 });
  const nws = requester(API, NWS_BASE_URL, "application/geo+json");
  const fema = requester(IPAWS, OPENFEMA_BASE_URL, "application/json");
  const records: FetchRecord[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  const nwsLines: NwsLine[] = [];
  const archiveLines: ArchiveLine[] = [];

  // The NWS API: each page has a link to the next page, also the last page. A page with no message ends the query.
  const query = new URLSearchParams({ start: iso(start), end: iso(end), status: "actual", code: WEA_EVENT_CODES.join(","), limit: String(NWS_PAGE) });
  let path: string | undefined = `/alerts?${query.toString()}`;
  const seen = new Set<string>();
  for (let page = 0; path !== undefined; page += 1) {
    if (page >= MOST_PAGES || seen.has(path)) {
      failures.push(`The NWS API gave ${String(page)} pages, and the measure stops.`);
      break;
    }
    seen.add(path);
    const body = await request(nws, "nws-api", path, records, (text) => featuresOf(text).length);
    if (body === undefined) {
      failures.push(`The NWS API did not answer ${path}.`);
      break;
    }
    const features = featuresOf(body);
    const fetched = Date.now();
    for (const feature of features) nwsLines.push({ fetched, url: `${NWS_BASE_URL}${path}`, feature });
    const next = (JSON.parse(body) as { pagination?: { next?: unknown } }).pagination?.next;
    if (features.length === 0 || typeof next !== "string") path = undefined;
    else if (!next.startsWith(`${NWS_BASE_URL}/`)) {
      failures.push(`The next page of the NWS API is not on its host: ${next}`);
      path = undefined;
    } else path = next.slice(NWS_BASE_URL.length);
  }

  // The time of the last refresh of the archive.
  const datasets = new URLSearchParams({ $filter: `name eq '${ARCHIVE}'`, $select: "name,lastDataSetRefresh" });
  const listed = await request(fema, "openfema-datasets", `/DataSets?${datasets.toString()}`, records, (text) => rowsOf(text, "DataSets").length);
  const refreshText = listed === undefined ? undefined : (rowsOf(listed, "DataSets")[0] as { lastDataSetRefresh?: unknown } | undefined)?.lastDataSetRefresh;
  const refreshed = typeof refreshText === "string" && Number.isFinite(Date.parse(refreshText)) ? Date.parse(refreshText) : undefined;
  if (refreshed === undefined) notes.push("The OpenFEMA dataset list gave no refresh time of the archive. The censor time comes from the time of the fetch.");

  // The archive: only the messages of the NWS sender, with a margin around the range.
  const filter = `sender eq '${NWS_SENDER}' and sent ge '${iso(start - COPY_MARGIN_MS)}' and sent le '${iso(end + COPY_MARGIN_MS)}'`;
  for (let skip = 0; ; skip += ARCHIVE_PAGE) {
    if (skip >= MOST_PAGES * ARCHIVE_PAGE) {
      failures.push("The archive gave too many pages, and the measure stops.");
      break;
    }
    const rows = new URLSearchParams({ $filter: filter, $select: "id,identifier,sender,sent,originalMessage", $orderby: "id", $top: String(ARCHIVE_PAGE), $skip: String(skip) });
    const archivePath = `/${ARCHIVE}?${rows.toString()}`;
    const body = await request(fema, "ipaws-archive", archivePath, records, (text) => rowsOf(text, ARCHIVE).length);
    if (body === undefined) {
      failures.push(`The archive did not answer ${archivePath}.`);
      break;
    }
    const page = rowsOf(body, ARCHIVE);
    const fetched = Date.now();
    for (const row of page) {
      // Only a message of the NWS sender stays. The script keeps no message of a different authority.
      if (!isNwsRow(row)) continue;
      const { id, identifier, sender, sent, originalMessage } = row;
      archiveLines.push({ fetched, url: `${OPENFEMA_BASE_URL}/${ARCHIVE}`, row: { id, identifier, sender, sent, originalMessage } });
    }
    if (page.length < ARCHIVE_PAGE) break;
  }

  const fetchedAt = Date.now();
  const meta: Meta = { start, end, fetchedAt, ...(refreshed === undefined ? {} : { refreshed }), censorAfter: Math.min(refreshed ?? fetchedAt, fetchedAt) - CENSOR_MS, failures, notes };
  await writeFile(join(folder, "fetches.jsonl"), lines(records));
  await writeFile(join(folder, "nws-api.jsonl"), lines(nwsLines));
  await writeFile(join(folder, "ipaws.jsonl"), lines(archiveLines));
  await writeFile(join(folder, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/** This function gives the messages of one answer of the NWS API. A body that is not a feature collection throws. */
function featuresOf(body: string): unknown[] {
  const parsed = JSON.parse(body) as { features?: unknown };
  if (!Array.isArray(parsed.features)) throw new Error("the answer has no list of features");
  return parsed.features as unknown[];
}

/** This function gives the rows of one answer of OpenFEMA. A body with no list of rows throws. */
function rowsOf(body: string, entity: string): unknown[] {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const rows = parsed[entity];
  if (!Array.isArray(rows)) throw new Error(`the answer has no list ${entity}`);
  return rows as unknown[];
}

/** This function tells if a row of the archive is a message of the NWS sender with its CAP text. */
function isNwsRow(row: unknown): row is ArchiveLine["row"] {
  if (typeof row !== "object" || row === null) return false;
  const fields = row as Record<string, unknown>;
  return typeof fields["sender"] === "string" && fields["sender"].trim().toLowerCase() === NWS_SENDER && typeof fields["originalMessage"] === "string";
}

const lines = (values: readonly unknown[]): string => values.map((value) => `${JSON.stringify(value)}\n`).join("");

/** This function reads the lines of a file of an earlier measure. */
async function readLines<T>(path: string): Promise<T[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** This function maps each body with the map of its source. It gives the reports, and the count of bodies with no report. */
function reportsOf(nwsLines: readonly NwsLine[], archiveLines: readonly ArchiveLine[]): { reports: Report[]; unmapped: { api: number; ipaws: number } } {
  const reports: Report[] = [];
  const unmapped = { api: 0, ipaws: 0 };
  const observation = (source: SourceId, contentType: string, url: string, body: string, fetched: Instant): Observation => ({
    id: observationId({ source, contentType, url, body }),
    source,
    fetched,
    contentType,
    body,
    transport: { url, latency: 0 },
  });
  for (const line of nwsLines) {
    const mapped = mapApi(observation(API, "application/geo+json", line.url, JSON.stringify(line.feature), line.fetched)).reports;
    if (mapped.length === 0) unmapped.api += 1;
    reports.push(...mapped);
  }
  for (const line of archiveLines) {
    if (line.row.sender.trim().toLowerCase() !== NWS_SENDER) continue;
    const mapped = mapIpaws(observation(IPAWS, "application/xml", line.url, line.row.originalMessage, line.fetched)).reports;
    if (mapped.length === 0) unmapped.ipaws += 1;
    reports.push(...mapped);
  }
  return { reports, unmapped };
}

const folder = from ?? out;
await mkdir(out, { recursive: true });
let meta: Meta;
if (from === undefined) {
  const end = timeOption("end", Date.now());
  const start = timeOption("start", end - DEFAULT_RANGE_MS);
  if (!(start < end)) throw new Error(`The start ${iso(start)} is not before the end ${iso(end)}.`);
  meta = await fetchRange(folder, start, end);
} else meta = JSON.parse(await readFile(join(from, "meta.json"), "utf8")) as Meta;

const nwsLines = await readLines<NwsLine>(join(folder, "nws-api.jsonl"));
const archiveLines = await readLines<ArchiveLine>(join(folder, "ipaws.jsonl"));
const { reports, unmapped } = reportsOf(nwsLines, archiveLines);
const result = sentMeasure(reports, { censorAfter: meta.censorAfter });
await writeFile(join(out, "checks.jsonl"), lines(result.checks));

const { counts } = result;
const gapsOf = (kind: SentGap["class"]): SentGap[] => result.gaps.filter((gap) => gap.class === kind);
const nwsSents = nwsLines.flatMap((line) => {
  const sent = (line.feature as { properties?: { sent?: unknown } }).properties?.sent;
  return typeof sent === "string" && Number.isFinite(Date.parse(sent)) ? [Date.parse(sent)] : [];
});
const earliest = nwsSents.length === 0 ? undefined : Math.min(...nwsSents);
const summary = {
  start: iso(meta.start),
  end: iso(meta.end),
  fetchedAt: iso(meta.fetchedAt),
  ...(meta.refreshed === undefined ? {} : { refreshed: iso(meta.refreshed) }),
  censorAfter: iso(meta.censorAfter),
  nws: { messages: nwsLines.length, unmapped: unmapped.api, ...(earliest === undefined ? {} : { earliest: iso(earliest) }) },
  ipaws: { messages: archiveLines.length, unmapped: unmapped.ipaws },
  counts,
  gaps: result.gaps,
  failures: meta.failures,
  notes: meta.notes,
};
await writeFile(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

/** The table of the pairs: only the NWS message id, the event code, the two sent times, their difference and the rule of the match. */
const table = (gaps: readonly SentGap[]): string =>
  gaps.length === 0
    ? "None."
    : [
        "| NWS message | Event | NWS sent time | IPAWS sent time | Difference (seconds) | Match |",
        "| --- | --- | --- | --- | ---: | --- |",
        ...gaps.map((gap) => `| \`${gap.key}\` | ${gap.event} | ${iso(gap.sent)} | ${iso(gap.copy.sent)} | ${String(gap.difference / 1000)} | ${gap.match} |`),
      ].join("\n");
/** The titles of the classes with a pair, in the table of the counts and above the tables of the pairs. */
const SHIFTED = "Shifted: the copy with the id of the message in the incident, at a different sent time";
const LOST = "Lost: copies in the incident, but none with the id of the message and none at the sent time";
const APART = "Apart: a copy with the id of the message in a different incident";
const short = meta.start < meta.fetchedAt - NWS_HISTORY_MS ? ` The range starts more than 7 days before the fetch, so the NWS API has no messages in its first part.` : "";
const markdown = [
  "# The measure of the sent times of the WEA copies",
  "",
  `The range: ${summary.start} to ${summary.end}.${short} The NWS API gave ${String(summary.nws.messages)} actual messages with the WEA event codes, from ${summary.nws.earliest ?? "no time"}. The IPAWS archive gave ${String(summary.ipaws.messages)} messages of the NWS sender. The archive had its last refresh at ${summary.refreshed ?? "an unknown time"}. A message after ${summary.censorAfter} with no copy at its sent time is censored.`,
  "",
  "| Messages with `WEAHandling` | Count |",
  "| --- | ---: |",
  `| All | ${String(counts.messages)} |`,
  `| Same: a copy at the same sent time | ${String(counts.same)} |`,
  `| ${SHIFTED} | ${String(counts.shifted)} |`,
  `| ${LOST} | ${String(counts.lost)} |`,
  `| **Shifted and lost (must be 0)** | **${String(counts.shifted + counts.lost)}** |`,
  `| ${APART} | ${String(counts.apart)} |`,
  `| None: no copy | ${String(counts.none)} |`,
  `| Censored | ${String(counts.censored)} |`,
  "",
  `Bodies with no report: ${String(unmapped.api)} of the NWS API, ${String(unmapped.ipaws)} of the archive.`,
  "",
  `## ${SHIFTED}`,
  "",
  table(gapsOf("shifted")),
  "",
  `## ${LOST}`,
  "",
  table(gapsOf("lost")),
  "",
  `## ${APART}`,
  "",
  table(gapsOf("apart")),
  "",
  ...(meta.failures.length === 0 ? [] : ["## Failures of the requests", "", ...meta.failures.map((failure) => `- ${failure}`), ""]),
  ...(meta.notes.length === 0 ? [] : ["## Notes", "", ...meta.notes.map((note) => `- ${note}`), ""]),
].join("\n");
await writeFile(join(out, "summary.md"), markdown);
if (process.env["GITHUB_STEP_SUMMARY"] !== undefined) await appendFile(process.env["GITHUB_STEP_SUMMARY"], markdown);
console.log(markdown);

if (meta.failures.length > 0) {
  console.error("A request failed, so the measure is not complete.");
  process.exitCode = 1;
}
if (sentFails(counts)) {
  console.error(`${String(counts.shifted)} message(s) are shifted and ${String(counts.lost)} message(s) are lost. The sum of the two counts must be 0.`);
  process.exitCode = 1;
}
