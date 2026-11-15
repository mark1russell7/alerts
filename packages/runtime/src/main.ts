/**
 * This file is the entry of the process, and the only file that uses `run()`. The lifecycle owns the
 * signals of the process. After SIGTERM or Ctrl-C, the service stops in its phases, and the process
 * exits with 0 or 1.
 *
 * The environment gives `PORT` (8080), `PROBE_PORT` (9090), `SERVICE_PROFILE` (`local`) and
 * `ALERTS_HOME` (the folder `.alerts` in the home folder). The value in parentheses is the value
 * without the variable. The folder holds the private files of the instance: `config.json`,
 * `secrets.env` and the log `runtime.sqlite`. No repository holds them.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realClock, wallClock } from "@mark1russell7/algebra/clock";
import { parseConfig } from "@mark1russell7/alerts";
import { parseEnvFile } from "@mark1russell7/service/host";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { fetchTransport } from "polite-crawler/api";
import { PROFILES, declare } from "./index.ts";
import { INSTANCE_CHANNELS, openInstance, USER_AGENT } from "./instance.ts";
import { openRuntimeLog } from "./log.ts";

/** This function gives a port from the environment, or the fallback when the variable is not set. */
const port = (name: string, fallback: number): number => {
  const text = process.env[name];
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${name} is not a port: ${text}`);
  return value;
};

const name = process.env["SERVICE_PROFILE"] ?? "local";
const profile = PROFILES[name];
if (profile === undefined) throw new Error(`SERVICE_PROFILE is "${name}". The profiles are: ${Object.keys(PROFILES).join(", ")}.`);

const home = process.env["ALERTS_HOME"] ?? join(homedir(), ".alerts");

// A problem of the file names its line and its key, and no value.
const secrets = parseEnvFile(readFileSync(join(home, "secrets.env"), "utf8"));
if (secrets.problems.length > 0) throw new Error(`The file secrets.env has these problems:\n- ${secrets.problems.join("\n- ")}`);
const values = Object.values(secrets.env);

const secret = (key: string): string | undefined => secrets.env[key];

// A problem of the parse holds no value of the file and no value of a secret.
const parsed = parseConfig(readFileSync(join(home, "config.json"), "utf8"), INSTANCE_CHANNELS, secret);
if (parsed.tag === "err") throw new Error(`The file config.json has these problems:\n- ${parsed.error.join("\n- ")}`);

const log = openRuntimeLog(join(home, "runtime.sqlite"));
const instance = openInstance({
  config: parsed.value,
  secret,
  log,
  clock: realClock,
  wall: wallClock(),
  transport: fetchTransport({ userAgent: USER_AGENT }),
  pushover: fetch,
  run: randomUUID(),
  // The output gets no secret, also when an error quotes a request.
  onError: (error, failures) => console.error(`A pass failed (${failures} in sequence): ${redactSecrets(errorMessage(error), values)}`),
});

// The service closes the log in its shutdown, and the process exits after the shutdown.
await declare({ port: port("PORT", 8080), probePort: port("PROBE_PORT", 9090), profile, loop: instance.loop, log }).run();
