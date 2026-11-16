import type { HealthState } from "@mark1russell7/alerts";
import { DELIVERY_TIMES, overdueLimit, SOURCE_POLICY } from "@mark1russell7/alerts-runtime";
import { CANARY_PATH, checkCanary, readAnswer, WEA_PATH } from "@mark1russell7/alerts-source-nws-api";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import { caseBodies, MAIN_PATH } from "./nws.ts";
import {
  CASE_5_ORIGIN,
  CASE_5_SETTINGS,
  canaryAnswer,
  caseClock,
  caseDeliveryTimes,
  caseTransport,
  DOWN_ARMS,
  type DownArm,
  type DownPass,
  type DownRecord,
  downGatesOf,
  downLimits,
  downVerdictOf,
  gatesRead,
  outageOf,
  planOf,
  REAL_CALL_FLOOR_MS,
  samplesOf,
  settingsProblems,
  windowFaultOf,
} from "./source-down.ts";

const MINUTE = 60_000;
const LIMITS = downLimits();

/** The passes of an arm: one each minute, with the state that `stateAt` gives for the minute. */
const passesOf = (stateAt: (minute: number) => HealthState, minutes = 80): DownPass[] =>
  Array.from({ length: minutes + 1 }, (_, minute) => ({ at: minute * MINUTE + 500, state: stateAt(minute), fetched: true }));

/** The record of an arm. In an arm with an outage, 20 requests fall in the window, and each stops at the proxy. */
const recordOf = (arm: DownArm, stateAt: (minute: number) => HealthState = () => "healthy", extra: Partial<DownRecord> = {}): DownRecord => {
  const outage = outageOf(arm);
  const inWindow = outage === undefined ? 0 : 20;
  return {
    arm,
    ...(outage === undefined ? {} : { outage }),
    passes: passesOf((minute) => (minute === 0 ? "unknown" : stateAt(minute))),
    requests: { sent: 320, inWindow, reached: 320 - inWindow },
    faults: inWindow,
    connections: 90,
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

  it("gives one fault of the outage window to each arm with an outage, and no fault to control", () => {
    expect(windowFaultOf("control")).toBeUndefined();
    expect(windowFaultOf("reset-long")).toEqual({ window: { from: 4.5 * MINUTE, to: 14.5 * MINUTE }, direction: "up", at: { byte: 0 }, kind: "reset" });
    expect(windowFaultOf("error-long")).toMatchObject({ direction: "up", at: { frame: 0 }, kind: "answer", status: 500 });
    expect(windowFaultOf("unavailable-long")).toMatchObject({ kind: "answer", status: 503 });
    expect(planOf("control")).toEqual({ format: "rigor-faults/1", seed: null, faults: [] });
    expect(planOf("reset-short")).toEqual({ format: "rigor-faults/2", seed: null, faults: [], windows: [windowFaultOf("reset-short")] });
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
  });
});

