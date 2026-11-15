/**
 * This file is the entry of the process, and the only file that uses `run()`. It starts one of two services:
 *
 * - `node src/main.ts` starts the runtime.
 * - `node src/main.ts supervise <folder>` starts the supervisor of the runtime (`supervise.ts`). The boot task starts it.
 *
 * The lifecycle owns the signals of the process. After SIGTERM or Ctrl-C, the service stops in its
 * phases, and the process exits with 0 or 1.
 *
 * The environment gives `PORT` (8080), `PROBE_PORT` (9090), `SERVICE_PROFILE` (`local`) and
 * `ALERTS_HOME` (the folder `.alerts` in the home folder). The value in parentheses is the value
 * without the variable. An empty value counts as no value, and a relative path starts at the working
 * folder. The folder holds the private files of the instance: `config.json`,
 * `secrets.env`, the log `runtime.sqlite` and the outlines `shapes.sqlite`. No repository holds them.
 *
 * The key `HEALTHCHECKS_PING_URL` of `secrets.env` gives the outside heartbeat (`heartbeat.ts`). The
 * profile `daemon` of the live instance does not start without it. Another profile starts with a warning.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openShapeCache, SHAPES_FILE } from "@mark1russell7/alerts-shapes-nws";
import { realClock, wallClock } from "@mark1russell7/algebra/clock";
import type { ServiceBuilder } from "@mark1russell7/service";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { fetchTransport } from "polite-crawler/api";
import { alertsHome, configPath, envSecrets, fileSource, readSecrets, requireConfig } from "./config.ts";
import { heartbeat } from "./heartbeat.ts";
import { PROFILES, declare } from "./index.ts";
import { INSTANCE_CHANNELS, openInstance, userAgent } from "./instance.ts";
import { openRuntimeLog } from "./log.ts";
import { shapeReport } from "./shapes.ts";
import { supervisor } from "./supervise.ts";

/** This function gives a port from the environment, or the fallback when the variable is not set. */
const port = (name: string, fallback: number): number => {
  const text = process.env[name];
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${name} is not a port: ${text}`);
  return value;
};

/** This function makes the service of the runtime from the environment and the private files. */
async function runtime(): Promise<ServiceBuilder> {
  const name = process.env["SERVICE_PROFILE"] ?? "local";
  const profile = PROFILES[name];
  if (profile === undefined) throw new Error(`SERVICE_PROFILE is "${name}". The profiles are: ${Object.keys(PROFILES).join(", ")}.`);

  const home = alertsHome(process.env, process.cwd());

  // A problem names the line and the key of a bad line, or the code of a read error. It holds no value and no path.
  const secrets = await readSecrets(home);
  if (secrets.tag === "err") throw new Error(`The private files have these problems:\n- ${secrets.error.join("\n- ")}`);
  const keys = secrets.value;
  const values = Object.values(keys);

  const secret = envSecrets(keys);
  const wall = wallClock();

  // A problem of the configuration holds no value of the file, no value of a secret and no path.
  const config = await requireConfig(fileSource(configPath(process.env, process.cwd())), INSTANCE_CHANNELS, secret);
  // Each request to the server of another party has this User-Agent.
  const agent = userAgent(config.config.contact);

  // The outside heartbeat. Without it, a stop of this process is silent.
  const pingUrl = keys["HEALTHCHECKS_PING_URL"] ?? "";
  if (pingUrl === "") {
    if (name === "daemon") throw new Error("The file secrets.env has no HEALTHCHECKS_PING_URL. The live instance needs its outside heartbeat.");
    console.warn("The file secrets.env has no HEALTHCHECKS_PING_URL. This runtime has no outside heartbeat.");
  }
  const onPass = pingUrl === "" ? undefined : heartbeat({ url: pingUrl, fetch, clock: wall, userAgent: agent, onError: (message) => console.error(redactSecrets(message, values)) });

  const log = openRuntimeLog(join(home, "runtime.sqlite"));
  // A broken file of shapes goes into quarantine, and the store starts empty. Then the outlines come again from the NWS API.
  const shapes = openShapeCache(join(home, SHAPES_FILE));
  if (shapes.quarantined !== undefined) console.error(`The file ${SHAPES_FILE} was broken. It is in quarantine, and the store of shapes starts empty.`);
  const instance = openInstance({
    config,
    secret,
    log,
    clock: realClock,
    wall,
    transport: fetchTransport({ userAgent: agent }),
    pushover: fetch,
    run: randomUUID(),
    ...(onPass === undefined ? {} : { onPass }),
    // The output gets no secret, also when an error quotes a request.
    onError: (error, failures) => console.error(`A pass failed (${failures} in sequence): ${redactSecrets(errorMessage(error), values)}`),
    shapes,
    onShapes: (outcome) => {
      const report = shapeReport(outcome);
      if (report !== undefined) console.error(redactSecrets(report, values));
    },
  });

  // The service closes the log and the store of shapes in its shutdown.
  return declare({ port: port("PORT", 8080), probePort: port("PROBE_PORT", 9090), profile, loop: instance.loop, log, shapes: instance.shapes });
}

const MODES = ["supervise"];
const mode = process.argv[2];
if (mode !== undefined && !MODES.includes(mode)) throw new Error(`The first argument is "${mode}". Give no argument for the runtime, or one of: ${MODES.join(", ")}.`);

// The process exits after the shutdown of the service.
const started = mode === "supervise" ? supervisor(process.argv[3]) : await runtime();
await started.run();
