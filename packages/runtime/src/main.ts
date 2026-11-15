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
 * `secrets.env`, the log `runtime.sqlite`, the outlines `shapes.sqlite` and the counts of the quotas
 * `quotas.sqlite`. No repository holds them.
 *
 * The key `HEALTHCHECKS_PING_URL` of `secrets.env` gives the outside heartbeat (`heartbeat.ts`). The
 * profile `daemon` of the live instance does not start without it. Another profile starts with a warning.
 *
 * A bad `config.json` gives way to the last good copy `config.good.json` (`reload.ts`). In the profile
 * `daemon`, a change of the private files that passes the check stops the runtime. The supervisor starts it again.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CHANNEL_ID as PUSHOVER_CHANNEL, PUSHOVER_QUOTA, PUSHOVER_RESERVE_NOTICES } from "@mark1russell7/alerts-channel-pushover";
import { openShapeCache, SHAPES_FILE } from "@mark1russell7/alerts-shapes-nws";
import { realClock, wallClock } from "@mark1russell7/algebra/clock";
import type { ServiceBuilder } from "@mark1russell7/service";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { SqliteHostStateStore } from "polite-crawler";
import { fetchTransport, quotaGate } from "polite-crawler/api";
import { writeFileAtomic } from "@procedures/fs/files";
import { alertsHome, configPath, envSecrets } from "./config.ts";
import { heartbeat, heldOf, type PassSummary } from "./heartbeat.ts";
import { channelQuota, quotaNote } from "./quota.ts";
import { PROFILES, declare } from "./index.ts";
import { DAEMON_CHECK, INSTANCE_CHECK, openInstance, PING_URL_KEY, userAgent } from "./instance.ts";
import { openRuntimeLog } from "./log.ts";
import { GOOD_CONFIG_FILE, privateFiles, reloadHook, startConfig } from "./reload.ts";
import { shapeReport, zoneCodesText } from "./shapes.ts";
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

  // The start checks config.json with the keys of secrets.env. A bad config.json gives way to the last good copy.
  // A problem names the line and the key of a bad line, or the code of a read error. It holds no value and no path.
  const check = name === "daemon" ? DAEMON_CHECK : INSTANCE_CHECK;
  const files = privateFiles(home, configPath(process.env, process.cwd()));
  const loaded = await startConfig(files, check, (path, text) => writeFileAtomic(path, text));
  if (loaded.fallback.length > 0) console.error(`The file config.json has problems. The runtime uses the last good copy ${GOOD_CONFIG_FILE}:\n- ${loaded.fallback.join("\n- ")}`);
  for (const note of loaded.notes) console.error(note);
  const keys = loaded.keys;
  const values = Object.values(keys);

  const secret = envSecrets(keys);
  const wall = wallClock();
  const config = loaded.parsed;
  // Each request to the server of another party has this User-Agent.
  const agent = userAgent(config.config.contact);

  // The count of the Pushover messages of the month. The file keeps it across a restart. The key names the application, not its token.
  const quotas = new SqliteHostStateStore(join(home, "quotas.sqlite"));
  const pushoverQuota = quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", store: quotas, now: () => wall.now() });
  const pushoverReserveNotices = quotaGate(PUSHOVER_RESERVE_NOTICES, { key: "pushover:reserve-notices", store: quotas, now: () => wall.now() });

  // The outside heartbeat. Without it, a stop of this process is silent. The check of the profile daemon needs it.
  const pingUrl = secret(PING_URL_KEY) ?? "";
  if (pingUrl === "") console.warn(`The file secrets.env has no ${PING_URL_KEY}. This runtime has no outside heartbeat.`);
  const beat =
    pingUrl === ""
      ? undefined
      : heartbeat({
          url: pingUrl,
          fetch,
          clock: wall,
          userAgent: agent,
          held: (at) => heldOf(instance.runtime.state(), at),
          // The body of each ping tells the state of the quota. Thus the check shows the reserve.
          notes: () => [quotaNote(channelQuota(PUSHOVER_CHANNEL, pushoverQuota))],
          onError: (message) => console.error(redactSecrets(message, values)),
        });

  // A change of the private files restarts the runtime. Only the profile daemon has a supervisor that starts it again.
  const reload =
    name === "daemon"
      ? reloadHook({
          files,
          check,
          started: loaded.texts,
          restart: () => {
            console.error("The private files changed, and they pass the check. The runtime stops, and the supervisor starts it again.");
            void service.lifecycle?.shutdown("The private files changed.");
          },
          onRefused: (problems) => console.error(`A change of the private files has problems. The runtime keeps its files:\n- ${problems.join("\n- ")}`),
        })
      : undefined;
  const onPass =
    beat === undefined && reload === undefined
      ? undefined
      : (pass: PassSummary) => {
          beat?.(pass);
          reload?.onPass();
        };

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
    pushoverQuota,
    pushoverReserveNotices,
    run: randomUUID(),
    ...(onPass === undefined ? {} : { onPass }),
    // The output gets no secret, also when an error quotes a request.
    onError: (error, failures) => console.error(`A pass failed (${failures} in sequence): ${redactSecrets(errorMessage(error), values)}`),
    shapes,
    onShapes: (outcome) => {
      const report = shapeReport(outcome);
      if (report !== undefined) console.error(redactSecrets(report, values));
    },
    // New outlines change the codes of a place. Only the profile daemon has a supervisor that starts the runtime again.
    onPlaceCodes: () => {
      if (name !== "daemon") {
        console.error("New outlines change the codes of a place. Start the runtime again to use them.");
        return;
      }
      console.error("New outlines change the codes of a place. The runtime stops, and the supervisor starts it again.");
      void service.lifecycle?.shutdown("The codes of a place changed.");
    },
  });
  if (instance.zones !== undefined) console.log(zoneCodesText(instance.zones));

  // The service closes the log and the store of shapes in its shutdown.
  const service = declare({ port: port("PORT", 8080), probePort: port("PROBE_PORT", 9090), profile, loop: instance.loop, log, shapes: instance.shapes, quotas });
  return service;
}

const MODES = ["supervise"];
const mode = process.argv[2];
if (mode !== undefined && !MODES.includes(mode)) throw new Error(`The first argument is "${mode}". Give no argument for the runtime, or one of: ${MODES.join(", ")}.`);

// The process exits after the shutdown of the service.
const started = mode === "supervise" ? supervisor(process.argv[3]) : await runtime();
await started.run();