describe("caseTransport", () => {
  const exchange = (path: string): Exchange => ({ method: "GET", url: `${CASE_5_ORIGIN}${path}`, headers: {}, body: null });
  const reply = (status: number): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: {}, body: "{}" });

  it("sends each request to the proxy, records its time, and gives the keepalive of its time to a canary reply of 200", async () => {
    const urls: string[] = [];
    let status = 200;
    const inner: Transport = async (one) => {
      urls.push(one.url);
      return reply(status);
    };
    let now = 0;
    const sent: number[] = [];
    const canary = (at: number): Reply => ({ ...reply(200), body: String(at) });
    const transport = caseTransport({ inner, clock: { now: () => now }, proxy: "http://127.0.0.1:2", canary, sent });
    expect((await transport(exchange(MAIN_PATH), undefined)).body).toBe("{}");
    now = 10;
    expect((await transport(exchange(CANARY_PATH), undefined)).body).toBe("10");
    now = 20;
    status = 503;
    expect((await transport(exchange(CANARY_PATH), undefined)).status).toBe(503);
    await transport(exchange(WEA_PATH), undefined);
    expect(urls).toEqual([`http://127.0.0.1:2${MAIN_PATH}`, `http://127.0.0.1:2${CANARY_PATH}`, `http://127.0.0.1:2${CANARY_PATH}`, `http://127.0.0.1:2${WEA_PATH}`]);
    expect(sent).toEqual([0, 10, 20, 20]);
    await expect(transport({ ...exchange(MAIN_PATH), url: `https://api.weather.gov${MAIN_PATH}` }, undefined)).rejects.toThrow(TypeError);
    expect(sent).toHaveLength(4);
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

describe("caseDeliveryTimes", () => {
  it("keeps the times of production while the call limit gets the floor of real time", () => {
    expect(caseDeliveryTimes(1)).toBe(DELIVERY_TIMES);
    expect(caseDeliveryTimes(DELIVERY_TIMES.callLimit / REAL_CALL_FLOOR_MS)).toBe(DELIVERY_TIMES);
  });

  it("gives each call the floor of real time on a fast clock, and keeps the relations of production", () => {
    const pass = DELIVERY_TIMES.overdueAfter - overdueLimit({ passLimit: 0, flightLimit: DELIVERY_TIMES.flightLimit, retry: DELIVERY_TIMES.retry });
    for (const speed of [1, 10, 11, 30, 60, 120]) {
      const times = caseDeliveryTimes(speed);
      expect(times.callLimit / speed).toBeGreaterThanOrEqual(REAL_CALL_FLOOR_MS);
      expect(times.callLimit).toBeGreaterThanOrEqual(DELIVERY_TIMES.callLimit);
      expect(times.flightLimit).toBe(2 * times.callLimit);
      expect(times.overdueAfter).toBe(overdueLimit({ passLimit: pass, flightLimit: times.flightLimit, retry: times.retry }));
      expect({ pollEvery: times.pollEvery, retry: times.retry }).toEqual({ pollEvery: DELIVERY_TIMES.pollEvery, retry: DELIVERY_TIMES.retry });
    }
    // Case 9 has the speed 30. Its call limit of production is 333 ms of real time.
    expect(caseDeliveryTimes(30)).toMatchObject({ callLimit: 30_000, flightLimit: 60_000 });
  });
});

describe("samplesOf", () => {
  it("gives one sample for each pass, up when the coverage counts its state", () => {
    const record = recordOf("control", (minute) => (minute === 1 ? "slow" : minute === 2 ? "failing" : "healthy"));
    expect(samplesOf(record).slice(0, 4)).toEqual([
      { at: 500, up: false },
      { at: MINUTE + 500, up: true },
      { at: 2 * MINUTE + 500, up: false },
      { at: 3 * MINUTE + 500, up: true },
    ]);
  });
});

describe("downGatesOf", () => {
  it("passes both gates when the health goes down in the outage and comes up soon after it", () => {
    const result = downGatesOf(recordOf("reset-short", outageHealth("reset-short", 1)), LIMITS);
    expect(result).toMatchObject({ detected: "pass", recovered: "pass", problems: [] });
    // The outage is from 4.5 to 7.5 minutes. The passes at 7:00.5 and 9:00.5 are the first down and the first up after it.
    expect(result.detectMs).toBe(2.5 * MINUTE + 500);
    expect(result.recoverMs).toBe(1.5 * MINUTE + 500);
  });

  it("fails recovered when the health comes up after the limit, as after a stop of the host for 60 minutes", () => {
    const result = downGatesOf(recordOf("reset-long", outageHealth("reset-long", 55)), LIMITS);
    expect(result).toMatchObject({ detected: "pass", recovered: "fail" });
    expect(result.problems.join("\n")).toContain(`reset-long: The signal came up after ${String(55.5 * MINUTE + 500)} ms, not in 420000 ms`);
  });

  it("fails detected when the health stays up, and has no read of recovered after it", () => {
    expect(downGatesOf(recordOf("error-long"), LIMITS)).toMatchObject({ detected: "fail", recovered: "no read" });
  });

  it("has no read when the samples end before the limit, and for an arm with no outage", () => {
    const short = recordOf("reset-short", outageHealth("reset-short", 1));
    expect(downGatesOf({ ...short, passes: short.passes.slice(0, 7) }, LIMITS)).toMatchObject({ detected: "no read", recovered: "no read" });
    expect(downGatesOf({ ...short, passes: short.passes.slice(0, 9) }, LIMITS)).toMatchObject({ detected: "pass", recovered: "no read" });
    expect(downGatesOf(recordOf("control"), LIMITS)).toEqual({ detected: "no read", recovered: "no read", problems: ["control: the arm has no outage."] });
  });
});

describe("gatesRead", () => {
  it("reads gates that pass or fail, and a fail of detected with no read of recovered", () => {
    expect(gatesRead({ detected: "pass", recovered: "pass", problems: [] })).toBe(true);
    expect(gatesRead({ detected: "pass", recovered: "fail", problems: [] })).toBe(true);
    expect(gatesRead({ detected: "fail", recovered: "no read", problems: [] })).toBe(true);
  });

  it("does not read a missing result, or a gate with no read that the samples did not decide", () => {
    expect(gatesRead(undefined)).toBe(false);
    expect(gatesRead({ detected: "no read", recovered: "no read", problems: [] })).toBe(false);
    expect(gatesRead({ detected: "pass", recovered: "no read", problems: [] })).toBe(false);
  });
});

describe("downVerdictOf", () => {
  const good = (arm: DownArm): DownRecord => recordOf(arm, outageHealth(arm, 1));
  const records = (change: (arm: DownArm) => DownRecord = good) => DOWN_ARMS.map(change);
  const only = (arm: DownArm, change: (record: DownRecord) => DownRecord) => records((one) => (one === arm ? change(good(one)) : good(one)));

  it("reads and passes when each arm detects its outage and recovers in the limit", () => {
    expect(downVerdictOf(records())).toMatchObject({ read: true, pass: true, problems: [] });
  });

  it("reads and fails when a long outage stops the host past the limit", () => {
    const verdict = downVerdictOf(records((arm) => (arm === "reset-long" || arm === "error-long" ? recordOf(arm, outageHealth(arm, 55)) : good(arm))));
    expect(verdict.read).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.results["reset-long"]).toMatchObject({ detected: "pass", recovered: "fail" });
    expect(verdict.results["unavailable-long"]).toMatchObject({ detected: "pass", recovered: "pass" });
  });

  it("reads and fails when the health of an arm does not go down in its outage", () => {
    const verdict = downVerdictOf(only("unavailable-long", (record) => recordOf(record.arm)));
    expect(verdict).toMatchObject({ read: true, pass: false });
    expect(verdict.results["unavailable-long"]).toMatchObject({ detected: "fail", recovered: "no read" });
  });

  it("cannot read when the control arm goes down, or an arm is down before its outage", () => {
    expect(downVerdictOf(only("control", () => recordOf("control", (minute) => (minute === 30 ? "failing" : "healthy")))).read).toBe(false);
    expect(downVerdictOf(only("reset-short", () => recordOf("reset-short", (minute) => (minute === 2 ? "failing" : "healthy")))).read).toBe(false);
  });

  it("cannot read when a request of the window got to the server, or a request out of it did not", () => {
    expect(downVerdictOf(only("error-long", (record) => ({ ...record, requests: { ...record.requests, reached: record.requests.reached + 1 } }))).read).toBe(false);
    expect(downVerdictOf(only("error-long", (record) => ({ ...record, requests: { ...record.requests, reached: record.requests.reached - 1 } }))).read).toBe(false);
  });

  it("cannot read when the proxy has no fault, control has a fault, or no request falls in the window", () => {
    expect(downVerdictOf(only("error-long", (record) => ({ ...record, faults: 0, requests: { ...record.requests, reached: 320 } }))).read).toBe(false);
    expect(downVerdictOf(only("control", (record) => ({ ...record, faults: 1, requests: { ...record.requests, reached: 319 } }))).read).toBe(false);
    expect(downVerdictOf(only("reset-short", (record) => ({ ...record, faults: 0, requests: { sent: 320, inWindow: 0, reached: 320 } }))).read).toBe(false);
  });

  it("cannot read when a pass threw or the passes end early", () => {
    expect(downVerdictOf(only("control", (record) => ({ ...record, error: "boom" }))).read).toBe(false);
    expect(downVerdictOf(only("control", (record) => ({ ...record, passes: record.passes.slice(0, 40) }))).read).toBe(false);
  });

  it("cannot read with a missing arm, or with settings that do not separate the outages", () => {
    expect(downVerdictOf(records().slice(1)).read).toBe(false);
    expect(downVerdictOf(records(), { ...CASE_5_SETTINGS, longMs: 4 * MINUTE }).read).toBe(false);
  });
});
