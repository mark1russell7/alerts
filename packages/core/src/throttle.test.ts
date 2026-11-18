import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChannelId, Delivery, EscalationPolicy, Incident, Level, PersonId, ReportId } from "./contracts.ts";
import type { EscalationHold, Route } from "./delivery.ts";
import { messageKey } from "./ids.ts";
import { DEFAULT_SEND_LIMITS, limitRoutes } from "./send-limit.ts";
import { DEFAULT_THROTTLE, throttleOf, throttleProblems, throttleRoutes, type Suppression, type Throttle } from "./throttle.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.UTC(2026, 3, 1, 18);

const pushover = "pushover" as ChannelId;
const call = "twilio-call" as ChannelId;
const person = "person-1" as PersonId;
const other = "person-2" as PersonId;

// A made-up report id for each index.
const idOf = (index: number): ReportId => index.toString(16).padStart(64, "0") as ReportId;

function sent(index: number, level: Level, at: number, options: { readonly who?: PersonId; readonly channel?: ChannelId; readonly step?: number; readonly episode?: number } = {}): Delivery {
  const { who = person, channel = pushover, step = 0, episode = 0 } = options;
  const incident = idOf(index);
  return { key: messageKey({ incident, level, person: who, step, ...(episode === 0 ? {} : { episode }) }), incident, level, person: who, channel, step, at, receipt: {} };
}

// A route of an escalation with one send that is due: step `step` on `channel`.
function entry(index: number, options: { readonly level?: Level; readonly due?: number; readonly who?: PersonId; readonly channel?: ChannelId; readonly step?: number; readonly episode?: number } = {}): Route {
  const { level = "notice", due = T0, who = person, channel = pushover, step = 0, episode = 0 } = options;
  const incident: Incident = {
    anchor: idOf(index),
    reports: [idOf(index)],
    status: "actual",
    kind: { code: "met.flood", label: "Flood" },
    severity: "moderate",
    urgency: "expected",
    certainty: "observed",
    areas: [{ type: "code", system: "ugc", code: "KSC173" }],
    about: [],
    live: true,
    corroboration: 1,
  };
  const policy: EscalationPolicy = { level, steps: [{ channel, at: 0 }, { channel, at: 5 * MINUTE }], exhaustedAfter: 10 * MINUTE };
  return {
    incident,
    person: who,
    policy,
    start: { incident: idOf(index), level, person: who, at: due },
    fresh: step === 0,
    deliveries: [],
    polls: [],
    plan: {
      state: "sent",
      start: due,
      due: [0],
      sends: [{ incident: idOf(index), level, person: who, step, ...(episode === 0 ? {} : { episode }), channel, due, wait: 0, quiet: false }],
      cancels: [],
      transitions: [],
    },
    episode,
    freshEnd: false,
  };
}

const sendsOf = (routes: readonly Route[]): string[] => routes.flatMap((route) => route.plan.sends.map((send) => `${send.incident.slice(-2)}:${send.level}`));

describe("the throttle of a configuration", () => {
  it("keeps each default that the configuration does not give", () => {
    expect(throttleOf(undefined)).toEqual(DEFAULT_THROTTLE);
    expect(throttleOf({ window: 10 * MINUTE })).toEqual({ ...DEFAULT_THROTTLE, window: 10 * MINUTE });
    expect(DEFAULT_THROTTLE).toEqual({ window: 30 * MINUTE, key: "channel", exempt: ["life-safety"] });
  });

  it("finds a bad window, a bad key and a bad exemption", () => {
    expect(throttleProblems({})).toEqual([]);
    expect(throttleProblems({ window: 30 * SECOND })).toHaveLength(1);
    expect(throttleProblems({ window: 2 * 86_400_000 })).toHaveLength(1);
    expect(throttleProblems({ key: "place" as Throttle["key"] })).toHaveLength(1);
    expect(throttleProblems({ exempt: ["digest"] })).toHaveLength(1);
    expect(throttleProblems({ exempt: ["urgent", "life-safety"] })).toEqual([]);
  });
});

