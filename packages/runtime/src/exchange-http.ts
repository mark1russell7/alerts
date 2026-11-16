/**
 * This module holds the HTTP transport of the exchange of the copies (AL-16). It has the procedure `alerts.log.entries`
 * on a procedures host of `@procedures/peer`, and the call of the procedure from the reader. The design is in the
 * section "The exchange" of `docs/CONTRACTS.md`.
 *
 * - The host checks the token of each request. The runtime has no route and no token check of its own.
 * - The host serves only the procedure `alerts.log.entries`, and the procedure changes nothing.
 * - The listener is on the address `listen` of `copy.json`: the tailnet address of the computer.
 */
import { Client, createProcedure, createRegistry, hostPolicy, HttpTransport, ms, pathToMethod, type ProcedureRegistry } from "@procedures/client";
import { createProcedureHost, LOCAL_LISTENER_KNOBS, type ProcedureHost } from "@procedures/peer";
import type { CopyListen, CopyPeer } from "@mark1russell7/alerts";
import * as z from "zod";
import { EXCHANGE_LIMIT } from "./copy.ts";
import { EXCHANGE_PAGE } from "./exchange.ts";
import { serveEntries, type EntriesInput, type EntriesSource, type ExchangeCall } from "./peers.ts";

/** The path of the procedure that gives the shared events of the log. */
export const ENTRIES_PATH: readonly string[] = Object.freeze(["alerts", "log", "entries"]);

/** The name of the procedure that gives the shared events of the log. */
export const ENTRIES_KEY = "alerts.log.entries";

/** The path of the procedures on the listener of the exchange. The reader adds it to the URL of each other copy. */
export const EXCHANGE_BASE_PATH = "/exchange";

/** The fewest characters of the token of the exchange. A shorter token stops the start. */
export const EXCHANGE_TOKEN_LENGTH = 32;

/** The input of the procedure, as the host checks it before the handler. */
const entriesInput = z.strictObject({
  after: z.int().nonnegative(),
  limit: z.int().min(1).max(EXCHANGE_PAGE).optional(),
});

/** This function gives the registry of the exchange: the procedure `alerts.log.entries` on the parts of one runtime. */
export function entriesRegistry(source: EntriesSource): ProcedureRegistry {
  return createRegistry({
    name: "alerts-exchange",
    procedures: [
      createProcedure()
        .path([...ENTRIES_PATH])
        .input(entriesInput)
        .output(z.unknown())
        .meta({ description: "The shared events of the log after a position, the time of the copy and the hash of its configuration.", effects: { reads: ["alerts.log"], writes: [] } })
        .handler(async (input): Promise<unknown> => {
          const given: EntriesInput = input.limit === undefined ? { after: input.after } : { after: input.after, limit: input.limit };
          return serveEntries(source, given);
        })
        .build(),
    ],
  });
}

/** The options of `exchangeHost`. */
export interface ExchangeHostOptions {
  /** The parts of the runtime that serve the procedure. */
  readonly source: EntriesSource;
  /** The token of the exchange, the key `COPY_TOKEN` of `secrets.env`. Each copy has the same token. */
  readonly token: string;
  /** The address and the port of the listener: the field `listen` of `copy.json`. */
  readonly listen: CopyListen;
}

/**
 * This function gives the procedures host of the exchange. It starts nothing: the service of the process declares its
 * parts (`host.declare(svc)`). Each call needs the token. The host serves no procedure that writes.
 *
 * The function `parseCopySettings` of the core checks the address before.
 *
 * @throws Error when the token is shorter than `EXCHANGE_TOKEN_LENGTH`. The message holds no token.
 */
export function exchangeHost(options: ExchangeHostOptions): ProcedureHost {
  const { token, listen } = options;
  if (token.length < EXCHANGE_TOKEN_LENGTH) throw new Error(`The token of the exchange has fewer than ${EXCHANGE_TOKEN_LENGTH} characters.`);
  return createProcedureHost({
    name: "exchange",
    registry: entriesRegistry(options.source),
    policy: hostPolicy({ token, readOnly: true, strictCalls: true, expose: [ENTRIES_KEY], timeout: ms(EXCHANGE_LIMIT) }),
    faces: { http: { basePath: EXCHANGE_BASE_PATH } },
    listen: [{ name: "exchange", host: listen.host, port: listen.port, knobs: LOCAL_LISTENER_KNOBS }],
    // The probes of the service are on the probe port of the loopback. The listener on the tailnet gives no probe.
    probes: false,
  });
}

/** The options of `exchangeCall`. */
export interface ExchangeCallOptions {
  /** The token of the exchange, the key `COPY_TOKEN` of `secrets.env`. */
  readonly token: string;
  /** The fetch of the requests. The default is the global fetch at the time of each call. */
  readonly fetch?: typeof fetch;
}

/** The character code of the slash. */
const SLASH = 0x2f;

/** This function gives the base URL of the procedures of another copy: its URL and `EXCHANGE_BASE_PATH`. */
export function exchangeBaseUrl(peer: CopyPeer): string {
  // A loop, not a regular expression, removes the slashes at the end: its time is linear in the length of the URL.
  let end = peer.url.length;
  while (end > 0 && peer.url.charCodeAt(end - 1) === SLASH) end -= 1;
  return `${peer.url.slice(0, end)}${EXCHANGE_BASE_PATH}`;
}

/**
 * This function gives the call of the exchange over HTTP: one client of `@procedures/client` for each other copy, with
 * the token in the header `Authorization`. The worker of the exchange gives the time limit and the stop as the signal.
 */
export function exchangeCall(options: ExchangeCallOptions): ExchangeCall {
  const clients = new Map<string, Client>();
  const method = pathToMethod(ENTRIES_PATH);
  const headers = { Authorization: `Bearer ${options.token}` };
  const clientOf = (peer: CopyPeer): Client => {
    const known = clients.get(peer.id);
    if (known !== undefined) return known;
    const transport = new HttpTransport({ baseUrl: exchangeBaseUrl(peer), defaultHeaders: headers, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    const client = new Client(transport);
    clients.set(peer.id, client);
    return client;
  };
  return (peer, input, signal) => clientOf(peer).call<EntriesInput, unknown>(method, input, { signal });
}
