/**
 * This module gives the host of the live instance on one computer, as data. A boot task starts the
 * supervisor (`main.ts supervise`). The supervisor starts the runtime (`main.ts`). It starts the runtime
 * again after an exit, or after the liveness probe fails. The entry gives the paths and the ports.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { add, sum, type Quantity } from "@mark1russell7/quantity";
import { daemon, service, type Profile, type ServiceBuilder } from "@mark1russell7/service";
import type { GroupSpec, ServiceSpec } from "@mark1russell7/service/host";
import { holdingPasses, READINESS, STARTUP_BUDGET, STOP_MESSAGE } from "./index.ts";
import { alertsHome, HOME_VARIABLE } from "./config.ts";
import { INSTANCE_TIMES } from "./instance.ts";

const ms = (value: number): Quantity => ({ value, unit: "ms" });
const s = (value: number): Quantity => ({ value, unit: "s" });

/** The name of the boot task, of the group of the supervisor and of its folder. */
export const HOST_NAME = "alerts";

/** The ports of the live instance. They are below the dynamic ports of Windows, and away from the usual ports of servers in development. */
export const HOST_PORTS: { readonly port: number; readonly probePort: number } = { port: 4750, probePort: 4751 };

/** The supervisor waits this time for the first ready probe of the runtime: its startup budget and one readiness interval. */
export const READY_WITHIN: Quantity = add(STARTUP_BUDGET, READINESS.interval);

/** This function gives the readiness probe of the runtime on its probe port. The supervisor and the install use it. */
export const readinessProbe = (probePort: number = HOST_PORTS.probePort): { readonly kind: "http"; readonly url: string } => ({ kind: "http", url: `http://127.0.0.1:${probePort}/readiness` });

/** The options of the host. */
export interface HostOptions {
  /** The folder of the private files: `config.json`, `secrets.env` and the log. The host keeps its own files in the subfolder `host`. */
  readonly home: string;
  /** The folder of the package `runtime` in a checkout. */
  readonly root: string;
  /** The path of Node. */
  readonly node: string;
  readonly port?: number | undefined;
  readonly probePort?: number | undefined;
}

/** The shutdown profile of the runtime under the supervisor: `daemon`, with a drain that holds the pass in flight. */
export const RUNTIME_PROFILE: Profile = holdingPasses(daemon, INSTANCE_TIMES.passLimit);

/** This function gives the longest shutdown of a profile: the sum of the caps of its phases. */
export const shutdownCap = (profile: Profile): Quantity =>
  sum(
    (profile.phases ?? []).map((phase) => phase.cap),
    "ms",
  );

/**
 * The stop grace of the runtime: its longest shutdown, plus 2 s for the exit of the process. After the
 * grace, the supervisor stops the process tree. Thus a stop does not cut a pass.
 */
export const RUNTIME_GRACE: Quantity = add(shutdownCap(RUNTIME_PROFILE), s(2));

/**
 * This function gives the folder of the private files from the argument of the supervisor. It resolves
 * the argument as the runtime resolves `ALERTS_HOME`: `~` is the home folder, and a relative path is
 * relative to `base`. Thus the supervisor and the runtime use the same folder. An empty argument is an error.
 */
export function supervisorHome(argument: string | undefined, base: string, home: string = homedir()): string {
  if (argument === undefined || argument === "") throw new Error("The supervisor needs one argument: the folder of the private files.");
  return alertsHome({ [HOME_VARIABLE]: argument }, base, home);
}

/** The folder of the files of the host: the task file, the lock, the discovery file and the logs. */
export const hostFolder = (home: string): string => join(home, "host");

/** The discovery file of the supervisor. Each program of the group has its own file in the same folder, by its name. */
export const supervisorDiscovery = (home: string): string => join(hostFolder(home), "supervisor.json");

/**
 * This function gives the group of the supervisor: one program, the runtime.
 *
 * - The runtime is ready when `/readiness` passes, in its startup budget plus one readiness interval.
 * - A ready runtime that fails `/liveness` 3 times in sequence, 10 s apart, stops. Then the supervisor
 *   starts it again. One slow answer does not stop it.
 * - The stop goes on the IPC channel, because a Windows process cannot catch a signal of its parent.
 */
export function hostGroup(options: HostOptions): GroupSpec {
  const port = options.port ?? HOST_PORTS.port;
  const probePort = options.probePort ?? HOST_PORTS.probePort;
  const probes = `http://127.0.0.1:${probePort}`;
  return {
    name: HOST_NAME,
    stateDir: hostFolder(options.home),
    programs: [
      {
        name: "runtime",
        program: options.node,
        args: ["src/main.ts"],
        cwd: options.root,
        env: { ALERTS_HOME: options.home, PORT: String(port), PROBE_PORT: String(probePort), SERVICE_PROFILE: "daemon" },
        ipc: true,
        ready: { probe: readinessProbe(probePort), interval: ms(500), timeout: ms(250), within: READY_WITHIN },
        alive: { probe: { kind: "http", url: `${probes}/liveness` }, interval: s(10), timeout: s(2), failures: 3 },
        stop: { grace: RUNTIME_GRACE, message: STOP_MESSAGE },
        listen: { port, url: `http://127.0.0.1:${port}/` },
      },
    ],
  };
}

/**
 * This function gives the boot task. It starts the supervisor at the start of the computer, before a
 * logon, and again 1 minute after it stops. The task gets the folder of the private files as its argument.
 */
export function hostTask(options: HostOptions): ServiceSpec {
  return {
    name: HOST_NAME,
    description: "The alerts runtime: a supervisor that keeps the runtime alive.",
    program: options.node,
    args: [join(options.root, "src", "main.ts"), "supervise", options.home],
    cwd: options.root,
    start: "boot",
    restart: { after: { value: 1, unit: "min" } },
    background: true,
    stateDir: hostFolder(options.home),
  };
}

/** The shutdown profile of the supervisor. The phase `tear down dependencies` holds the staged stop of the runtime. */
export const SUPERVISOR_PROFILE: Profile = {
  ...daemon,
  phases: daemon.phases?.map((phase) => (phase.name === "tear down dependencies" ? { ...phase, cap: add(phase.cap, RUNTIME_GRACE) } : phase)),
};

/** The group of the supervisor, as its service sees it. The entry adds the discovery file to the start and the stop of the group. */
export interface HostedGroup {
  start(): void | Promise<void>;
  stop(): Promise<void>;
}

/**
 * This function declares the service of the supervisor. The group is its one dependency: the start
 * connects it, and the shutdown stops each program in stages. Only the entry `main.ts` uses `run()`.
 */
export const declareSupervisor = (group: HostedGroup): ServiceBuilder =>
  service(`${HOST_NAME}-host`)
    .dependency("group", { system: null, knobs: {}, operations: {} }, { connect: () => group.start(), close: () => group.stop() })
    .readiness(READINESS)
    .liveness({ type: "window", failAfter: s(45) })
    .startup(STARTUP_BUDGET)
    .profile(SUPERVISOR_PROFILE);
