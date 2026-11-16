import { join, resolve } from "node:path";
import { valueIn } from "@mark1russell7/quantity";
import { groupProblems, renderSystemdUnit, renderTaskXml, serviceProblems, superviseGroup } from "@mark1russell7/service/host";
import { fakeHost } from "@mark1russell7/service/testing";
import { describe, expect, it } from "vitest";
import {
  declareSupervisor,
  discoveryPid,
  HOST_PORTS,
  hostFolder,
  hostGroup,
  hostTask,
  READY_WITHIN,
  readinessProbe,
  RUNTIME_GRACE,
  RUNTIME_PROFILE,
  RUNTIME_PROGRAM,
  runtimeDiscovery,
  shutdownCap,
  SUPERVISOR_GRACE,
  SUPERVISOR_PROFILE,
  supervisorDiscovery,
  supervisorHome,
} from "./host.ts";
import { STOP_MESSAGE } from "./index.ts";
import { INSTANCE_TIMES } from "./instance.ts";

// A folder of the private files with no user name in it.
const HOME = join("/var/lib", "alerts");
const ROOT = join("/srv/alerts", "packages", "runtime");
const NODE = "/usr/bin/node";
const OPTIONS = { home: HOME, root: ROOT, node: NODE };
const PROBES = `http://127.0.0.1:${HOST_PORTS.probePort}`;

const msOf = (amount: { value: number; unit: string }): number => valueIn(amount, "ms");
const capOf = (phases: readonly { name: string; cap: { value: number; unit: string } }[], name: string): number => msOf(phases.find((phase) => phase.name === name)!.cap);

/** This function starts the group on a fake host whose runtime answers each probe. */
async function started() {
  const host = fakeHost({ platform: "win32" });
  // A polite child ends at a staged stop, as the runtime does after its drain.
  host.polite = true;
  host.http.set(`${PROBES}/readiness`, 200);
  host.http.set(`${PROBES}/liveness`, 200);
  const group = superviseGroup(hostGroup(OPTIONS), host.ports, { random: () => 0 });
  group.start();
  await host.settle();
  await host.clock.advance(1000);
  await host.settle();
  return { host, group };
}

/** This function moves the fake clock in steps of one second. */
async function pass(host: Awaited<ReturnType<typeof started>>["host"], seconds: number): Promise<void> {
  for (let step = 0; step < seconds; step++) {
    await host.clock.advance(1000);
    await host.settle();
  }
}