describe("throttleRoutes", () => {
  it("(b) sends an urgent alert at once after a notice in the window", () => {
    const deliveries = [sent(1, "notice", T0)];
    const result = throttleRoutes({ routes: [entry(2, { level: "urgent", due: T0 + MINUTE })], deliveries, suppressions: [], now: T0 + MINUTE });
    expect(sendsOf(result.routes)).toEqual(["02:urgent"]);
    expect(result.suppressions).toEqual([]);
  });

  it("(c) sends a life-safety alert at the same level inside the window: a new incident, and the re-page (step 1) of an escalation with no acknowledgment", () => {
    // A life-safety message went 1 minute before. Two new life-safety incidents in one pass and step 1 of the first all go.
    const deliveries = [sent(1, "life-safety", T0)];
    const routes = [entry(2, { level: "life-safety", due: T0 + MINUTE }), entry(3, { level: "life-safety", due: T0 + MINUTE }), entry(1, { level: "life-safety", due: T0 + 5 * MINUTE, step: 1 })];
    const result = throttleRoutes({ routes, deliveries, suppressions: [], now: T0 + 5 * MINUTE });
    expect(sendsOf(result.routes)).toEqual(["02:life-safety", "03:life-safety", "01:life-safety"]);
    expect(result.suppressions).toEqual([]);
  });

  it("(d) stops a lower level after a higher one in the window, and keeps the reason", () => {
    const deliveries = [sent(1, "urgent", T0)];
    const result = throttleRoutes({ routes: [entry(2, { due: T0 + MINUTE })], deliveries, suppressions: [], now: T0 + MINUTE });
    expect(sendsOf(result.routes)).toEqual([]);
    const key = messageKey({ incident: idOf(2), level: "notice", person, step: 0 });
    expect(result.suppressions).toEqual<Suppression[]>([{ key, incident: idOf(2), level: "notice", person, channel: pushover, step: 0, episode: 0, at: T0 + MINUTE, reason: "lower-level", over: "urgent" }]);
  });

  it("stops a second notice in the window as same-level, and lets it go after the window", () => {
    const deliveries = [sent(1, "notice", T0)];
    const inside = throttleRoutes({ routes: [entry(2, { due: T0 + 29 * MINUTE })], deliveries, suppressions: [], now: T0 + 29 * MINUTE });
    expect(inside.suppressions.map((one) => [one.reason, one.over])).toEqual([["same-level", "notice"]]);
    // The window is (now - window, now]. A delivery at now - window is out of it.
    const after = throttleRoutes({ routes: [entry(2, { due: T0 + 30 * MINUTE })], deliveries, suppressions: [], now: T0 + 30 * MINUTE });
    expect(sendsOf(after.routes)).toEqual(["02:notice"]);
  });

  it("keeps a send with a suppression in the log out, also after its window", () => {
    const deliveries = [sent(1, "notice", T0)];
    const first = throttleRoutes({ routes: [entry(2, { due: T0 + MINUTE })], deliveries, suppressions: [], now: T0 + MINUTE });
    const later = throttleRoutes({ routes: [entry(2, { due: T0 + MINUTE })], deliveries, suppressions: first.suppressions, now: T0 + 3 * 60 * MINUTE });
    expect(sendsOf(later.routes)).toEqual([]);
    // The log has the suppression already, thus the pass adds none.
    expect(later.suppressions).toEqual([]);
    // The route keeps its first suppression, thus it gives no exhaustion.
    expect(later.routes[0]?.suppressed?.key).toBe(first.suppressions[0]?.key);
  });

  it("sends one message of each level in one pass, the earliest due first, and stops the rest", () => {
    const routes = [entry(3, { due: T0 + 2 * SECOND }), entry(1, { due: T0 }), entry(2, { due: T0 + SECOND }), entry(4, { level: "urgent", due: T0 + 3 * SECOND }), entry(5, { level: "urgent", due: T0 + 4 * SECOND })];
    const result = throttleRoutes({ routes, deliveries: [], suppressions: [], now: T0 + 5 * SECOND });
    expect(sendsOf(result.routes)).toEqual(["01:notice", "04:urgent"]);
    expect(result.suppressions.map((one) => `${one.incident.slice(-2)}:${one.reason}:${one.over}`)).toEqual(["02:same-level:notice", "03:same-level:notice", "05:same-level:urgent"]);
  });

  it("stops a notice that comes after an urgent alert of the same pass", () => {
    const routes = [entry(1, { level: "urgent", due: T0 }), entry(2, { due: T0 + SECOND })];
    const result = throttleRoutes({ routes, deliveries: [], suppressions: [], now: T0 + SECOND });
    expect(sendsOf(result.routes)).toEqual(["01:urgent"]);
    expect(result.suppressions.map((one) => one.reason)).toEqual(["lower-level"]);
  });

  it("keeps each person and each channel apart, and counts the deliveries of the other copies", () => {
    // The delivery of the other copy has the same form as an own delivery: the ledger holds both.
    const deliveries = [sent(1, "notice", T0)];
    const routes = [entry(2, { due: T0 + MINUTE, who: other }), entry(3, { due: T0 + MINUTE, channel: call }), entry(4, { due: T0 + MINUTE })];
    const result = throttleRoutes({ routes, deliveries, suppressions: [], now: T0 + MINUTE });
    expect(sendsOf(result.routes)).toEqual(["02:notice", "03:notice"]);
    expect(result.suppressions.map((one) => one.incident)).toEqual([idOf(4)]);
  });

  it("lets a started send go first, and counts its level in the window", () => {
    const started = entry(2, { due: T0 + 2 * SECOND });
    const routes = [entry(1, { due: T0 }), started];
    const result = throttleRoutes({ routes, deliveries: [], suppressions: [], started: new Set([messageKey(started.plan.sends[0]!)]), now: T0 + 3 * SECOND });
    expect(sendsOf(result.routes)).toEqual(["02:notice"]);
    expect(result.suppressions.map((one) => one.incident)).toEqual([idOf(1)]);
  });

  it("does not count a digest, and does not stop one", () => {
    const deliveries = [sent(1, "digest", T0)];
    const result = throttleRoutes({ routes: [entry(2, { due: T0 + MINUTE }), entry(3, { level: "digest", due: T0 + MINUTE })], deliveries, suppressions: [], now: T0 + MINUTE });
    expect(sendsOf(result.routes)).toEqual(["02:notice", "03:digest"]);
  });

  it("with the key incident, stops only the repeats of one incident", () => {
    const throttle: Throttle = { ...DEFAULT_THROTTLE, key: "incident" };
    const deliveries = [sent(1, "notice", T0)];
    const routes = [entry(1, { due: T0 + MINUTE, step: 1 }), entry(2, { due: T0 + MINUTE })];
    const result = throttleRoutes({ routes, deliveries, suppressions: [], throttle, now: T0 + MINUTE });
    expect(sendsOf(result.routes)).toEqual(["02:notice"]);
    expect(result.suppressions.map((one) => `${one.incident.slice(-2)}:${String(one.step)}`)).toEqual(["01:1"]);
  });

  it("stops a life-safety send when the configuration takes the exemption away", () => {
    const throttle: Throttle = { ...DEFAULT_THROTTLE, exempt: [] };
    const deliveries = [sent(1, "life-safety", T0)];
    const result = throttleRoutes({ routes: [entry(2, { level: "life-safety", due: T0 + MINUTE })], deliveries, suppressions: [], throttle, now: T0 + MINUTE });
    expect(result.suppressions.map((one) => one.reason)).toEqual(["same-level"]);
  });

  it("gives the same routes object when it stops nothing", () => {
    const routes = [entry(1)];
    expect(throttleRoutes({ routes, deliveries: [], suppressions: [], now: T0 }).routes).toBe(routes);
  });
});

