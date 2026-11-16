import { createServer } from "node:http";
import { join } from "node:path";
import type { HealthPayload, Instant, MapPayload, SourceId } from "@mark1russell7/alerts";
import type { ServiceBuilder } from "@mark1russell7/service";
import { handle, httpTransport } from "@mark1russell7/service/http";
import { folderHandler } from "@mark1russell7/service/http-folder";
import type { RuntimeLoop } from "./loop.ts";
import type { OutageDeployState } from "./outage.ts";

/** The address of each server of the service. Only this computer reaches the API and the probes. */
export const LOOPBACK = "127.0.0.1";

/** These are the options of the API of the service. */
export interface ApiOptions {
  /** This number is the port of the API. */
  readonly port: number;
  /** The loop of the runtime. The route `GET /status` reads it. */
  readonly loop: RuntimeLoop;
  /**
   * This function gives the payload of the route `GET /map`. The payload holds the labels and the positions of the places,
   * thus only the loopback address serves it. Without the function, the API has no map route.
   */
  readonly map?: (() => MapPayload) | undefined;
  /**
   * This function gives the payload of the route `GET /health`: the health of each part of the system. Its coverage holds
   * the ids of the places, thus only the loopback address serves it. Without the function, the API has no health route.
   */
  readonly health?: (() => HealthPayload) | undefined;
  /**
   * The folder of the built local page (`pageFolder`). The path `/` gives its file `PAGE_INDEX`. The page and the route
   * `GET /map` have one origin. Thus the policy of the folder lets the page read the map. Without the folder, the API serves no page.
   */
  readonly page?: string | undefined;
  /** The worker of the deploy of the outage call. The route `GET /status` reads its state. */
  readonly outage?: { state(): OutageDeployState };
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
  /** The state of the deploy of the outage call. An instance with no outage call has no field. */
  readonly outage?: OutageDeployState;
}

/** The file of the built local page that the path `/` gives. */
export const PAGE_INDEX = "local.html";

/** This function gives the folder of the built local page in a checkout, from the folder of the package `runtime`. */
export const pageFolder = (root: string): string => join(root, "..", "site", "dist");

/** This function gives the status of the loop, and of the deploy of the outage call, at the time of the request. */
export function statusOf(loop: RuntimeLoop, outage?: { state(): OutageDeployState }): Status {
  const last = loop.last();
  return {
    at: last?.at ?? null,
    wakeAt: last?.wakeAt ?? null,
    fetched: last?.fetched ?? [],
    sent: last?.delivery?.sent.length ?? 0,
    conflicts: last?.conflicts.length ?? 0,
    stuck: loop.stuck() ?? null,
    ...(outage === undefined ? {} : { outage: outage.state() }),
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
  http.mount(handle("api", "GET /status", () => statusOf(options.loop, options.outage)));
  // Each route declares if a client can send it again.
  const api = svc.controller("api").route("GET /status", { idempotent: true });
  const map = options.map;
  if (map !== undefined) {
    http.mount(handle("api", "GET /map", () => map()));
    api.route("GET /map", { idempotent: true });
  }
  const health = options.health;
  if (health !== undefined) {
    http.mount(handle("api", "GET /health", () => health()));
    api.route("GET /health", { idempotent: true });
  }
  // The files of the page come after the routes. A path of no file goes to the next handler, thus it gets 404.
  if (options.page !== undefined) http.mount(folderHandler(options.page, { index: PAGE_INDEX }));
  return svc.server("http", http.knobs, http);
};
