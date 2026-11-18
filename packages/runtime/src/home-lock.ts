/**
 * This module holds the lock of the home folder (AL-58). Each runtime takes the lock at its start, before it reads or
 * writes a file of the folder. Thus a second runtime on the same folder stops at its start. It writes no event, it
 * fetches nothing and it sends nothing. The lock is the instance lock of `@mark1russell7/service/host`.
 *
 * - The first runtime keeps the folder. A second runtime stops with the error `HomeHeld`, also under the supervisor.
 * - A lock of a process that stopped is stale. The next start removes it and takes the lock.
 * - The supervisor has its own lock in the folder `host`, for its program. This lock is of the runtime process.
 */
import { join } from "node:path";
import { acquireInstanceLock, type HostPorts, type InstanceLock } from "@mark1russell7/service/host";

/** The name of the lock file in the home folder. */
export const HOME_LOCK_FILE = "home.lock";

/** This function gives the path of the lock file of the home folder `home`. */
export const homeLockPath = (home: string): string => join(home, HOME_LOCK_FILE);

/** This error tells that this process cannot take the lock of the home folder. The runtime does not start. */
export class HomeHeld extends Error {
  /** The process ID of the live process that holds the lock, or `undefined` when the take failed. */
  readonly owner: number | undefined;

  constructor(message: string, owner?: number) {
    super(message);
    this.name = "HomeHeld";
    this.owner = owner;
  }
}

/** The lock of the home folder that this process holds. */
export interface HeldHome {
  readonly lock: InstanceLock;
  /** This text tells why a stale lock went before the take, or it is `undefined`. */
  readonly recovered: string | undefined;
}

/**
 * This function takes the lock of the home folder `home` for this process. It throws `HomeHeld` when a live process
 * holds the lock, or when the take fails. The messages hold no path: the path of the folder names the user.
 */
export async function holdHome(home: string, ports: HostPorts): Promise<HeldHome> {
  const result = await acquireInstanceLock(homeLockPath(home), ports);
  switch (result.kind) {
    case "acquired":
      return { lock: result.lock, recovered: result.recovered === null ? undefined : result.recovered.split(home).join("<home>") };
    case "held":
      throw new HomeHeld(
        `The process ${String(result.owner.pid)} holds the lock ${HOME_LOCK_FILE} of the home folder. A second runtime on the folder fetches and sends each alert again, thus this runtime does not start.`,
        result.owner.pid,
      );
    case "failed":
      throw new HomeHeld(`This runtime cannot take the lock ${HOME_LOCK_FILE} of the home folder, thus it does not start: ${result.problem.split(home).join("<home>")}`);
  }
}
