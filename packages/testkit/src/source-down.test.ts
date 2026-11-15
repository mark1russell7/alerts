import type { HealthState } from "@mark1russell7/alerts";
import { SOURCE_POLICY } from "@mark1russell7/alerts-runtime";
import { CANARY_PATH, checkCanary, readAnswer, WEA_PATH } from "@mark1russell7/alerts-source-nws-api";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import { caseBodies, MAIN_PATH } from "./nws.ts";
import {
  CASE_5_ORIGIN,
  CASE_5_SETTINGS,
  canaryAnswer,
  caseClock,
  DOWN_ARMS,
  type DownArm,
  type DownPass,
  type DownRecord,
  downGatesOf,
  downLimits,
  downVerdictOf,
  faultsOf,
  outageOf,
  outageTransport,
  type RouteCounts,
  settingsProblems,
} from "./source-down.ts";

const MINUTE = 60_000;
const LIMITS = downLimits();

/** The passes of an arm: one each minute, with the state that `stateAt` gives for the minute. */
const passesOf = (stateAt: (minute: number) => HealthState, minutes = 80): DownPass[] =>
  Array.from({ length: minutes + 1 }, (_, minute) => ({ at: minute * MINUTE + 500, state: stateAt(minute), fetched: true }));

const recordOf = (arm: DownArm, stateAt: (minute: number) => HealthState = () => "healthy", extra: Partial<DownRecord> = {}): DownRecord => {
  const outage = outageOf(arm);
  return {
    arm,
    ...(outage === undefined ? {} : { outage }),
    passes: passesOf((minute) => (minute === 0 ? "unknown" : stateAt(minute))),
    requests: { direct: 240, faulty: outage === undefined ? 0 : 6, canary: 80 },
    faults: outage === undefined ? 0 : 6,
    leaked: 0,
    ...extra,
  };
};

/** The health of an arm that goes down 2 minutes after the outage starts, and comes up `lag` minutes after it ends. */
const outageHealth =
  (arm: DownArm, lag: number) =>
  (minute: number): HealthState => {
    const outage = outageOf(arm);
    if (outage === undefined) return "healthy";
    const at = minute * MINUTE + 500;
    return at >= outage.from + 2 * MINUTE && at < outage.to + lag * MINUTE ? "failing" : "healthy";
  };

describe("the plan of the case", () => {
  it("gives a window of 3 minutes to reset-short and of 10 minutes to each other outage, from 4.5 minutes", () => {
    expect(outageOf("control")).toBeUndefined();
    expect(outageOf("reset-short")).toEqual({ from: 4.5 * MINUTE, to: 7.5 * MINUTE });
    expect(outageOf("error-long")).toEqual({ from: 4.5 * MINUTE, to: 14.5 * MINUTE });
  });

  it("gives one fault at the start of each connection of the plan", () => {
    expect(faultsOf("control")).toEqual([]);
    const resets = faultsOf("reset-long");
    expect(resets).toHaveLength(CASE_5_SETTINGS.connections);
    expect(resets[3]).toEqual({ connection: 3, direction: "up", at: { byte: 0 }, kind: "reset" });
    expect(faultsOf("error-long")[0]).toEqual({ connection: 0, direction: "up", at: { frame: 0 }, kind: "answer", status: 500 });
    expect(faultsOf("unavailable-long")[63]).toMatchObject({ connection: 63, kind: "answer", status: 503 });
  });

  it("takes the limits from the default policy of polite-crawler and the interval of the source", () => {
    expect(LIMITS).toEqual({ intervalMs: MINUTE, detectMs: 3 * MINUTE, recoverMs: SOURCE_POLICY.backoffCapMs + 2 * MINUTE, stopAfter: SOURCE_POLICY.maxFailures });
    expect(LIMITS.recoverMs).toBe(7 * MINUTE);
  });

  it("finds no problem in the settings of CI, and a problem in settings that do not separate the outages", () => {
    expect(settingsProblems(CASE_5_SETTINGS)).toEqual([]);
    expect(settingsProblems({ ...CASE_5_SETTINGS, shortMs: 4 * MINUTE })).toHaveLength(1);
    expect(settingsProblems({ ...CASE_5_SETTINGS, longMs: 5 * MINUTE })).toHaveLength(1);
    expect(settingsProblems({ ...CASE_5_SETTINGS, armMs: 20 * MINUTE })).toHaveLength(1);
    expect(settingsProblems({ ...CASE_5_SETTINGS, outageAtMs: MINUTE })).toHaveLength(1);
    expect(settingsProblems({ ...CASE_5_SETTINGS, connections: 8 })).toHaveLength(1);
  });
});

