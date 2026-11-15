/**
 * This file is the entry of the supervisor. The boot task starts it with one argument: the folder of
 * the private files. The supervisor starts the runtime and keeps it alive. At its own shutdown, it
 * stops the runtime in stages, and the runtime drains its pass.
 *
 * - `node src/supervise.ts <folder>` starts the supervisor in a console. Ctrl-C stops it.
 * - `src/install.ts` installs the boot task that starts it.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoveryOf, nodeHostPorts, removeDiscovery, superviseGroup, writeDiscovery } from "@mark1russell7/service/host";
import { declareSupervisor, hostGroup, supervisorDiscovery } from "./host.ts";

const home = process.argv[2];
if (home === undefined || home === "") throw new Error("The supervisor needs one argument: the folder of the private files.");

// The runtime runs from the checkout of this file.
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ports = nodeHostPorts();
const group = superviseGroup(hostGroup({ home, root, node: process.execPath }), ports);

// The discovery file names this process. With it, the remove of the task stops the process tree.
const discovery = supervisorDiscovery(home);

// The service starts the group, and it stops the group in its shutdown. The process exits after the shutdown.
await declareSupervisor({
  start: async () => {
    await writeDiscovery(discovery, discoveryOf({}, ports), ports);
    group.start();
  },
  stop: async () => {
    await group.stop();
    await removeDiscovery(discovery, ports);
  },
}).run();
