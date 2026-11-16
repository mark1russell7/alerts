import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { embeddedProcess, lint, localDev } from "@mark1russell7/service";
import type { Rule, Scenario } from "@mark1russell7/service";
import { realClock, wallClock } from "@mark1russell7/algebra/clock";
import { MAP_FORMAT, type MapPayload, type SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { PROFILES, STOP_MESSAGE, createLoop, declare, type Pass, type Status } from "./index.ts";

const s = (value: number) => ({ value, unit: "s" });

// The caller of lint() gives the rules of the ordering law, as data. These are the drain rules O10 and O16, as @mark1russell7/kind gives them.
const O10: Rule = {
  id: "O10",
  rule: "the preStop sleep plus the shutdown of the process fits in the grace period",
  expr: {
    lhs: {
      terms: [
        { knob: "prestop_sleep", coef: 1, at: "pod" },
        { knob: "process_drain_time", coef: 1, at: "process" },
      ],
    },
    op: "<=",
    rhs: { terms: [{ knob: "termination_grace", coef: 1, at: "pod" }] },
  },
};
const O16: Rule = {
  id: "O16",
  rule: "the cooperative window is shorter than the drain, which is shorter than the grace less the preStop sleep",
  expr: {
    lhs: { terms: [{ knob: "cooperative_window", coef: 1, at: "process" }] },
    op: "<",
    rhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
  },
  expr_more: [
    {
      lhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
      op: "<",
      rhs: {
        terms: [
          { knob: "termination_grace", coef: 1, at: "pod" },
          { knob: "prestop_sleep", coef: -1, at: "pod" },
        ],
      },
    },
  ],
};

// A pod with the default grace of Kubernetes (30 s) and no preStop hook
const POD: Scenario = {
  platform: { "termination_grace@pod": s(30), "prestop_sleep@pod": s(0) },
  probes: { readiness: s(30), liveness: s(30) },
};

/** This function gives a loop whose passes fetch one source and wake one minute later. */
const loopOf = () => {
  const wall = wallClock();
  return createLoop({
    clock: realClock,
    wall,
    times: { passLimit: 1000, retryBase: 1000, retryCap: 1000 },
    pass: async (): Promise<Pass> => ({ at: wall.now(), fetched: ["nws-api" as SourceId], view: {} as Pass["view"], conflicts: [], wakeAt: wall.now() + 60_000 }),
  });
};

// A map before the first pass: no incident, no place and no region.
const EMPTY_MAP: MapPayload = { format: MAP_FORMAT, at: null, view: { incidents: [], places: [], unshaped: [] }, basemap: [] };

/** This function gives a free TCP port of the loopback interface. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe("the declaration of the service", () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    it(`passes describe() and lint() with the profile ${name}`, () => {
      // describe() throws when the declaration lacks a policy, the startup budget, the phases or the effect of a second signal
      const description = declare({ port: 0, probePort: 0, profile, loop: loopOf(), log: { close: () => undefined } }).describe();
      expect(description.dependencies.map((dependency) => dependency.name)).toEqual(["log", "shapes", "quotas"]);
      expect(description.transports.map((transport) => [transport.kind, transport.name])).toEqual([
        ["server", "http"],
        ["worker", "passes"],
      ]);
      expect(description.checks.map((check) => [check.name, check.gates])).toEqual([["passes.progress", "liveness"]]);
      // A supervisor on Windows stops the service with a message, because the process cannot catch its signal.
      expect(description.shutdown.messages).toEqual([{ match: STOP_MESSAGE, as: "SIGTERM" }]);
      // each rule holds, and no field of the declaration is missing (a "depends" finding of the rule "declaration")
      const findings = lint(description, POD, [O10, O16]);
      expect(findings.map((finding) => [finding.rule, finding.verdict])).toEqual([
        ["O10", "holds"],
        ["O16", "holds"],
        ["unit-bound", "holds"],
        ["close-bound", "holds"],
      ]);
    });
  }

  it("declares the route GET /map only with a function of the map", () => {
    const routes = (map?: () => MapPayload) =>
      declare({ port: 0, probePort: 0, profile: localDev, loop: loopOf(), log: { close: () => undefined }, map })
        .describe()
        .controllers.map((controller) => [controller.name, Object.keys(controller.routes)]);
    expect(routes()).toEqual([["api", ["GET /status"]]]);
    expect(routes(() => EMPTY_MAP)).toEqual([["api", ["GET /status", "GET /map"]]]);
  });
});

describe("the lifecycle of the service", () => {
  it("runs the passes, answers the status and the probes, and exits 0 after the shutdown", async () => {
    const port = await freePort();
    const probePort = await freePort();
    // embeddedProcess() adds no signal handler and does not end the process of the test
    const loop = loopOf();
    let closes = 0;
    const log = { close: () => (closes += 1) };
    const life = await declare({ port, probePort, profile: localDev, loop, log, map: () => EMPTY_MAP }).run({ process: embeddedProcess() });
    try {
      // The worker starts the first pass at the start of the service.
      for (let tries = 0; loop.last() === undefined && tries < 100; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      const status = await fetch(`http://127.0.0.1:${port}/status`);
      expect(status.status).toBe(200);
      const body = (await status.json()) as Status;
      expect(body).toEqual({ at: loop.last()?.at, wakeAt: loop.last()?.wakeAt, fetched: ["nws-api"], sent: 0, conflicts: 0, stuck: null });
      const map = await fetch(`http://127.0.0.1:${port}/map`);
      expect(map.status).toBe(200);
      expect(await map.json()).toEqual(EMPTY_MAP);
      expect((await fetch(`http://127.0.0.1:${port}/hello`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${probePort}/readiness`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${probePort}/liveness`)).status).toBe(200);
      // The log stays open while the service operates.
      expect(closes).toBe(0);
    } finally {
      await life.shutdown("the test ended");
    }
    expect(await life.done).toBe(0);
    expect(life.errors).toEqual([]);
    expect(closes).toBe(1);
  });
});
