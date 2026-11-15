import { createServer } from "node:http";
import type { Instant, SourceId } from "@mark1russell7/alerts";
import type { ServiceBuilder } from "@mark1russell7/service";
import { handle, httpTransport } from "@mark1russell7/service/http";
import type { RuntimeLoop } from "./loop.ts";

/** The address of each server of the service. Only this computer reaches the API and the probes. */
export const LOOPBACK = "127.0.0.1";

/** These are the options of the API of the service. */
export interface ApiOptions {
  /** This number is the port of the API. */
  readonly port: number;
  /** The loop of the runtime. The route `GET /status` reads it. */
  readonly loop: RuntimeLoop;
}

/**
 * The answer of `GET /status`. It has the times and the counts of the last pass, and no incident,
 * place or person. Thus a log or a watcher that reads it gets no private value.
 */
export interface Status {
  /** The time of the last pass that ended, or `null` before the first pass. */
  readonly at: Instant | null;
  /** The wake time of the last pass, or `null` when it has none. */
  readonly wakeAt: Instant | null;
  /** The sources that the last pass fetched. */
  readonly fetched: readonly SourceId[];
  /** The count of the sends of the last pass. */
  readonly sent: number;
  /** The count of the conflicts of the last pass. */
  readonly conflicts: number;
  /** The reason that the loop is stuck, or `null`. */
  readonly stuck: string | null;
}

/** This function gives the status of the loop at the time of the request. */
export function statusOf(loop: RuntimeLoop): Status {
  const last = loop.last();
  return {
    at: last?.at ?? null,
    wakeAt: last?.wakeAt ?? null,
    fetched: last?.fetched ?? [],
    sent: last?.delivery?.sent.length ?? 0,
    conflicts: last?.conflicts.length ?? 0,
    stuck: loop.stuck() ?? null,
  };
}

const s = (value: number) => ({ value, unit: "s" });

/**
 * This function gives the API to the service of the entry: an HTTP server, its controller and its
 * routes. The API is a component. It does not start the server, and it does not use `run()`.
 */
export const attachApi = (svc: ServiceBuilder, options: ApiOptions): ServiceBuilder => {
  // The transport has no defaults: the idle close, the sweep of idle connections and the Retry-After of each 503.
  const http = httpTransport(
    createServer(),
    { server_idle_close: s(65), server_idle_sweep_interval: s(1), server_retry_after: s(1) },
    { listen: { port: options.port, host: LOOPBACK } },
  );
  // Each request of a route goes through the service. Thus the drain waits for it, and the shutdown can cut it.
  http.mount(handle("api", "GET /status", () => statusOf(options.loop)));
  // Each route declares if a client can send it again.
  svc.controller("api").route("GET /status", { idempotent: true });
  return svc.server("http", http.knobs, http);
};
