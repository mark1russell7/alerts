import type { Duration, HealthPayload, MapPayload } from "@mark1russell7/alerts";
import { add, type Quantity } from "@mark1russell7/quantity";
import { daemon, kubernetes, localDev, service } from "@mark1russell7/service";
import type { Profile, ServiceBuilder, Timing, WorkerLoop } from "@mark1russell7/service";
import { probeServer } from "@mark1russell7/service/http";
import { LOOPBACK, attachApi } from "./api.ts";
import type { RuntimeLoop } from "./loop.ts";
import type { OutageDeployWorker } from "./outage.ts";

export { LOOPBACK, PAGE_INDEX, attachApi, pageFolder, statusOf, type ApiOptions, type Status } from "./api.ts";
export * from "./balance.ts";
export * from "./config.ts";
export * from "./delivery.ts";
export * from "./events.ts";
export * from "./exchange.ts";
export * from "./exchange-http.ts";
export * from "./heartbeat.ts";
export { DELIVERY_TIMES, SOURCE_POLICY, sourcePace } from "./instance.ts";
export * from "./fetch.ts";
export * from "./limit.ts";
export * from "./log.ts";
export * from "./loop.ts";
export * from "./outage.ts";
export * from "./peers.ts";
export * from "./runtime.ts";
export * from "./snapshot.ts";
export * from "./snapshot-measure.ts";
export * from "./state.ts";
export * from "./view.ts";

const s = (value: number) => ({ value, unit: "s" });

/** The service has this time to start. A supervisor waits this time and one readiness interval for the ready probe. */
export const STARTUP_BUDGET: Quantity = s(30);

/** A supervisor sends this message on the IPC channel to stop the service in stages. */
export const STOP_MESSAGE = "shutdown";

/** The readiness policy of the service. The probe `/readiness` passes after one check passes. */
export const READINESS: Extract<Timing, { type: "debounce" }> = { type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 };

/**
 * These are the profiles of the shutdown, by name. `local` is for the computer of a developer.
 * `daemon` is for a process of a supervisor, as on the computer of the owner. A second signal does
 * not stop its drain. `pod` is for a pod of Kubernetes with a grace of 30 s and no preStop hook. Make
 * `grace` equal to the `terminationGracePeriodSeconds` of the pod.
 */
export const PROFILES: Readonly<Record<string, Profile>> = {
  local: localDev,
  daemon,
  pod: kubernetes({ grace: s(30), preStop: s(0) }),
};

/** These are the options of the service. */
export interface Options {
  /** This number is the port of the API. */
  readonly port: number;
  /** This number is the port of the probes: `/startup`, `/readiness`, `/liveness` and `/report`. */
  readonly probePort: number;
  /** This profile gives the phases of the shutdown and the effect of a second signal. */
  readonly profile: Profile;
  /** The loop of the runtime. The service runs it as the worker `passes`, and its liveness check reads `stuck()`. */
  readonly loop: RuntimeLoop;
  /**
   * The log of the runtime. The service closes it in the phase `tear down dependencies`, after the close of
   * the worker. Thus no pass writes to a closed log. The process exits after the shutdown, so no other code closes it.
   */
  readonly log: { close(): void };
  /** The outlines of the instance. The service stops their refresh and closes their cache in the phase `tear down dependencies`. */
  readonly shapes?: { close(): Promise<void> };
  /** The store of the counts of the quotas of the channels. The service closes it in the phase `tear down dependencies`. */
  readonly quotas?: { close(): void };
  /** This function gives the payload of the route `GET /map`. Without it, the API has no map route. */
  readonly map?: (() => MapPayload) | undefined;
  /** This function gives the payload of the route `GET /health`. Without it, the API has no health route. */
  readonly health?: (() => HealthPayload) | undefined;
  /** The folder of the built local page. The API serves its files after its routes (`ApiOptions.page`). */
  readonly page?: string | undefined;
  /** The worker of the deploy of the outage call. The service runs it as the worker `outage`, beside the passes. */
  readonly outage?: OutageDeployWorker;
  /** The exchange with the other copies of the system. */
  readonly exchange?: ServiceExchange;
}

