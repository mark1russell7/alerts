import { fakeWallClock } from "@mark1russell7/algebra/clock";
import {
  reportId,
  type ChannelDescriptor,
  type ChannelId,
  type ChannelProcedures,
  type DeliveryStatus,
  type EscalationPolicy,
  type Message,
  type Observation,
  type ObservationId,
  type PersonId,
  type PlaceId,
  type Receipt,
  type Recipient,
  type Report,
  type SendOutcome,
  type SourceId,
  type SourceProcedures,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import type { DeliveryOptions } from "./delivery.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openRuntime, type RuntimeOptions } from "./runtime.ts";
import { rebuild } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const API = "api" as SourceId;
const PUSHOVER = "pushover" as ChannelId;
const SMS = "sms" as ChannelId;
const PERSON = "person-1" as PersonId;

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

const LIFE_SAFETY: EscalationPolicy = {
  level: "life-safety",
  steps: [
    { channel: PUSHOVER, at: 0 },
    { channel: SMS, at: 5 * MINUTE },
  ],
  exhaustedAfter: 20 * MINUTE,
};
const RECIPIENT: Recipient = {
  watch: { person: PERSON, places: [KANSAS.id], rules: [] },
  policies: [LIFE_SAFETY],
  addresses: { pushover: { user: "fake-user" }, sms: { to: "fake-number" } },
};

// One tornado warning for Sedgwick County, issued at T0, for 45 minutes.
function warning(seen: Observation): Report {
  return {
    id: reportId({ source: API, key: "w1", sent: T0 }),
    source: API,
    origin: "nws",
    key: "w1",
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received: seen.fetched,
    expires: T0 + 45 * MINUTE,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning issued April 1 at 1:00PM CDT by NWS Wichita KS",
    instruction: "TAKE COVER NOW!",
    observation: seen.id,
    parameters: {},
  };
}

const SOURCE: SourceProcedures = {
  describe: () => ({
    id: API,
    title: "The source api",
    origins: ["nws"],
    dependsOn: ["provider:api"],
    uses: ["internet", "power"],
    kinds: ["met"],
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval: MINUTE,
    slowAfter: 10 * SECOND,
    auth: "none",
  }),
  fetch: async () => ({
    ok: true,
    observations: [{ id: "api:w1" as ObservationId, source: API, fetched: T0, contentType: "application/json", body: "{}", transport: { latency: 0 } }],
    complete: true,
  }),
  map: ({ observation }) => ({ reports: [warning(observation)], problems: [] }),
};

interface Calls {
  readonly send: Message[];
  readonly status: Receipt[];
  readonly cancel: Receipt[];
}

interface Script {
  /** A send that gives `undefined` accepts the message. */
  send?: (message: Message, count: number) => SendOutcome | undefined | Promise<SendOutcome>;
  status?: (receipt: Receipt) => DeliveryStatus;
  cancel?: (receipt: Receipt) => void | Promise<void>;
}

// A channel of the test. Its default send accepts each message with a new receipt.
function channel(id: ChannelId, ack: ChannelDescriptor["ack"], now: () => number, script: Script = {}): { readonly procedures: ChannelProcedures; readonly calls: Calls } {
  const calls: Calls = { send: [], status: [], cancel: [] };
  const procedures: ChannelProcedures = {
    describe: () => ({ id, title: id, dependsOn: [], uses: ["internet"], breaksThrough: true, repeats: ack === "poll", ack, maxTitle: 250, maxBody: 1024 }),
    send: async ({ message }) => {
      calls.send.push(message);
      return (await script.send?.(message, calls.send.length)) ?? { ok: true, receipt: { receipt: `${id}-${calls.send.length}` }, accepted: now() };
    },
    status: async ({ receipt }) => {
      calls.status.push(receipt);
      return script.status?.(receipt) ?? { state: "delivered", at: now() };
    },
    cancel: async ({ receipt }) => {
      calls.cancel.push(receipt);
      await script.cancel?.(receipt);
    },
  };
  return { procedures, calls };
}

const DELIVERY = { recipients: [RECIPIENT], pollEvery: 30 * SECOND, retry: 15 * SECOND, callLimit: 10 * SECOND, flightLimit: 40 * SECOND } as const;

// The microtasks and the callbacks of the promises end before this promise resolves.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function open(scripts: { readonly pushover?: Script; readonly sms?: Script } = {}, log: RuntimeLog = openRuntimeLog(":memory:"), clock = fakeWallClock(T0), extra: Partial<DeliveryOptions> = {}, wake?: () => void) {
  const pushover = channel(PUSHOVER, "poll", () => clock.now(), scripts.pushover);
  const sms = channel(SMS, "none", () => clock.now(), scripts.sms);
  const runtime = openRuntime({
    log,
    clock,
    sources: [SOURCE],
    watch: () => ({ places: [KANSAS], kinds: ["met"] }),
    view: VIEW,
    run: `run-${clock.now()}`,
    delivery: { ...DELIVERY, channels: [pushover.procedures, sms.procedures], ...extra },
    ...(wake === undefined ? {} : { wake }),
  });
  return { clock, log, runtime, pushover: pushover.calls, sms: sms.calls };
}