// The replay of the burst of 2026-11-18. Each row is the first send of an escalation: [second, level, incident, episode].
interface BurstFixture {
  readonly sends: readonly (readonly [number, Level, number, number])[];
}
const BURST: BurstFixture = JSON.parse(readFileSync(new URL("../fixtures/burst-2026-11-18.json", import.meta.url), "utf8")) as BurstFixture;

// The passes of one copy at each time of a row: the send limit, then the throttle. A send that goes is a delivery at once.
function replay(throttle: Throttle | undefined): { readonly delivered: readonly Delivery[]; readonly suppressed: number; readonly held: number } {
  const delivered: Delivery[] = [];
  const suppressions: Suppression[] = [];
  const holds: EscalationHold[] = [];
  const times = [...new Set(BURST.sends.map(([second]) => second))];
  for (const second of times) {
    const now = T0 + second * SECOND;
    const done = new Set([...delivered.map((delivery) => delivery.key), ...suppressions.map((suppression) => suppression.key)]);
    const routes = BURST.sends
      .filter(([at]) => at <= second)
      .map(([at, level, index, episode]) => entry(1000 + index, { level, due: T0 + at * SECOND, episode }))
      .filter((route) => !done.has(messageKey(route.plan.sends[0]!)));
    const limited = limitRoutes({ routes, deliveries: delivered, holds, limits: DEFAULT_SEND_LIMITS, now });
    holds.push(...limited.holds);
    const result = throttle === undefined ? { routes: limited.routes, suppressions: [] } : throttleRoutes({ routes: limited.routes, deliveries: delivered, suppressions, throttle, now });
    suppressions.push(...result.suppressions);
    for (const route of result.routes) for (const send of route.plan.sends) delivered.push({ key: messageKey(send), incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: now, receipt: {} });
  }
  return { delivered, suppressed: suppressions.length, held: holds.length };
}