/** The parts of the exchange in the service. */
export interface ServiceExchange {
  /** The loop of the worker of the exchange. The service runs it as the worker `exchange`. */
  readonly loop?: WorkerLoop;
  /** The procedures host of the exchange (`exchangeHost`). It declares its server and its listener on the service. */
  readonly host?: { declare(svc: ServiceBuilder): ServiceBuilder };
}

/**
 * This function gives a profile whose drain also holds the pass in flight. The cap of the drain is
 * the cap of the profile plus `passLimit`. Thus a shutdown does not cut a pass.
 */
export const holdingPasses = (profile: Profile, passLimit: Duration): Profile => ({
  ...profile,
  phases: profile.phases?.map((phase) => (phase.name === "drain" ? { ...phase, cap: add(phase.cap, { value: passLimit, unit: "ms" }) } : phase)),
});

/** This function adds the worker of the deploy of the outage call, when the instance has one. */
const withOutage = (svc: ServiceBuilder, outage: OutageDeployWorker | undefined): ServiceBuilder =>
  outage === undefined ? svc : svc.worker("outage", outage.worker.knobs, outage.worker);

/**
 * This function declares the one service of the process. It starts nothing. `describe()` gives the
 * declaration as data, and `lint()` examines it. Only the entry (`main.ts`) uses `run()`.
 */
export const declare = (options: Options): ServiceBuilder => {
  const svc = parts(options);
  const exchange = options.exchange;
  // The worker of the exchange stops before the log closes, because the service closes each worker before its dependencies.
  const withWorker = exchange?.loop === undefined ? svc : svc.worker("exchange", exchange.loop.knobs, exchange.loop);
  return exchange?.host === undefined ? withWorker : exchange.host.declare(withWorker);
};

// The parts of the service of each runtime: the API, the dependencies, the workers of the passes and of the outage call, the checks and the policies.
const parts = (options: Options): ServiceBuilder =>
  withOutage(
    attachApi(service("runtime"), { port: options.port, loop: options.loop, map: options.map, health: options.health, page: options.page, ...(options.outage === undefined ? {} : { outage: options.outage }) })
      .dependency("log", { system: null, knobs: {}, operations: {} }, { connect: () => undefined, close: () => options.log.close() })
      .dependency("shapes", { system: null, knobs: {}, operations: {} }, { connect: () => undefined, close: () => options.shapes?.close() })
      .dependency("quotas", { system: null, knobs: {}, operations: {} }, { connect: () => undefined, close: () => options.quotas?.close() })
      .worker("passes", options.loop.worker.knobs, options.loop.worker),
    options.outage,
  )
    // A stuck loop fails liveness. Then the supervisor stops the process and starts it again.
    .check(
      { name: "passes.progress", dependency: null, step: "progress", ownConnection: true, gates: "liveness", poll: { interval: s(5), jitter: 0.1, timeout: s(1) } },
      () => {
        const stuck = options.loop.stuck();
        if (stuck !== undefined) throw new Error(stuck);
        return "ok";
      },
    )
    // The probes have a port of their own. Thus they answer through the whole shutdown.
    .healthServer(probeServer({ port: options.probePort, host: LOOPBACK, server_retry_after: s(1) }))
    // The policies apply to the checks of the service.
    .readiness(READINESS)
    .liveness({ type: "window", failAfter: s(45) })
    .startup(STARTUP_BUDGET)
    .profile(holdingPasses(options.profile, options.loop.times.passLimit))
    // A Windows process cannot catch a signal from its parent. Thus a supervisor sends this message, and the shutdown drains the pass.
    .trigger("ipc-message", { match: STOP_MESSAGE, as: "SIGTERM" });