describe("outageTransport", () => {
  const exchange = (path: string): Exchange => ({ method: "GET", url: `${CASE_5_ORIGIN}${path}`, headers: {}, body: null });
  const reply: Reply = { status: 200, statusText: "OK", headers: {}, body: "{}" };

  it("sends each request to the proxy in the window, and answers the canary itself out of the window", async () => {
    const sent: string[] = [];
    const inner: Transport = async (one) => {
      sent.push(one.url);
      return reply;
    };
    let now = 0;
    const counts: RouteCounts = { direct: 0, faulty: 0, canary: 0 };
    const canary = (at: number): Reply => ({ ...reply, body: String(at) });
    const transport = outageTransport({ inner, clock: { now: () => now }, outage: { from: 10, to: 20 }, direct: "http://127.0.0.1:1", faulty: "http://127.0.0.1:2", canary, counts });
    await transport(exchange(MAIN_PATH), undefined);
    expect((await transport(exchange(CANARY_PATH), undefined)).body).toBe("0");
    now = 10;
    await transport(exchange(MAIN_PATH), undefined);
    await transport(exchange(CANARY_PATH), undefined);
    now = 20;
    await transport(exchange(WEA_PATH), undefined);
    expect(sent).toEqual([`http://127.0.0.1:1${MAIN_PATH}`, `http://127.0.0.1:2${MAIN_PATH}`, `http://127.0.0.1:2${CANARY_PATH}`, `http://127.0.0.1:1${WEA_PATH}`]);
    expect(counts).toEqual({ direct: 2, faulty: 2, canary: 1 });
    await expect(transport({ ...exchange(MAIN_PATH), url: `https://api.weather.gov${MAIN_PATH}` }, undefined)).rejects.toThrow(TypeError);
  });
});

describe("canaryAnswer", () => {
  it("gives a keepalive that the canary check of the source passes at each time", () => {
    const answer = canaryAnswer(caseBodies());
    for (const at of [Date.UTC(2026, 10, 15), Date.UTC(2026, 10, 15, 1, 20)]) {
      const read = readAnswer(answer(at), `${CASE_5_ORIGIN}${CANARY_PATH}`, at, 0);
      expect(read?.complete).toBe(true);
      expect(checkCanary(read?.observations ?? [])).toMatchObject({ pass: true });
    }
  });
});

describe("caseClock", () => {
  it("moves faster than real time, ends a wait at an abort, and refuses a speed of 0", async () => {
    const clock = caseClock(1_000_000, 1000);
    const started = clock.now();
    await clock.sleep(2000);
    expect(clock.now() - started).toBeGreaterThanOrEqual(2000);
    const fired = await new Promise<number>((resolve) => clock.after(3000, () => resolve(clock.now())));
    expect(fired - started).toBeGreaterThanOrEqual(5000);
    const aborted = new AbortController();
    aborted.abort();
    await expect(clock.sleep(60 * MINUTE, aborted.signal)).resolves.toBeUndefined();
    expect(() => caseClock(0, 0)).toThrow(RangeError);
  });

  it("never ends a wait or a timer before its time on the clock, at a speed where each timer is near 1 ms", async () => {
    const clock = caseClock(0, 1000);
    for (let wait = 0; wait < 20; wait += 1) {
      const from = clock.now();
      await clock.sleep(1500);
      expect(clock.now() - from).toBeGreaterThanOrEqual(1500);
      const fired = await new Promise<number>((resolve) => clock.after(700, () => resolve(clock.now())));
      expect(fired - from).toBeGreaterThanOrEqual(2200);
    }
  });

  it("fires a timer of 0 ms after the call of after, not in it", async () => {
    const clock = caseClock(0, 1000);
    let fired = false;
    const fires = new Promise<void>((resolve) =>
      clock.after(0, () => {
        fired = true;
        resolve();
      }),
    );
    expect(fired).toBe(false);
    await fires;
    expect(fired).toBe(true);
  });

  it("stops a timer with the function that after gives", async () => {
    const clock = caseClock(0, 1000);
    let fired = false;
    const cancel = clock.after(1000, () => {
      fired = true;
    });
    cancel();
    await clock.sleep(5000);
    expect(fired).toBe(false);
  });
});