describe("(a) the replay of the burst of 2026-11-18", () => {
  it("has the shape of the record: 171 messages in its first 22 minutes, of 2 levels", () => {
    expect(BURST.sends.filter(([second]) => second < 22 * 60)).toHaveLength(171);
    expect(new Set(BURST.sends.map(([, level]) => level))).toEqual(new Set(["notice", "urgent"]));
  });

  it("gives at most 2 messages in the first 22 minutes with the default throttle: the first notice and the first urgent alert", () => {
    const { delivered } = replay(DEFAULT_THROTTLE);
    const burst = delivered.filter((delivery) => delivery.at < T0 + 22 * MINUTE);
    expect(burst.map((delivery) => delivery.level)).toEqual(["notice", "urgent"]);
    // Over the 4 hours of the record, each window of 30 minutes has at most one message of each level.
    expect(delivered.length).toBeLessThanOrEqual(4);
    for (const one of delivered) {
      const window = delivered.filter((delivery) => delivery.level === one.level && delivery.at > one.at - DEFAULT_THROTTLE.window && delivery.at <= one.at);
      expect(window).toHaveLength(1);
    }
  });

  it("gives each other send a hold or a suppression, thus the digest tells each incident", () => {
    const { delivered, suppressed, held } = replay(DEFAULT_THROTTLE);
    expect(delivered.length + suppressed + held).toBe(BURST.sends.length);
  });

  it("gives more messages with only the send limit, as before part 4", () => {
    // The send limit counts the incidents in one hour: 6 at notice. A new episode of a counted incident takes a place too.
    const { delivered } = replay(undefined);
    expect(delivered.filter((delivery) => delivery.at < T0 + 22 * MINUTE).length).toBeGreaterThanOrEqual(DEFAULT_SEND_LIMITS.notice);
  });

  it("reaches 2 messages at a window of 15 minutes, and not at 10 minutes: the two waves of the burst are 9 minutes apart", () => {
    const count = (minutes: number): number => replay({ ...DEFAULT_THROTTLE, window: minutes * MINUTE }).delivered.filter((delivery) => delivery.at < T0 + 22 * MINUTE).length;
    expect(count(10)).toBeGreaterThan(2);
    expect(count(15)).toBe(2);
  });
});
