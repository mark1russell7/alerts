/**
 * This file installs, removes or reads the boot task of the supervisor on this computer. Start it
 * from the checkout that the task runs. A boot task needs an elevated shell for its install.
 *
 * - `node src/install.ts install` installs the task and starts it.
 * - `node src/install.ts remove` stops the supervisor and removes the task.
 * - `node src/install.ts status` tells if the task exists, its state, and the result of one readiness probe of the runtime.
 *
 * After each install, and after each change of `config.json` or `secrets.env`, start `status` when the
 * time of the ready wait passed. A runtime that is not ready sends no alert.
 *
 * The environment gives `ALERTS_HOME`, the folder of the private files, as for `main.ts`. Without
 * it, the folder is `.alerts` in the home folder.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { valueIn } from "@mark1russell7/quantity";
import { installService, nodeHostPorts, probeOnce, serviceStatus, uninstallService, type ServiceOutcome } from "@mark1russell7/service/host";
import { alertsHome } from "./config.ts";
import { hostTask, READY_WITHIN, readinessProbe, supervisorDiscovery } from "./host.ts";

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

if (action === "install") {
  const code = report(await installService(spec, ports, { start: true }));
  if (code === 0) console.log(`The runtime is ready in ${valueIn(READY_WITHIN, "s")} s or less. Then start: node src/install.ts status`);
  process.exitCode = code;
} else if (action === "remove") {
  process.exitCode = report(await uninstallService(spec, ports, { discovery }));
} else if (action === "status") {
  const readiness = await probeOnce(readinessProbe(), PROBE_TIMEOUT_MS, ports);
  console.log(JSON.stringify({ task: await serviceStatus(spec, ports, { discovery }), readiness }, null, 2));
  if (!readiness.ok) process.exitCode = 1;
} else {
  console.error(`The action is one of: ${ACTIONS.join(", ")}.`);
  process.exitCode = 2;
}
