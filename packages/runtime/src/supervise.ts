/**
 * This module makes the supervisor of the runtime. The boot task starts it through the entry, with
 * the folder of the private files: `node src/main.ts supervise <folder>`. The supervisor starts the
 * runtime and keeps it alive. At its own shutdown, it stops the runtime in stages, and the runtime
 * drains its pass.
 *
 * - `node src/main.ts supervise <folder>` starts the supervisor in a console. Ctrl-C stops it.
 * - `src/install.ts` installs the boot task that starts it.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceBuilder } from "@mark1russell7/service";
import { discoveryOf, nodeHostPorts, removeDiscovery, superviseGroup, writeDiscovery } from "@mark1russell7/service/host";
import { declareSupervisor, hostGroup, supervisorDiscovery } from "./host.ts";

// The folder of the package. The runtime starts from the same checkout as the supervisor.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * This function makes the service of the supervisor for the folder of the private files. The service
 * starts the group, and its shutdown stops the group. The entry `main.ts` starts the service.
 */
export function supervisor(home: string | undefined): ServiceBuilder {
  if (home === undefined || home === "") throw new Error("The supervisor needs one argument: the folder of the private files.");
  const ports = nodeHostPorts();
  const group = superviseGroup(hostGroup({ home, root: ROOT, node: process.execPath }), ports);
  // The discovery file names this process. With it, the remove of the task stops the process tree.
  const discovery = supervisorDiscovery(home);
  return declareSupervisor({
    start: async () => {
      await writeDiscovery(discovery, discoveryOf({}, ports), ports);
      group.start();
    },
    stop: async () => {
      await group.stop();
      await removeDiscovery(discovery, ports);
    },
  });
}
