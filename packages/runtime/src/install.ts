/**
 * This file installs, removes or reads the boot task of the supervisor on this computer. Start it
 * from the checkout that the task runs. A boot task needs an elevated shell for its install.
 *
 * - `node src/install.ts install` installs the task and starts it.
 * - `node src/install.ts remove` stops the supervisor and removes the task.
 * - `node src/install.ts status` tells if the task exists, its state, and the result of one readiness probe of the runtime.
 *   It also reads the check of the heartbeat on Healthchecks.io. The period plus the grace of the check must be the gap of two pings or more.
 *
 * After each install, and after each change of `config.json` or `secrets.env`, start `status` when the
 * time of the ready wait passed. A runtime that is not ready sends no alert.
 *
 * The environment gives `ALERTS_HOME`, the folder of the private files, as for `main.ts`. Without
 * it, the folder is `.alerts` in the home folder.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { valueIn } from "@mark1russell7/quantity";
import { installService, nodeHostPorts, probeOnce, serviceStatus, uninstallService, type ServiceOutcome } from "@mark1russell7/service/host";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { fetchTransport, send, statusLine } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";
import { alertsHome, readText, SECRETS_FILE } from "./config.ts";
import { checkOfPingUrl, checksRequest, checkTimesProblem, heartbeatGap } from "./heartbeat.ts";
import { hostTask, READY_WITHIN, readinessProbe, supervisorDiscovery } from "./host.ts";
import { checksKeys, INSTANCE_TIMES, USER_AGENT_NAME } from "./instance.ts";

const ACTIONS = ["install", "remove", "status"] as const;
const action = process.argv[2];

const home = alertsHome(process.env, process.cwd());
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const spec = hostTask({ home, root, node: process.execPath });
const ports = nodeHostPorts();
// The supervisor writes this discovery file. With it, the remove stops the live process tree.
const discovery = supervisorDiscovery(home);

/** This function prints an outcome, and gives the exit code. */
function report(outcome: ServiceOutcome): number {
  switch (outcome.kind) {
    case "done":
      console.log(`Done. The files: ${outcome.files.join(", ") || "none"}.`);
      return 0;
    case "failed":
      console.error(`The command failed: ${outcome.problem}`);
      return 1;
    case "refused":
      console.error(`The spec has these problems:\n- ${outcome.problems.join("\n- ")}`);
      return 1;
    case "unsupported":
      console.error(`The platform ${outcome.platform} has no service host.`);
      return 1;
  }
}

// The longest time of one readiness probe of the status.
const PROBE_TIMEOUT_MS = 2000;

/** The result of the read of the outside check. The times are in seconds, as Healthchecks.io shows them. */
interface OutsideCheck {
  readonly ok: boolean;
  readonly status?: string;
  readonly periodSeconds?: number;
  readonly graceSeconds?: number;
  /** The period plus the grace that the heartbeat needs. */
  readonly neededSeconds: number;
  readonly problem?: string;
}

/**
 * This function reads the check of the heartbeat through the management API of Healthchecks.io. The
 * check fails when its period plus its grace is shorter than the gap of two pings. The output holds no key and no URL.
 */
async function outsideCheck(): Promise<OutsideCheck> {
  const gap = heartbeatGap(INSTANCE_TIMES);
  const neededSeconds = Math.ceil(gap / 1000);
  // The status reads secrets.env as the start does: a bad line is a problem, and no problem holds a value.
  const keys = checksKeys(await readText(() => readFile(join(home, SECRETS_FILE), "utf8")));
  if (keys.tag === "err") return { ok: false, neededSeconds, problem: keys.error.join(" ") };
  const { key, url } = keys.value;
  const secrets = [key, url];
  // The request has the User-Agent with no contact: the status reads no configuration.
  const exchange = checksRequest(key, USER_AGENT_NAME);
  try {
    const pace = { scheduler: new HostScheduler(realClock, 1), now: realClock.now };
    const input = { source: "Healthchecks.io", host: new URL(exchange.url).host, what: "the checks of the project", exchange, secrets, redact: redactSecrets };
    const answer = await send(pace, fetchTransport({ userAgent: USER_AGENT_NAME }), input);
    if (answer.reply.status !== 200) return { ok: false, neededSeconds, problem: `The management API gave ${statusLine(answer.reply)}.` };
    const found = checkOfPingUrl(answer.reply.body, url);
    if (!found.ok) return { ok: false, neededSeconds, problem: found.problem };
    const problem = checkTimesProblem(found.check, gap);
    const seen = { status: found.check.status, periodSeconds: found.check.timeout / 1000, graceSeconds: found.check.grace / 1000, neededSeconds };
    return problem === undefined ? { ok: true, ...seen } : { ok: false, ...seen, problem };
  } catch (error) {
    return { ok: false, neededSeconds, problem: redactSecrets(errorMessage(error), secrets) };
  }
}

if (action === "install") {
  const code = report(await installService(spec, ports, { start: true }));
  if (code === 0) console.log(`The runtime is ready in ${valueIn(READY_WITHIN, "s")} s or less. Then start: node src/install.ts status`);
  process.exitCode = code;
} else if (action === "remove") {
  process.exitCode = report(await uninstallService(spec, ports, { discovery }));
} else if (action === "status") {
  const readiness = await probeOnce(readinessProbe(), PROBE_TIMEOUT_MS, ports);
  const heartbeat = await outsideCheck();
  console.log(JSON.stringify({ task: await serviceStatus(spec, ports, { discovery }), readiness, heartbeat }, null, 2));
  if (!readiness.ok || !heartbeat.ok) process.exitCode = 1;
} else {
  console.error(`The action is one of: ${ACTIONS.join(", ")}.`);
  process.exitCode = 2;
}