describe("the host of the instance", () => {
  it("resolves the folder argument of the supervisor as the runtime resolves ALERTS_HOME", () => {
    const user = join("/home", "owner");
    const base = join("/srv", "console");
    // The folder is absolute. On Windows, it starts with the drive of the base.
    expect(supervisorHome("~/private", base, user)).toBe(resolve(user, "private"));
    expect(supervisorHome("./private", base, user)).toBe(resolve(base, "private"));
    expect(supervisorHome(HOME, base, user)).toBe(resolve(HOME));
    expect(() => supervisorHome("", base, user)).toThrow("The supervisor needs one argument: the folder of the private files.");
    expect(() => supervisorHome(undefined, base, user)).toThrow("The supervisor needs one argument: the folder of the private files.");
  });

  it("gives the install the readiness probe and the ready wait of the supervisor", () => {
    const ready = hostGroup(OPTIONS).programs[0]?.ready;
    expect(readinessProbe()).toEqual({ kind: "http", url: `${PROBES}/readiness` });
    expect(ready?.probe).toEqual(readinessProbe());
    expect(ready?.within).toEqual(READY_WITHIN);
  });

  it("gives a group and a boot task with no problems", () => {
    expect(groupProblems(hostGroup(OPTIONS))).toEqual([]);
    expect(serviceProblems(hostTask(OPTIONS))).toEqual([]);
  });

  it("gives the runtime a stop grace that holds its longest shutdown, and the supervisor a stop that holds the grace", () => {
    // The drain holds one whole pass. Thus a stop does not cut a send.
    expect(capOf(RUNTIME_PROFILE.phases ?? [], "drain")).toBeGreaterThanOrEqual(INSTANCE_TIMES.passLimit);
    expect(msOf(RUNTIME_GRACE)).toBeGreaterThan(msOf(shutdownCap(RUNTIME_PROFILE)));
    const description = declareSupervisor({ start: () => undefined, stop: async () => undefined }).describe();
    expect(description.dependencies.map((dependency) => dependency.name)).toEqual(["group"]);
    expect(capOf(description.shutdown.phases, "tear down dependencies")).toBeGreaterThan(msOf(RUNTIME_GRACE));
  });

  it("starts the runtime with the folder, the ports, the daemon profile and an IPC channel", async () => {
    const { host, group } = await started();
    expect(host.children).toHaveLength(1);
    const { request } = host.children[0]!;
    expect(request).toMatchObject({ program: NODE, args: ["src/main.ts"], cwd: ROOT, ipc: true });
    expect(request.env).toMatchObject({ ALERTS_HOME: HOME, PORT: String(HOST_PORTS.port), PROBE_PORT: String(HOST_PORTS.probePort), SERVICE_PROFILE: "daemon" });
    expect(group.states()[0]).toMatchObject({ name: "runtime", phase: "ready", restarts: 0 });
    await group.stop();
  });

  it("stops the runtime with the message that the runtime matches", async () => {
    const { host, group } = await started();
    const child = host.children[0]!;
    await group.stop();
    expect(child.sent).toEqual([STOP_MESSAGE]);
    expect(child.ended).toBe(true);
    // The staged stop ended the runtime in its grace. Thus the supervisor did not stop the process tree.
    expect(host.commands.filter((command) => command.args.includes("/F"))).toEqual([]);
  });

  it("starts the runtime again after 3 failed liveness probes in sequence", async () => {
    const { host, group } = await started();
    const first = host.children[0]!;
    host.http.set(`${PROBES}/liveness`, 503);
    // Two failures do not stop the runtime.
    await pass(host, 20);
    expect(first.ended).toBe(false);
    // The third failure stops it in stages, and the supervisor starts it again after the backoff.
    await pass(host, 20);
    expect(first.sent).toEqual([STOP_MESSAGE]);
    expect(first.ended).toBe(true);
    host.http.set(`${PROBES}/liveness`, 200);
    await pass(host, 30);
    expect(host.children).toHaveLength(2);
    expect(group.states()[0]).toMatchObject({ phase: "ready", restarts: 1 });
    await group.stop();
  });

  it("gives a boot task that starts the supervisor with the folder of the private files, and starts it again 1 minute after a stop", () => {
    const spec = hostTask(OPTIONS);
    expect(spec.args).toEqual([join(ROOT, "src", "main.ts"), "supervise", HOME]);
    expect(supervisorDiscovery(HOME)).toBe(join(HOME, "host", "supervisor.json"));
    const xml = renderTaskXml(spec, { user: "HOST\\test", conhost: "C:\\Windows\\System32\\conhost.exe" });
    expect(xml).toContain("<BootTrigger>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("S4U");
  });

  it("gives a systemd unit in which only the supervisor gets the stop signal, with a stop grace that holds its longest shutdown", () => {
    const spec = hostTask(OPTIONS);
    expect(spec.stopsChildren).toBe(true);
    expect(msOf(SUPERVISOR_GRACE)).toBeGreaterThan(msOf(shutdownCap(SUPERVISOR_PROFILE)));
    // The longest shutdown of the supervisor holds the stop grace of the runtime.
    expect(msOf(shutdownCap(SUPERVISOR_PROFILE))).toBeGreaterThan(msOf(RUNTIME_GRACE));
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain(`TimeoutStopSec=${Math.ceil(msOf(SUPERVISOR_GRACE) / 1000)}`);
    expect(unit).toContain("Restart=always");
  });
});

describe("the discovery file of the runtime", () => {
  it("is the file of the runtime program in the folder of the host", () => {
    expect(hostGroup(OPTIONS).programs.map((program) => program.name)).toEqual([RUNTIME_PROGRAM]);
    expect(runtimeDiscovery(HOME)).toBe(join(hostFolder(HOME), `${RUNTIME_PROGRAM}.json`));
  });

  it("gives the process ID of a discovery file, and no ID for a file with no process", () => {
    expect(discoveryPid({ text: JSON.stringify({ pid: 4242, startedAt: "2026-11-16T07:00:00Z", port: 4750 }) })).toBe(4242);
    expect(discoveryPid({ code: "ENOENT" })).toBeUndefined();
    expect(discoveryPid({ text: "{" })).toBeUndefined();
    expect(discoveryPid({ text: "null" })).toBeUndefined();
    for (const pid of [0, -1, 1.5, "4242", Number.MAX_SAFE_INTEGER + 1]) expect(discoveryPid({ text: JSON.stringify({ pid }) })).toBeUndefined();
  });
});
