/**
 * The fetch function of the source of a CAP feed. It asks for the index of the feed, and then for each new message of
 * the index, through polite-crawler. The index is a fixed URL, so a request names no place of the watch.
 *
 * The fetch keeps the state of each entry of the last index in memory. This state is the observation of its message
 * and the count of its failed tries. An entry that leaves the index leaves the state. After a restart, the fetch asks for each
 * message of the index again, and the log knows the observations by their ids.
 */

import { observationId, type FetchFailure, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import { createRequester, type Requester } from "@mark1russell7/alerts-fetch";
import { readCapIndex, splitFeed, type CapIndexEntry } from "@mark1russell7/alerts-format-cap";
import type { Condition, Pace, Reply, Transport } from "polite-crawler/api";

import { DEFAULT_PER_FETCH, feedProblems, httpsBase, type CapFeed } from "./feed.ts";

/**
 * The count of failed tries of one message before the fetch sets the message aside. A message that is set aside
 * stays aside until the index changes its entry. The value 3 is a shortcut with no measure. It ends when the
 * health of the sources has the counts of failed messages.
 */
export const SET_ASIDE_AFTER = 3;

/** The media types of each request: the index (Atom or RSS) and the CAP messages. */
const ACCEPT = "application/cap+xml, application/atom+xml, application/rss+xml, application/xml, text/xml";

/** The options of the fetch function of the source of a CAP feed. */
export interface CapFeedFetchOptions {
  /** The config of the feed. */
  readonly feed: CapFeed;
  /** The pace of polite-crawler: the host scheduler and the clock. The feeds of one host share its pace. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The `User-Agent` header. The instance gives it from its settings. */
  readonly userAgent: string;
  /** The shortest time between two requests to a host, in milliseconds. The default is 1000. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is 15000. */
  readonly timeoutMs?: number;
}

/** The input of the fetch function, as the contract gives it. */
export interface CapFeedFetchInput {
  readonly watch: Watch;
}

/** The state of one entry of the last index. */
interface EntryState {
  /** The URL of the message, resolved on the URL of the index. */
  readonly url: string;
  /** The base of the URL, when the fetch can ask for it: the base of the index or a message base of the config. */
  readonly base: string | undefined;
  /** The observation of the message, after a whole answer. */
  observation?: Observation;
  /** True: an outcome of the fetch gave the observation. */
  given: boolean;
  /** The count of failed tries. At `SET_ASIDE_AFTER`, the message is set aside. */
  failures: number;
}

/** The key of an entry. An entry with a new time or a new link is a new entry, so the fetch asks for it again. */
const keyOf = (entry: CapIndexEntry): string => JSON.stringify([entry.id, entry.link, entry.updated ?? null]);

/** This function gives the observation of one message: its whole body, with the validators of the answer. */
export function observationOf(feed: CapFeed, reply: Reply, url: string, fetched: Instant, latency: number): Observation {
  const contentType = reply.headers["content-type"] ?? "application/cap+xml";
  const etag = reply.headers["etag"];
  const lastModified = reply.headers["last-modified"];
  return {
    id: observationId({ source: feed.id, contentType, url, body: reply.body }),
    source: feed.id,
    fetched,
    contentType,
    body: reply.body,
    transport: {
      url,
      status: reply.status,
      latency,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
    },
  };
}

/**
 * This function makes the fetch function of the source of one feed. It throws for a config with problems. The fetch
 * does not throw for a failure of the source: it gives `{ ok: false }`. It throws only when the signal of the caller
 * aborts.
 *
 * Each fetch is one conditional GET (`poll` of polite-crawler) of the index, and one GET of each new message, at most
 * `perFetch` of them. The other new messages wait for the next fetch. The fetch gives no cursor.
 *
 * - A failure of the index fails the fetch. A cut index, or an answer that is not an index, also deletes the condition.
 * - A failure of a host stops the requests of the fetch, because the next requests to the host fail too.
 * - A refused message, or a cut message, counts one failed try. The fetch goes on to the next message.
 * - A fetch with a failure and no new observation fails. A fetch with new observations gives them.
 * - The fetch does not follow a link to another base. It sets the message aside at once.
 *
 * The outcome is complete when the fetch has the observation of each entry of the index. Then a snapshot feed gives
 * each observation of the index, and a stream feed gives only the new observations.
 */
export function createCapFeedFetch(options: CapFeedFetchOptions): (input: CapFeedFetchInput, signal?: FetchSignal) => Promise<FetchOutcome> {
  const { feed } = options;
  const problems = feedProblems(feed);
  if (problems.length > 0) throw new Error(`The config of the CAP feed ${feed.id} has problems: ${problems.join(". ")}.`);
  const indexBase = httpsBase(feed.url) ?? feed.url;
  const indexUrl = new URL(feed.url);
  const indexPath = `${indexUrl.pathname}${indexUrl.search}`;
  const bases = new Set([indexBase, ...(feed.messageBases ?? [])]);
  const perFetch = feed.perFetch ?? DEFAULT_PER_FETCH;
  const now = options.pace.now;
  const requesters = new Map<string, Requester>();
  const requesterOf = (base: string): Requester => {
    const known = requesters.get(base);
    if (known !== undefined) return known;
    const requester = createRequester({
      source: feed.id,
      pace: options.pace,
      transport: options.transport,
      baseUrl: base,
      headers: { accept: ACCEPT, "user-agent": options.userAgent },
      ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    requesters.set(base, requester);
    return requester;
  };
  const conditions = new Map<string, Condition>();
  let answered = false;
  // The entries of the last index, in its order, and a lossy problem of the last index: an entry with no link.
  let entries = new Map<string, EntryState>();
  let lossy = false;

  /** This function reads the index. It gives the failure of the index, or the refusals of the new entries. */
  const readIndex = async (signal: FetchSignal | undefined): Promise<{ readonly failure?: FetchFailure; readonly refused: readonly FetchFailure[] }> => {
    const requested = await requesterOf(indexBase).get({ path: indexPath, what: `the index of the CAP feed ${feed.title}`, conditions }, signal);
    if (!requested.ok) return { failure: requested.failure, refused: [] };
    const { url, answer } = requested;
    if (answer.classified.outcome === "not-modified") {
      if (answered) return { refused: [] };
      // A 304 with no earlier full answer: the next request sends no condition
      conditions.delete(url);
      return { failure: { kind: "network", message: `a 304 answer with no earlier full answer: ${url}` }, refused: [] };
    }
    const body = answer.reply.body;
    const read = readCapIndex(body);
    if (!read.ok) {
      // poll keeps the condition of each 2xx answer. A bad body must not be the base of a later 304.
      conditions.delete(url);
      answered = false;
      const whole = splitFeed(body).whole;
      return { failure: whole ? { kind: "server", message: `the answer is not the index of a CAP feed (${read.reason}): ${url}` } : { kind: "network", message: `truncated or malformed body: ${url}` }, refused: [] };
    }
    answered = true;
    lossy = read.problems.some((problem) => problem.lossy === true);
    const refused: FetchFailure[] = [];
    const next = new Map<string, EntryState>();
    for (const entry of read.entries) {
      const key = keyOf(entry);
      const known = entries.get(key);
      if (known !== undefined) {
        next.set(key, known);
        continue;
      }
      const link = URL.canParse(entry.link, feed.url) ? new URL(entry.link, feed.url).href : undefined;
      const base = link === undefined ? undefined : httpsBase(link);
      if (link === undefined || base === undefined || !bases.has(base)) {
        refused.push({ kind: "refused", message: `the link ${entry.link} of the entry ${entry.id} is not on a base of the feed` });
        next.set(key, { url: link ?? entry.link, base: undefined, given: false, failures: SET_ASIDE_AFTER });
        continue;
      }
      next.set(key, { url: link, base, given: false, failures: 0 });
    }
    entries = next;
    return { refused };
  };

  return async (_input, signal) => {
    const index = await readIndex(signal);
    if (index.failure !== undefined) return { ok: false, failure: index.failure };
    let failure: FetchFailure | undefined = index.refused[0];
    let asked = 0;
    for (const state of entries.values()) {
      if (asked >= perFetch) break;
      if (state.observation !== undefined || state.base === undefined || state.failures >= SET_ASIDE_AFTER) continue;
      asked += 1;
      const url = new URL(state.url);
      const requested = await requesterOf(state.base).get({ path: `${url.pathname}${url.search}`, what: `a message of the CAP feed ${feed.title}` }, signal);
      if (!requested.ok) {
        failure = requested.failure;
        if (requested.failure.kind !== "refused") break;
        state.failures += 1;
        continue;
      }
      if (!splitFeed(requested.answer.reply.body).whole) {
        failure = { kind: "network", message: `truncated or malformed body: ${requested.url}` };
        state.failures += 1;
        continue;
      }
      state.observation = observationOf(feed, requested.answer.reply, requested.url, now(), requested.latency);
    }
    const states = [...entries.values()];
    const fresh = states.flatMap((state) => (state.observation !== undefined && !state.given ? [state.observation] : []));
    if (failure !== undefined && fresh.length === 0) return { ok: false, failure };
    for (const state of states) if (state.observation !== undefined) state.given = true;
    const complete = !lossy && states.every((state) => state.observation !== undefined);
    const all = states.flatMap((state) => (state.observation === undefined ? [] : [state.observation]));
    return { ok: true, observations: feed.listing === "snapshot" && complete ? all : fresh, complete };
  };
}
