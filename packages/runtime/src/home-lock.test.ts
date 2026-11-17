import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockText, nodeHostPorts } from "@mark1russell7/service/host";
import { fakeHost } from "@mark1russell7/service/testing";
import { describe, expect, it } from "vitest";
import { HOME_LOCK_FILE, HomeHeld, holdHome, homeLockPath } from "./home-lock.ts";

const HOME = "/srv/alerts-test";

/** This function gives the error of a take, or fails the test when the take gives a lock. */
async function refusal(take: Promise<unknown>): Promise<HomeHeld> {
  try {
    await take;
  } catch (error) {
    expect(error).toBeInstanceOf(HomeHeld);
    return error as HomeHeld;
  }
  throw new Error("The take gave a lock.");
}

describe("the lock of the home folder", () => {
  it("gives the lock to the first runtime, and refuses a second runtime while the first is alive", async () => {
    const host = fakeHost();
    const held = await holdHome(HOME, host.ports);
    expect(held.recovered).toBeUndefined();
    expect(host.text(homeLockPath(HOME))).toBe(lockText({ pid: 100, startedAt: host.ports.self.startedAt }));

    // Another live runtime holds the folder. The take names its process, and it does not change the file.
    const other = fakeHost({ self: { pid: 200, startedAt: 7 }, files: { [homeLockPath(HOME)]: host.text(homeLockPath(HOME)) ?? "" } });
    other.processes.set(100, host.ports.self.startedAt);
    const refused = await refusal(holdHome(HOME, other.ports));
    expect(refused.owner).toBe(100);
    expect(refused.message).toContain(`The process 100 holds the lock ${HOME_LOCK_FILE}`);
    expect(other.text(homeLockPath(HOME))).toBe(host.text(homeLockPath(HOME)));

    // After the release, the next runtime takes the folder.
    await held.lock.release();
    expect(host.text(homeLockPath(HOME))).toBeNull();
    const again = await holdHome(HOME, host.ports);
    expect(again.recovered).toBeUndefined();
  });

  it("takes the lock of a runtime that stopped, and tells why the old lock went", async () => {
    // The process 300 wrote the lock and stopped: the fake host has no such live process.
    const host = fakeHost({ files: { [homeLockPath(HOME)]: lockText({ pid: 300, startedAt: 5 }) } });
    const held = await holdHome(HOME, host.ports);
    expect(held.recovered).toBeDefined();
    expect(host.text(homeLockPath(HOME))).toBe(lockText({ pid: 100, startedAt: host.ports.self.startedAt }));
  });

  it("refuses the start when the file system fails, with no path of the folder in the message", async () => {
    const host = fakeHost();
    host.failFiles = () => true;
    const refused = await refusal(holdHome(HOME, host.ports));
    expect(refused.owner).toBeUndefined();
    expect(refused.message).toContain(`cannot take the lock ${HOME_LOCK_FILE}`);
    expect(refused.message).not.toContain(HOME);
  });

  it("refuses a second take of the same live process on a real folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "alerts-home-lock-"));
    try {
      const ports = nodeHostPorts();
      const held = await holdHome(home, ports);
      const refused = await refusal(holdHome(home, ports));
      expect(refused.owner).toBe(process.pid);
      await held.lock.release();
      expect(await readdir(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

// The folder of the package: the entry starts from it, as under the supervisor.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** This function starts the entry of the runtime with no mode, and gives its exit code and its error output. */
function startEntry(home: string): Promise<{ code: number | null; stderr: string }> {
  // The entry gets only this temporary folder. No variable of the test process names another home folder or config file.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ALERTS_") && !["SERVICE_PROFILE", "PORT", "PROBE_PORT"].includes(key)));
  const child = spawn(process.execPath, [join("src", "main.ts")], {
    cwd: ROOT,
    env: { ...env, ALERTS_HOME: home, SERVICE_PROFILE: "local", PORT: "0", PROBE_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    // A runtime that does not stop at the lock is a fault of the gate. The test stops it and fails.
    const limit = setTimeout(() => {
      child.kill();
      reject(new Error(`The second runtime did not stop at the lock:\n${stderr}`));
    }, 60_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(limit);
      resolve({ code, stderr });
    });
  });
}

describe("the start of a second runtime (AL-58)", () => {
  it("stops before it reads or writes a file of a home folder that a live runtime holds", async () => {
    const home = await mkdtemp(join(tmpdir(), "alerts-home-held-"));
    try {
      // This test process is the live runtime of the folder.
      const held = await holdHome(home, nodeHostPorts());
      const { code, stderr } = await startEntry(home);
      expect(code).not.toBe(0);
      expect(stderr).toContain(`The process ${String(process.pid)} holds the lock ${HOME_LOCK_FILE} of the home folder`);
      // The second runtime wrote no event log, no store and no last good set.
      expect(await readdir(home)).toEqual([HOME_LOCK_FILE]);
      await held.lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 90_000);
});
