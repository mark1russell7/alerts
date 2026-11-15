import { fakeWallClock } from "@mark1russell7/algebra/clock";
import {
  COPY_ID,
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
import { heldOf, holdStep } from "./heartbeat.ts";
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
  /** The copy id of each send. */
  readonly copies: (string | undefined)[];
  readonly status: Receipt[];
  /** The cancels by a receipt. */
  readonly cancel: Receipt[];
  /** The stops of one copy by its copy id. */
  readonly stops: string[];
}

interface Script {
  /** A send that gives `undefined` accepts the message. */
  send?: (message: Message, count: number) => SendOutcome | undefined | Promise<SendOutcome>;
  status?: (receipt: Receipt) => DeliveryStatus;
  cancel?: (receipt: Receipt) => void | Promise<void>;
  stop?: (copy: string) => void | Promise<void>;
}

// A channel of the test. Its default send accepts each message with a new receipt.
function channel(id: ChannelId, ack: ChannelDescriptor["ack"], now: () => number, script: Script = {}): { readonly procedures: ChannelProcedures; readonly calls: Calls } {
  const calls: Calls = { send: [], copies: [], status: [], cancel: [], stops: [] };
  const procedures: ChannelProcedures = {
    describe: () => ({ id, title: id, dependsOn: [], uses: ["internet"], breaksThrough: true, repeats: ack === "poll", ack, maxTitle: 250, maxBody: 1024 }),
    send: async ({ message, copy }) => {
      calls.send.push(message);
      calls.copies.push(copy);
      return (await script.send?.(message, calls.send.length)) ?? { ok: true, receipt: { receipt: `${id}-${calls.send.length}` }, accepted: now() };
    },
    status: async ({ receipt }) => {
      calls.status.push(receipt);
      return script.status?.(receipt) ?? { state: "delivered", at: now() };
    },
    cancel: async (target) => {
      if ("copy" in target) {
        calls.stops.push(target.copy);
        await script.stop?.(target.copy);
        return;
      }
      calls.cancel.push(target.receipt);
      await script.cancel?.(target.receipt);
    },
  };
  return { procedures, calls };
}

const DELIVERY = { recipients: [RECIPIENT], pollEvery: 30 * SECOND, retry: 15 * SECOND, callLimit: 10 * SECOND, flightLimit: 40 * SECOND } as const;