describe("downGatesOf", () => {
  it("passes both gates when the health goes down in the outage and comes up soon after it", () => {
    const result = downGatesOf(recordOf("reset-short", outageHealth("reset-short", 1)), LIMITS);
    expect(result.gates).toEqual({ detected: true, recovers: true });
    // The outage is from 4.5 to 7.5 minutes. The passes at 7:00.5 and 9:00.5 are the first down and the first up after it.
    expect(result.detectedAfterMs).toBe(2.5 * MINUTE + 500);
    expect(result.recoveredAfterMs).toBe(1.5 * MINUTE + 500);
  });

  it("fails recovers when the health comes up after the limit, as after a stop of the host for 60 minutes", () => {
    const result = downGatesOf(recordOf("reset-long", outageHealth("reset-long", 55)), LIMITS);
    expect(result.gates).toEqual({ detected: true, recovers: false });
    expect(result.problems.join("\n")).toContain("not in 7 min of the end of the outage");
  });

  it("fails detected when the health stays up, and both gates for an arm with no outage", () => {
    expect(downGatesOf(recordOf("error-long"), LIMITS).gates).toEqual({ detected: false, recovers: true });
    expect(downGatesOf(recordOf("control"), LIMITS).gates).toEqual({ detected: false, recovers: false });
  });
});

describe("downVerdictOf", () => {
  const good = (arm: DownArm): DownRecord => recordOf(arm, outageHealth(arm, 1));
  const records = (change: (arm: DownArm) => DownRecord = good) => DOWN_ARMS.map(change);

  it("reads and passes when each arm detects its outage and recovers in the limit", () => {
    expect(downVerdictOf(records())).toMatchObject({ read: true, pass: true, problems: [] });
  });

  it("reads and fails when a long outage stops the host past the limit", () => {
    const verdict = downVerdictOf(records((arm) => (arm === "reset-long" || arm === "error-long" ? recordOf(arm, outageHealth(arm, 55)) : good(arm))));
    expect(verdict.read).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.results["reset-long"]?.gates).toEqual({ detected: true, recovers: false });
    expect(verdict.results["unavailable-long"]?.gates).toEqual({ detected: true, recovers: true });
  });

  it("cannot read when the control arm goes down, or an arm is down before its outage", () => {
    expect(downVerdictOf(records((arm) => (arm === "control" ? recordOf(arm, (minute) => (minute === 30 ? "failing" : "healthy")) : good(arm)))).read).toBe(false);
    expect(downVerdictOf(records((arm) => (arm === "reset-short" ? recordOf(arm, (minute) => (minute === 2 ? "failing" : "healthy")) : good(arm)))).read).toBe(false);
  });

  it("cannot read when a request got past the proxy, the proxy has no fault, a pass threw or the passes end early", () => {
    expect(downVerdictOf(records((arm) => (arm === "error-long" ? { ...good(arm), leaked: 1 } : good(arm)))).read).toBe(false);
    expect(downVerdictOf(records((arm) => (arm === "error-long" ? { ...good(arm), faults: 0 } : good(arm)))).read).toBe(false);
    expect(downVerdictOf(records((arm) => (arm === "control" ? { ...good(arm), error: "boom" } : good(arm)))).read).toBe(false);
    expect(downVerdictOf(records((arm) => (arm === "control" ? { ...good(arm), passes: good(arm).passes.slice(0, 40) } : good(arm)))).read).toBe(false);
  });

  it("cannot read with a missing arm, or with settings that do not separate the outages", () => {
    expect(downVerdictOf(records().slice(1)).read).toBe(false);
    expect(downVerdictOf(records(), { ...CASE_5_SETTINGS, longMs: 4 * MINUTE }).read).toBe(false);
  });
});