const types = (log: RuntimeLog) => [...log.read()].map((event) => event.type).filter((type) => type !== "observation" && type !== "fetch" && type !== "system");

describe("the delivery step of a pass", () => {
  it("starts the escalation of a warning at a watched place, and sends its first step", async () => {
    const { runtime, log, pushover, sms } = open();
    const pass = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(pushover.send[0]).toMatchObject({ person: PERSON, level: "life-safety", title: "Tornado Warning issued April 1 at 1:00PM CDT by NWS Wichita KS", body: "TAKE COVER NOW!", quiet: false, expires: T0 + 45 * MINUTE });
    expect(sms.send).toEqual([]);
    expect(types(log)).toEqual(["started", "escalation", "delivery"]);
    expect(pass.delivery?.sent.map((delivery) => [delivery.channel, delivery.step, delivery.receipt])).toEqual([[PUSHOVER, 0, { receipt: "pushover-1" }]]);
    // The next pass is the first poll of the receipt.
    expect(pass.wakeAt).toBe(T0 + 30 * SECOND);
    log.close();
  });

  it("polls the receipt, writes the acknowledgment, cancels the repeats and sends no later step", async () => {
    const { clock, runtime, log, pushover, sms } = open({ pushover: { status: () => ({ state: "acknowledged", at: T0 + 20 * SECOND, by: "phone" }) } });
    await runtime.pass();
    await clock.advance(30 * SECOND);
    const pass = await runtime.pass();
    expect(pushover.status).toEqual([{ receipt: "pushover-1" }]);
    expect(pass.delivery?.acknowledged).toEqual([{ incident: runtime.state().merge.deliveries[0]!.incident, level: "life-safety", person: PERSON, at: T0 + 20 * SECOND, via: PUSHOVER }]);
    expect(pushover.cancel).toEqual([{ receipt: "pushover-1" }]);
    expect(pass.delivery?.duplicates).toEqual([]);
    expect(types(log)).toEqual(["started", "escalation", "delivery", "acknowledgment", "cancelled"]);
    await clock.advance(10 * MINUTE);
    await runtime.pass();
    expect(sms.send).toEqual([]);
    expect(pushover.status).toHaveLength(1);
    log.close();
  });

  it("sends the next step at its time when no acknowledgment comes", async () => {
    const { clock, runtime, log, pushover, sms } = open();
    let pass = await runtime.pass();
    while ((pass.wakeAt ?? Infinity) <= T0 + 5 * MINUTE) {
      await clock.advance(Math.max(1, pass.wakeAt! - clock.now()));
      pass = await runtime.pass();
    }
    expect(sms.send.map((message) => message.level)).toEqual(["life-safety"]);
    expect(pushover.send).toHaveLength(1);
    // The receipt of each poll of the first step: one for each 30 seconds.
    expect(pushover.status.length).toBeGreaterThanOrEqual(9);
    log.close();
  });

  it("polls a receipt at most one time in each interval, also when the passes come more often", async () => {
    const { clock, runtime, log, pushover } = open();
    await runtime.pass();
    await clock.advance(30 * SECOND);
    await runtime.pass();
    await clock.advance(10 * SECOND);
    const early = await runtime.pass();
    expect(pushover.status).toHaveLength(1);
    expect(early.wakeAt).toBe(T0 + 60 * SECOND);
    await clock.advance(20 * SECOND);
    await runtime.pass();
    expect(pushover.status).toHaveLength(2);
    log.close();
  });

  it("waits for the time of the channel after a refusal of its quota, then sends again", async () => {
    const { clock, runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? { ok: false, kind: "rate-limited", message: "The quota is used.", retryAfter: 90 * SECOND } : undefined) } });
    const first = await runtime.pass();
    expect(first.delivery?.failures).toEqual([{ call: "send", key: pushover.send[0]!.key, channel: PUSHOVER, kind: "rate-limited", message: "The quota is used.", retryAt: T0 + 90 * SECOND }]);
    expect(types(log)).toEqual(["started", "escalation"]);
    // The fetch of the source brings a pass before the end of the wait. The send waits, and the next pass comes at its end.
    await clock.advance(MINUTE);
    const second = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(second.wakeAt).toBe(T0 + 90 * SECOND);
    await clock.advance(30 * SECOND);
    const third = await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    expect(third.delivery?.sent).toHaveLength(1);
    log.close();
  });

  it("keeps a send that hangs in flight until its flight limit, and then sends again", async () => {
    const { clock, runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? new Promise<SendOutcome>(() => undefined) : undefined) } });
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    const first = await running;
    expect(first.delivery?.failures.map((failure) => [failure.kind, failure.message])).toEqual([["timeout", "The send took longer than 10000 ms. It stays in flight for up to 40000 ms."]]);
    expect(types(log)).toEqual(["started", "escalation"]);
    // The wait of the retry is over, but the first send is in flight. The next pass comes at the end of the flight.
    await clock.advance(5 * SECOND);
    const second = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(second.wakeAt).toBe(T0 + 40 * SECOND);
    await clock.advance(25 * SECOND);
    const third = await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    expect(third.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "pushover-2" }]);
    log.close();
  });

  it("writes a send that the channel accepts after the time limit, and sends no second copy", async () => {
    const clock = fakeWallClock(T0);
    let woken = 0;
    const late = (): Promise<SendOutcome> => new Promise((resolve) => clock.after(15 * SECOND, () => resolve({ ok: true, receipt: { receipt: "late-1" }, accepted: clock.now() })));
    const { runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? late() : undefined) } }, openRuntimeLog(":memory:"), clock, {}, () => (woken += 1));
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    expect((await running).delivery?.failures.map((failure) => failure.kind)).toEqual(["timeout"]);
    await clock.advance(5 * SECOND);
    await settle();
    expect(woken).toBe(1);
    const second = await runtime.pass();
    expect(second.delivery?.sent.map((delivery) => [delivery.receipt, delivery.at])).toEqual([[{ receipt: "late-1" }, T0 + 15 * SECOND]]);
    expect(pushover.send).toHaveLength(1);
    expect(types(log)).toEqual(["started", "escalation", "delivery"]);
    // The late delivery gets its polls, thus an acknowledgment and a cancel can reach it.
    await clock.advance(30 * SECOND);
    await runtime.pass();
    expect(pushover.status).toEqual([{ receipt: "late-1" }]);
    log.close();
  });

  it("tells a late send that lands after a second send of its key as a duplicate, and keeps the first delivery of the log", async () => {
    const clock = fakeWallClock(T0);
    const late = (): Promise<SendOutcome> => new Promise((resolve) => clock.after(50 * SECOND, () => resolve({ ok: true, receipt: { receipt: "late-1" }, accepted: clock.now() })));
    const { runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? late() : undefined) } }, openRuntimeLog(":memory:"), clock);
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    await running;
    await clock.advance(30 * SECOND);
    await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    await clock.advance(10 * SECOND);
    await settle();
    const last = await runtime.pass();
    expect(last.delivery?.duplicates).toEqual([pushover.send[0]!.key]);
    expect(last.delivery?.sent).toEqual([]);
    expect(runtime.state().merge.deliveries.map((delivery) => delivery.receipt)).toEqual([{ receipt: "pushover-2" }]);
    log.close();
  });

  it("keeps the start after a restart, thus the next step comes at its time and no step goes twice", async () => {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const before = open({}, log, clock);
    await before.runtime.pass();
    expect(before.pushover.send).toHaveLength(1);

    // A new process on the same log, six minutes later.
    await clock.advance(6 * MINUTE);
    const after = open({}, log, clock);
    expect(after.runtime.state()).toEqual(rebuild(log.read(), after.runtime.config));
    expect(after.runtime.state().starts).toHaveLength(1);
    await after.runtime.pass();
    expect(after.pushover.send).toEqual([]);
    expect(after.sms.send.map((message) => message.level)).toEqual(["life-safety"]);
    expect(types(log)).toEqual(["started", "escalation", "delivery", "started", "delivery"]);
    log.close();
  });

  it("writes a delivery whose write failed at the next pass, and sends no second copy", async () => {
    const clock = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    let fail = true;
    const flaky: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        if (fail && events.some((event) => event.type === "delivery")) {
          fail = false;
          throw new Error("The disk is full.");
        }
        return inner.appendAll(events, accept);
      },
    };
    let woken = 0;
    const { runtime, pushover } = open({}, flaky, clock, {}, () => (woken += 1));
    await expect(runtime.pass()).rejects.toThrow("The disk is full.");
    expect(runtime.state()).toEqual(rebuild(inner.read(), runtime.config));
    expect(runtime.state().merge.deliveries).toEqual([]);
    expect(woken).toBe(1);
    // The channel has the message. The next pass writes its delivery, and the send does not go again.
    const pass = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(pass.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "pushover-1" }]);
    expect(runtime.state().merge.deliveries).toHaveLength(1);
    inner.close();
  });

  it("cancels again in a later pass when a cancel fails", async () => {
    let refuse = true;
    const { clock, runtime, log, pushover } = open({
      pushover: {
        status: () => ({ state: "acknowledged", at: T0 + 20 * SECOND }),
        cancel: () => {
          if (refuse) {
            refuse = false;
            throw new Error("Pushover is down.");
          }
        },
      },
    });
    await runtime.pass();
    await clock.advance(30 * SECOND);
    const second = await runtime.pass();
    expect(second.delivery?.failures.map((failure) => [failure.call, failure.message])).toEqual([["cancel", "Pushover is down."]]);
    expect(second.wakeAt).toBe(T0 + 45 * SECOND);
    await clock.advance(15 * SECOND);
    const third = await runtime.pass();
    expect(third.delivery?.cancelled).toHaveLength(1);
    expect(pushover.cancel).toHaveLength(2);
    expect(types(log)).toEqual(["started", "escalation", "delivery", "acknowledgment", "cancelled"]);
    log.close();
  });

  it("tells an on-time send whose key the log already has as a duplicate, not as sent", async () => {
    const clock = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    // Another writer puts a delivery with the same id and another receipt into the log first.
    const shared: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        for (const event of events) if (event.type === "delivery") inner.appendAll([{ ...event, delivery: { ...event.delivery, receipt: { receipt: "other" } } }], accept);
        return inner.appendAll(events, accept);
      },
    };
    const { runtime, pushover } = open({}, shared, clock);
    const pass = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(pass.delivery?.sent).toEqual([]);
    expect(pass.delivery?.duplicates).toEqual([pushover.send[0]!.key]);
    expect(pass.conflicts).toEqual([`delivery:${pushover.send[0]!.key}`]);
    inner.close();
  });

  it("writes one delivery when two late sends of one key land before the same pass", async () => {
    const clock = fakeWallClock(T0);
    const late = (after: number, receipt: string): Promise<SendOutcome> => new Promise((resolve) => clock.after(after, () => resolve({ ok: true, receipt: { receipt }, accepted: clock.now() })));
    // The first send lands at 50 s. The second send starts at 40 s, after the flight limit, and lands at 52 s.
    const { runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? late(50 * SECOND, "late-1") : late(12 * SECOND, "late-2")) } }, openRuntimeLog(":memory:"), clock);
    const first = runtime.pass();
    await clock.advance(10 * SECOND);
    await first;
    await clock.advance(30 * SECOND);
    const second = runtime.pass();
    await clock.advance(10 * SECOND);
    await second;
    await clock.advance(5 * SECOND);
    await settle();
    const last = await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    expect(last.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "late-1" }]);
    expect(last.delivery?.duplicates).toEqual([pushover.send[0]!.key]);
    expect(last.conflicts).toEqual([]);
    log.close();
  });

  it("keeps the later flight of a key when an earlier flight fails after it started", async () => {
    const clock = fakeWallClock(T0);
    // The first send fails at 50 s. The second send starts at 40 s and hangs.
    const refused = (): Promise<SendOutcome> => new Promise((resolve) => clock.after(50 * SECOND, () => resolve({ ok: false, kind: "network", message: "The connection reset." })));
    const { runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? refused() : new Promise<SendOutcome>(() => undefined)) } }, openRuntimeLog(":memory:"), clock);
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    await running;
    await clock.advance(30 * SECOND);
    const second = runtime.pass();
    await clock.advance(10 * SECOND);
    await second;
    await settle();
    await clock.advance(5 * SECOND);
    await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    log.close();
  });

  it("keeps a late delivery for the next pass when its write fails", async () => {
    const clock = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    let fail = true;
    const flaky: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        if (fail && events.some((event) => event.type === "delivery")) {
          fail = false;
          throw new Error("The disk is full.");
        }
        return inner.appendAll(events, accept);
      },
    };
    const late = (): Promise<SendOutcome> => new Promise((resolve) => clock.after(15 * SECOND, () => resolve({ ok: true, receipt: { receipt: "late-1" }, accepted: clock.now() })));
    const { runtime, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? late() : undefined) } }, flaky, clock);
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    await running;
    await clock.advance(5 * SECOND);
    await settle();
    await expect(runtime.pass()).rejects.toThrow("The disk is full.");
    const pass = await runtime.pass();
    expect(pass.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "late-1" }]);
    expect(pushover.send).toHaveLength(1);
    inner.close();
  });

  it("refuses a flight limit that is shorter than the call limit", () => {
    expect(() => open({}, openRuntimeLog(":memory:"), fakeWallClock(T0), { flightLimit: 5 * SECOND })).toThrow("The flight limit (5000 ms) is shorter than the call limit (10000 ms).");
  });

  it("refuses two channels with the same id", () => {
    const clock = fakeWallClock(T0);
    const twice = channel(PUSHOVER, "poll", () => clock.now()).procedures;
    expect(() => open({}, openRuntimeLog(":memory:"), clock, { channels: [twice, twice] })).toThrow("Two channels have the id pushover.");
  });
});