// The run id of a runtime that `open` starts at T0. Each copy id starts with it.
const RUN = `run-${T0}`;

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
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery"]);
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
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery", "acknowledgment", "cancelled"]);
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
    expect(types(log)).toEqual(["started", "escalation", "attempt", "refused"]);
    // The fetch of the source brings a pass before the end of the wait. The send waits, and the next pass comes at its end.
    await clock.advance(MINUTE);
    const second = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(second.wakeAt).toBe(T0 + 90 * SECOND);
    await clock.advance(30 * SECOND);
    const third = await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    expect(third.delivery?.sent).toHaveLength(1);
    expect(pushover.stops).toEqual([]);
    // The delivery of the key ends its refusal.
    expect(runtime.state().refusals).toEqual({});
    log.close();
  });

  it("keeps the wait of a refused send after a restart, thus the quota of the channel holds", async () => {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const before = open({ pushover: { send: () => ({ ok: false, kind: "rate-limited", message: "The quota is used.", retryAfter: 90 * SECOND }) } }, log, clock);
    await before.runtime.pass();
    const key = before.pushover.send[0]!.key;
    expect(before.runtime.state().refusals).toEqual({ [key]: { channel: PUSHOVER, kind: "rate-limited", at: T0, retryAt: T0 + 90 * SECOND, deliveries: 0 } });
    // The refusal ends the copy, thus the restart does not stop it.
    expect(before.runtime.state().copies).toEqual({});

    // A new process on the same log, before the end of the wait.
    await clock.advance(30 * SECOND);
    const after = open({}, log, clock);
    expect(after.runtime.state()).toEqual(rebuild(log.read(), after.runtime.config));
    await after.runtime.pass();
    expect(after.pushover.send).toEqual([]);
    expect(after.pushover.stops).toEqual([]);
    await clock.advance(30 * SECOND);
    const early = await after.runtime.pass();
    expect(after.pushover.send).toEqual([]);
    expect(early.wakeAt).toBe(T0 + 90 * SECOND);
    await clock.advance(30 * SECOND);
    const late = await after.runtime.pass();
    expect(after.pushover.send.map((message) => message.key)).toEqual([key]);
    expect(late.delivery?.sent).toHaveLength(1);
    expect(after.runtime.state().refusals).toEqual({});
    log.close();
  });

  it("keeps the wait of a send in the reserve of a channel across a restart, and the heartbeat holds no fail for it", async () => {
    const reserved: Script = { send: () => ({ ok: false, kind: "reserved", message: "The quota keeps its last units for life-safety.", retryAfter: 600 * SECOND }) };
    const { runtime, log } = open({ pushover: reserved }, openRuntimeLog(":memory:"), fakeWallClock(T0));
    const pass = await runtime.pass();
    expect(pass.delivery?.failures.map((failure) => failure.kind)).toEqual(["reserved"]);
    const state = rebuild(log.read(), runtime.config);
    expect(Object.values(state.refusals).map((refusal) => [refusal.kind, refusal.retryAt])).toEqual([["reserved", T0 + 600 * SECOND]]);
    expect(holdStep({}, pass)).toEqual({});
    expect(heldOf(state, T0 + 30 * SECOND)).toEqual({});
    log.close();
  });

  it("writes the refusals of a step after its deliveries, thus the log keeps the hold of the pass also when the accept is later", async () => {
    const OTHER: Recipient = { ...RECIPIENT, watch: { ...RECIPIENT.watch, person: "person-2" as PersonId } };
    // The channel refuses the key of person-2 at once. It accepts the key of person-1 after the refusal, with a time after
    // the time of the refusal.
    const later: Script = {
      send: (message) =>
        message.person === OTHER.watch.person
          ? { ok: false, kind: "auth", message: "The user key is not valid.", retryAfter: 90 * SECOND }
          : settle().then(() => ({ ok: true, receipt: { receipt: "pushover-1" }, accepted: T0 + 5 * SECOND })),
    };
    const { runtime, log } = open({ pushover: later }, openRuntimeLog(":memory:"), fakeWallClock(T0), { recipients: [RECIPIENT, OTHER] });
    const pass = await runtime.pass();
    expect(pass.delivery?.sent.map((delivery) => delivery.person)).toEqual([PERSON]);
    expect(pass.delivery?.failures.map((failure) => failure.kind)).toEqual(["auth"]);
    const order = types(log);
    expect(order.lastIndexOf("delivery")).toBeLessThan(order.indexOf("refused"));
    // The state after a restart holds the channel as the pass does.
    const held = holdStep({}, pass);
    expect(held).toEqual({ pushover: { kinds: ["auth"], until: T0 + 90 * SECOND } });
    expect(heldOf(rebuild(log.read(), runtime.config), T0 + 30 * SECOND)).toEqual(held);
    log.close();
  });

  it("stops a copy whose send failed with no answer by its copy id, in parallel with the new copy", async () => {
    const { clock, runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? { ok: false, kind: "timeout", message: "Pushover did not answer." } : undefined) } });
    const first = await runtime.pass();
    expect(first.delivery?.failures.map((failure) => failure.kind)).toEqual(["timeout"]);
    expect(first.delivery?.stopped).toEqual([]);
    await clock.advance(15 * SECOND);
    const second = await runtime.pass();
    expect(pushover.copies).toEqual([`${RUN}-1`, `${RUN}-2`]);
    expect(pushover.copies.every((copy) => copy !== undefined && COPY_ID.test(copy))).toBe(true);
    expect(pushover.stops).toEqual([`${RUN}-1`]);
    expect(second.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(second.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "pushover-2" }]);
    // No cancel by the delivery key goes, thus the new copy repeats until the acknowledgment.
    expect(pushover.cancel).toEqual([]);
    log.close();
  });

  it("stops a copy again at a later pass when its stop fails", async () => {
    let refuse = true;
    const { clock, runtime, log, pushover } = open({
      pushover: {
        send: (_, count) => (count === 1 ? { ok: false, kind: "network", message: "The connection reset." } : undefined),
        stop: () => {
          if (refuse) {
            refuse = false;
            throw new Error("Pushover is down.");
          }
        },
      },
    });
    await runtime.pass();
    await clock.advance(15 * SECOND);
    const second = await runtime.pass();
    expect(second.delivery?.failures.map((failure) => [failure.call, failure.copy, failure.message])).toEqual([["copy", `${RUN}-1`, "Pushover is down."]]);
    expect(second.delivery?.sent).toHaveLength(1);
    expect(second.wakeAt).toBe(T0 + 30 * SECOND);
    await clock.advance(15 * SECOND);
    const third = await runtime.pass();
    expect(third.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(pushover.stops).toEqual([`${RUN}-1`, `${RUN}-1`]);
    log.close();
  });

  it("gives the kind timeout to a stop and to a cancel that pass their time limit", async () => {
    const hang = (): Promise<void> => new Promise<void>(() => undefined);
    let stops = 0;
    const { clock, runtime, log, pushover } = open({
      pushover: {
        send: (_, count) => (count === 1 ? { ok: false, kind: "timeout", message: "Pushover did not answer." } : undefined),
        status: () => ({ state: "acknowledged", at: T0 + 20 * SECOND }),
        // The first stop hangs, and the second stop ends.
        stop: () => {
          stops += 1;
          return stops === 1 ? hang() : undefined;
        },
        cancel: hang,
      },
    });
    await runtime.pass();
    await clock.advance(15 * SECOND);
    const second = runtime.pass();
    await clock.advance(10 * SECOND);
    expect((await second).delivery?.failures.map((failure) => [failure.call, failure.kind, failure.message])).toEqual([["copy", "timeout", "The stop of the copy took longer than 10000 ms."]]);
    // The poll of the new copy comes 30 s after its send, at T0 + 45 s. It reads the acknowledgment, and the cancel by receipt hangs.
    await clock.advance(20 * SECOND);
    const third = runtime.pass();
    await clock.advance(10 * SECOND);
    const last = await third;
    expect(last.delivery?.failures.map((failure) => [failure.call, failure.kind, failure.message])).toEqual([["cancel", "timeout", "The cancel took longer than 10000 ms."]]);
    expect(last.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(pushover.stops).toEqual([`${RUN}-1`, `${RUN}-1`]);
    log.close();
  });

  it("refuses a run id with a character that a copy id cannot have", () => {
    const clock = fakeWallClock(T0);
    const start = (run: string): void => {
      const log = openRuntimeLog(":memory:");
      try {
        const channels = [channel(PUSHOVER, "poll", () => clock.now()).procedures, channel(SMS, "none", () => clock.now()).procedures];
        openRuntime({ log, clock, sources: [SOURCE], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run, delivery: { ...DELIVERY, channels } });
      } finally {
        log.close();
      }
    };
    expect(() => start("run.1")).toThrow('The run id "run.1" has a character that a copy id cannot have. Use letters, digits, _ and -.');
    expect(() => start("0b6f3c1e-8f0a-4d1e-9a51-6c2f1d7e9b10")).not.toThrow();
  });

  it("stops no copy on a channel that does not repeat", async () => {
    const { clock, runtime, log, sms } = open({ sms: { send: () => ({ ok: false, kind: "timeout", message: "The gateway did not answer." }) } });
    let pass = await runtime.pass();
    while ((pass.wakeAt ?? Infinity) <= T0 + 6 * MINUTE) {
      await clock.advance(Math.max(1, pass.wakeAt! - clock.now()));
      pass = await runtime.pass();
    }
    expect(sms.send.length).toBeGreaterThanOrEqual(2);
    expect(sms.stops).toEqual([]);
    log.close();
  });

  it("keeps a send that hangs in flight until its flight limit, then stops its copy and sends a new copy in parallel", async () => {
    const { clock, runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? new Promise<SendOutcome>(() => undefined) : undefined) } });
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    const first = await running;
    expect(first.delivery?.failures.map((failure) => [failure.kind, failure.message])).toEqual([["timeout", "The send took longer than 10000 ms. It stays in flight for up to 40000 ms."]]);
    expect(types(log)).toEqual(["started", "escalation", "attempt"]);
    // The wait of the retry is over, but the first send is in flight. The next pass comes at the end of the flight.
    await clock.advance(5 * SECOND);
    const second = await runtime.pass();
    expect(pushover.send).toHaveLength(1);
    expect(second.wakeAt).toBe(T0 + 40 * SECOND);
    await clock.advance(25 * SECOND);
    const third = await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    expect(third.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "pushover-2" }]);
    // The stop names the copy of the hung send. A cancel by the delivery key would also stop the new copy.
    expect(pushover.copies).toEqual([`${RUN}-1`, `${RUN}-2`]);
    expect(third.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(pushover.stops).toEqual([`${RUN}-1`]);
    expect(pushover.cancel).toEqual([]);
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
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery"]);
    // The late delivery gets its polls, thus an acknowledgment and a cancel can reach it.
    await clock.advance(30 * SECOND);
    await runtime.pass();
    expect(pushover.status).toEqual([{ receipt: "late-1" }]);
    log.close();
  });

  it("stops a stale copy again when the channel accepts it after its stop, and writes no delivery of it", async () => {
    const clock = fakeWallClock(T0);
    let woken = 0;
    const late = (): Promise<SendOutcome> => new Promise((resolve) => clock.after(50 * SECOND, () => resolve({ ok: true, receipt: { receipt: "late-1" }, accepted: clock.now() })));
    const { runtime, log, pushover } = open({ pushover: { send: (_, count) => (count === 1 ? late() : undefined) } }, openRuntimeLog(":memory:"), clock, {}, () => (woken += 1));
    const running = runtime.pass();
    await clock.advance(10 * SECOND);
    await running;
    await clock.advance(30 * SECOND);
    const second = await runtime.pass();
    expect(pushover.send).toHaveLength(2);
    expect(second.delivery?.stopped).toEqual([`${RUN}-1`]);
    // The send of the copy did not end, thus its stop does not end it. A restart now stops it again.
    expect(types(log).filter((type) => type === "settled")).toEqual([]);
    expect(Object.keys(runtime.state().copies)).toContain(`${RUN}-1`);
    await clock.advance(10 * SECOND);
    await settle();
    expect(woken).toBe(1);
    const last = await runtime.pass();
    expect(last.delivery?.stopped).toEqual([`${RUN}-1`]);
    // The second stop comes after the end of the send. It ends the copy.
    expect(types(log).filter((type) => type === "settled")).toEqual(["settled"]);
    expect(Object.keys(runtime.state().copies)).not.toContain(`${RUN}-1`);
    expect(last.delivery?.sent).toEqual([]);
    expect(last.delivery?.duplicates).toEqual([]);
    expect(pushover.stops).toEqual([`${RUN}-1`, `${RUN}-1`]);
    expect(pushover.cancel).toEqual([]);
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
    // The delivery of the copy ends it, thus the restart does not stop it.
    expect(after.pushover.stops).toEqual([]);
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery", "started", "delivery"]);
    log.close();
  });

  it("stops a copy of an earlier run with no delivery after a restart, and a new copy goes in parallel", async () => {
    const clock = fakeWallClock(T0);
    const inner = openRuntimeLog(":memory:");
    // The process stops after the channel accepts the send and before the log writes its delivery.
    let crash = true;
    const crashing: RuntimeLog = {
      ...inner,
      appendAll: (events, accept) => {
        if (crash && events.some((event) => event.type === "delivery")) throw new Error("The process stops.");
        return inner.appendAll(events, accept);
      },
    };
    const before = open({}, crashing, clock);
    await expect(before.runtime.pass()).rejects.toThrow("The process stops.");
    expect(before.pushover.copies).toEqual([`${RUN}-1`]);
    expect(before.runtime.state().copies).toEqual({ [`${RUN}-1`]: { key: before.pushover.send[0]!.key, channel: PUSHOVER } });

    // A new process on the same log, one minute later. The log has the attempt of the copy and no delivery.
    crash = false;
    await clock.advance(MINUTE);
    const after = open({}, inner, clock);
    const pass = await after.runtime.pass();
    const run = `run-${T0 + MINUTE}`;
    expect(after.pushover.copies).toEqual([`${run}-1`]);
    expect(pass.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(after.pushover.stops).toEqual([`${RUN}-1`]);
    expect(after.pushover.cancel).toEqual([]);
    expect(after.runtime.state().copies).toEqual({});
    expect(after.runtime.state()).toEqual(rebuild(inner.read(), after.runtime.config));
    expect(types(inner)).toEqual(["started", "escalation", "attempt", "started", "attempt", "delivery", "settled"]);
    // The copy is over, thus the next pass stops nothing.
    await clock.advance(30 * SECOND);
    expect((await after.runtime.pass()).delivery?.stopped).toEqual([]);
    expect(after.pushover.stops).toHaveLength(1);
    inner.close();
  });

  it("keeps a copy of an earlier run open in the log until its stop goes, also after a failed stop", async () => {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const before = open({ pushover: { send: () => new Promise<SendOutcome>(() => undefined) } }, log, clock);
    const running = before.runtime.pass();
    await clock.advance(10 * SECOND);
    await running;
    expect(types(log)).toEqual(["started", "escalation", "attempt"]);

    await clock.advance(MINUTE);
    let refuse = true;
    const stop = (): void => {
      if (refuse) {
        refuse = false;
        throw new Error("Pushover is down.");
      }
    };
    const after = open({ pushover: { stop } }, log, clock);
    const first = await after.runtime.pass();
    expect(first.delivery?.failures.map((failure) => [failure.call, failure.copy, failure.message])).toEqual([["copy", `${RUN}-1`, "Pushover is down."]]);
    expect(Object.keys(after.runtime.state().copies)).toEqual([`${RUN}-1`]);
    await clock.advance(15 * SECOND);
    const second = await after.runtime.pass();
    expect(second.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(after.pushover.stops).toEqual([`${RUN}-1`, `${RUN}-1`]);
    expect(after.runtime.state().copies).toEqual({});
    log.close();
  });

  it("does not stop a copy of an earlier run that the channel refused", async () => {
    const clock = fakeWallClock(T0);
    const log = openRuntimeLog(":memory:");
    const before = open({ pushover: { send: () => ({ ok: false, kind: "refused", message: "The user key is not valid." }) } }, log, clock);
    await before.runtime.pass();
    expect(before.runtime.state().copies).toEqual({});
    await clock.advance(MINUTE);
    const after = open({}, log, clock);
    await after.runtime.pass();
    expect(after.pushover.send).toHaveLength(1);
    expect(after.pushover.stops).toEqual([]);
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
    expect(types(log)).toEqual(["started", "escalation", "attempt", "delivery", "acknowledgment", "cancelled"]);
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
    // No poll reads the duplicate copy, thus the next pass stops it by its copy id.
    const next = await runtime.pass();
    expect(next.delivery?.stopped).toEqual([`${RUN}-1`]);
    expect(pushover.stops).toEqual([`${RUN}-1`]);
    expect(pushover.cancel).toEqual([]);
    inner.close();
  });

  it("writes the delivery of the new copy, and not of the stale copy, when both land before the same pass", async () => {
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
    expect(last.delivery?.sent.map((delivery) => delivery.receipt)).toEqual([{ receipt: "late-2" }]);
    expect(last.delivery?.duplicates).toEqual([]);
    expect(last.delivery?.stopped).toEqual([`${RUN}-1`]);
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
