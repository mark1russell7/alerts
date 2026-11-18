/**
 * The request of a source: one GET or one POST to the API of the source through polite-crawler.
 * The request keeps the pace of its host and has a time limit. The result is an answer, or a failure of the fetch. Only
 * the abort of the caller throws.
 */

import type { FetchFailure, FetchSignal, SourceId } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { ApiError, poll, send, type Answer, type Conditions, type Pace, type Send, type Transport } from "polite-crawler/api";

import { failureOf, type Detail } from "./failure.ts";

/** The time limit of one request when the source gives none, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** The shortest time between two requests to one host when the source gives none, in milliseconds. */
export const DEFAULT_MIN_INTERVAL_MS = 1000;

/** The options of the requests of one source. */
export interface RequesterOptions {
  /** The source of the requests. Its id is the name of the API in each message of polite-crawler. */
  readonly source: SourceId;
  /** The pace of polite-crawler: the host scheduler and the clock. */
  readonly pace: Pace;
  /** The transport that sends each request. It does not follow redirects. */
  readonly transport: Transport;
  /** The base URL of the API. The requester removes the slashes at its end. */
  readonly baseUrl: string;
  /** The headers of each request, with each name in lowercase, for example `accept` and `user-agent`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The shortest time between two requests to the host, in milliseconds. The default is `DEFAULT_MIN_INTERVAL_MS`. */
  readonly minIntervalMs?: number;
  /** The longest time of one request, in milliseconds. The default is `DEFAULT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** The reader of the problem text of an answer that is not a success. The default reads no text. */
  readonly detail?: Detail;
  /**
   * The secrets of the requests, for example an API key in the body of each POST. The requester removes each of them
   * from each message of a failure. The default is no secret.
   */
  readonly secrets?: readonly string[];
}

/**
 * One request of a source. A request with no body is a GET, and it can be conditional. A request with a body is a POST,
 * and it has no conditions.
 */
export type Request = RequestPath & (ConditionalGet | Post);

/** The path and the words of one request. */
export interface RequestPath {
  /** The path after the base URL, with its query. */
  readonly path: string;
  /** The words that tell what the request asks for, in a message of polite-crawler, for example `the recent alerts`. */
  readonly what: string;
}

/** A GET, with a store of validators or with no store. */
export interface ConditionalGet {
  readonly body?: undefined;
  /**
   * The store of the validators of a conditional GET. With a store, the request is a `poll` of
   * polite-crawler, and a 304 answer is a success. With no store, a 304 answer is a failure.
   */
  readonly conditions?: Conditions;
}

/** A POST with a body. The headers of the requester give its `content-type`. */
export interface Post {
  /** The body of the POST, for example a JSON text. */
  readonly body: string;
  readonly conditions?: undefined;
}

/**
 * The result of one request. The latency is the time of the transport only, not the wait of the scheduler. A failure
 * has the answer when the server answered, so a source can read its error codes. The body of that answer can hold a
 * secret: the source does not put it in a message.
 */
export type Requested =
  | { readonly ok: true; readonly url: string; readonly answer: Answer; readonly latency: number }
  | { readonly ok: false; readonly url: string; readonly failure: FetchFailure; readonly answer?: Answer };

/** The requests of one source, on one base URL. */
export interface Requester {
  /** The base URL, with no slash at its end. */
  readonly baseUrl: string;
  /** The host of the base URL. The scheduler of polite-crawler keeps one pace for each host. */
  readonly host: string;
  /** The time limit of one request, in milliseconds. */
  readonly timeoutMs: number;
  /** This function sends one request: a GET, or a POST with a body. It throws only when the signal of the caller aborts. */
  get(request: Request, signal?: FetchSignal): Promise<Requested>;
}

/**
 * This function gives the `AbortSignal` of a signal of the contract, for polite-crawler. An `AbortSignal` stays as it is.
 * A signal of another kind gets a linked `AbortSignal`: it aborts at the abort of the signal, with the same reason.
 */
export function abortSignalOf(signal: FetchSignal | undefined): AbortSignal | undefined {
  if (signal === undefined || signal instanceof AbortSignal) return signal;
  const linked = new AbortController();
  if (signal.aborted) linked.abort(signal.reason);
  else signal.addEventListener("abort", () => linked.abort(signal.reason), { once: true });
  return linked.signal;
}

/** This function removes the slashes at the end of a URL. */
function withoutEndSlashes(url: string): string {
  // A loop, not a pattern with `\/+$`: that pattern takes quadratic time on a text with many slashes (CodeQL js/polynomial-redos)
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

/**
 * This function makes the requester of one source. The requester maps each result to the contract
 * of the core:
 *
 * - The end of the time limit gives the failure `timeout`.
 * - An exchange with no answer gives the failure `network`, with the error of polite-crawler.
 * - An answer that is not a success gives the failure of `failureOf`.
 * - The abort of the signal of the caller throws its reason. It is not a failure of the source.
 *
 * The message of each failure has no secret of `options.secrets`: `redactSecrets` of `@mark1russell7/text` removes them.
 */
export function createRequester(options: RequesterOptions): Requester {
  const baseUrl = withoutEndSlashes(options.baseUrl);
  const host = new URL(baseUrl).host;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const { pace, transport, source, headers, detail } = options;
  const secrets = options.secrets ?? [];
  const now = pace.now;
  const failed = (url: string, failure: FetchFailure, answer?: Answer): Requested => ({
    ok: false,
    url,
    failure: secrets.length === 0 ? failure : { ...failure, message: redactSecrets(failure.message, secrets) },
    ...(answer === undefined ? {} : { answer }),
  });

  async function get({ path, what, body, conditions }: Request, signal?: FetchSignal): Promise<Requested> {
    const stop = abortSignalOf(signal);
    const url = `${baseUrl}${path}`;
    let timedOut = false;
    let latency = 0;
    // The latency is the time of the transport only. The wait of the scheduler is not part of it.
    const timed: Transport = async (exchange, outer) => {
      const own = AbortSignal.timeout(timeoutMs);
      own.addEventListener("abort", () => (timedOut = true), { once: true });
      const started = now();
      try {
        return await transport(exchange, outer === undefined ? own : AbortSignal.any([outer, own]));
      } finally {
        latency = now() - started;
      }
    };
    const exchange = { method: body === undefined ? "GET" : "POST", url, headers, body: body ?? null };
    const input: Send = { source, host, minIntervalMs, what, exchange, ...(secrets.length === 0 ? {} : { secrets, redact: redactSecrets }) };
    let answer: Answer;
    try {
      answer = conditions === undefined ? await send(pace, timed, input, stop) : await poll(pace, timed, conditions, input, stop);
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (timedOut) return failed(url, { kind: "timeout", message: `no answer in ${String(timeoutMs)} ms: ${url}` });
      const message = error instanceof ApiError ? error.message : errorMessage(error);
      return failed(url, { kind: "network", message });
    }
    const { outcome } = answer.classified;
    if (outcome === "ok" || (outcome === "not-modified" && conditions !== undefined)) return { ok: true, url, answer, latency };
    return failed(url, failureOf(answer, detail), answer);
  }

  return { baseUrl, host, timeoutMs, get };
}
