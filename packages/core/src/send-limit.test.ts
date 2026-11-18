import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { ChannelDescriptor, ChannelId, CopyWatch, Delivery, EscalationPolicy, Incident, Level, PersonId, PlaceId, ReportId, WatchedPlace } from "./contracts.ts";
import { exhaustions, route, type EscalationEnd, type EscalationHold, type EscalationStart, type Recipient, type Route } from "./delivery.ts";
import { planDigests } from "./digest.ts";
import { messageKey } from "./ids.ts";
import { DEFAULT_SEND_LIMITS, holdKey, isLimitedLevel, limitRoutes, limitShare, sendLimitProblems, sendLimitsOf, type SendLimits } from "./send-limit.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 3, 1, 18);

const pushover = "pushover" as ChannelId;
const person = "person-1" as PersonId;
const other = "person-2" as PersonId;
const home = "place-1" as PlaceId;
const places: readonly WatchedPlace[] = [{ id: home, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 5 }];
const atHome = [{ type: "code", system: "ugc", code: "KSC173" }] as const;

// A made-up report id for each index.
const idOf = (index: number): ReportId => index.toString(16).padStart(64, "0") as ReportId;

const policyOf = (level: Level): EscalationPolicy => ({ level, steps: [{ channel: pushover, at: 0 }, { channel: pushover, at: 5 * MINUTE }], exhaustedAfter: 10 * MINUTE });

function sent(incident: ReportId, level: Level, at: number, who: PersonId = person, step = 0): Delivery {
  return { key: messageKey({ incident, level, person: who, step }), incident, level, person: who, channel: pushover, step, at, receipt: {} };
}

// A route of an escalation, as `route` gives it. With `delivered`, the episode has a delivery of step 0.
function entry(index: number, options: { readonly level?: Level; readonly due?: number; readonly who?: PersonId; readonly episode?: number; readonly delivered?: number } = {}): Route {
  const { level = "notice", due = T0, who = person, episode = 0, delivered } = options;
  const incident: Incident = {
    anchor: idOf(index),
    reports: [idOf(index)],
    status: "actual",
    kind: { code: "met.flood", label: "Flood" },
    severity: "moderate",
    urgency: "expected",
    certainty: "observed",
    areas: atHome,
    about: [],
    live: true,
    corroboration: 1,
  };
  const deliveries = delivered === undefined ? [] : [sent(idOf(index), level, delivered, who)];
  const step = deliveries.length;
  return {
    incident,
    person: who,
    policy: policyOf(level),
    start: { incident: idOf(index), level, person: who, at: due },
    fresh: delivered === undefined,
    deliveries,
    polls: [],
    plan: {
      state: delivered === undefined ? "idle" : "sent",
      start: due,
      due: [due, due + 5 * MINUTE],
      sends: [{ incident: idOf(index), level, person: who, step, channel: pushover, due: due + step * 5 * MINUTE, wait: 0, quiet: false }],
      cancels: [],
      transitions: [],
    },
    episode,
    freshEnd: false,
  };
}

const heldOf = (routes: readonly Route[]): string[] => routes.filter((item) => item.held !== undefined).map((item) => `${item.incident.anchor.slice(-2)}:${item.person}:${String(item.episode)}`);
const LIMITS: SendLimits = { window: HOUR, notice: 3, urgent: 5 };

describe("limitRoutes", () => {
  it("admits the new escalations of each person and level up to the limit, and holds the rest", () => {
    const routes = [...Array.from({ length: 5 }, (_, index) => entry(index, { due: T0 + index })), ...Array.from({ length: 6 }, (_, index) => entry(10 + index, { level: "urgent", due: T0 + index }))];
    const result = limitRoutes({ routes, deliveries: [], holds: [], limits: LIMITS, now: T0 + HOUR });
    expect(heldOf(result.routes)).toEqual(["03:person-1:0", "04:person-1:0", "0f:person-1:0"]);
    for (const item of result.routes.filter((route) => route.held !== undefined)) {
      expect(item.plan.sends).toEqual([]);
      expect(item.held).toEqual({ incident: item.start.incident, level: item.policy.level, person, episode: 0, at: T0 + HOUR });
    }
    expect(result.holds.map((hold) => hold.incident)).toEqual([idOf(3), idOf(4), idOf(15)]);
    expect(result.routes.filter((route) => route.held === undefined).every((route) => route.plan.sends.length === 1)).toBe(true);
  });

  it("gives each person a count of its own", () => {
    const routes = [...Array.from({ length: 4 }, (_, index) => entry(index)), ...Array.from({ length: 4 }, (_, index) => entry(index, { who: other }))];
    const result = limitRoutes({ routes, deliveries: [], holds: [], limits: LIMITS, now: T0 });
    expect(heldOf(result.routes)).toEqual(["03:person-1:0", "03:person-2:0"]);
  });

  it("counts each incident with a delivery in the window, also a delivery of another copy, and one time for each incident", () => {
    const deliveries = [sent(idOf(50), "notice", T0 - 10 * MINUTE), sent(idOf(50), "notice", T0 - 5 * MINUTE, person, 1), sent(idOf(51), "notice", T0 - 30 * MINUTE), sent(idOf(52), "notice", T0 - 2 * HOUR), sent(idOf(53), "urgent", T0 - MINUTE), sent(idOf(54), "notice", T0, other)];
    const routes = Array.from({ length: 3 }, (_, index) => entry(index));
    // Two incidents in the window: 50 and 51. Incident 52 is older than the window, and 53 and 54 are of another level or person.
    expect(heldOf(limitRoutes({ routes, deliveries, holds: [], limits: LIMITS, now: T0 }).routes)).toEqual(["01:person-1:0", "02:person-1:0"]);
    // The delivery of incident 51 is out of the window after one hour, thus only incident 50 counts.
    expect(heldOf(limitRoutes({ routes, deliveries, holds: [], limits: LIMITS, now: T0 + 30 * MINUTE + 1 }).routes)).toEqual(["02:person-1:0"]);
    // The first delivery of incident 50 is then out of the window, but its later delivery is in the window. Thus it still counts.
    expect(heldOf(limitRoutes({ routes, deliveries, holds: [], limits: LIMITS, now: T0 + 50 * MINUTE + 1 }).routes)).toEqual(["02:person-1:0"]);
    // After its later delivery, no delivery of the person is in the window.
    expect(heldOf(limitRoutes({ routes, deliveries, holds: [], limits: LIMITS, now: T0 + 55 * MINUTE + 1 }).routes)).toEqual([]);
  });

  it("does not hold an escalation with a delivery in its episode, thus its later steps go when the count is full", () => {
    const deliveries = Array.from({ length: 3 }, (_, index) => sent(idOf(40 + index), "notice", T0 - MINUTE));
    const admitted = entry(7, { delivered: T0 - 2 * MINUTE });
    const result = limitRoutes({ routes: [admitted, entry(8)], deliveries: [...deliveries, ...admitted.deliveries], holds: [], limits: LIMITS, now: T0 });
    expect(result.routes[0]).toBe(admitted);
    expect(heldOf(result.routes)).toEqual(["08:person-1:0"]);
  });

  it("holds an escalation with a hold in the log, and gives no second hold", () => {
    const hold: EscalationHold = { incident: idOf(1), level: "notice", person, episode: 0, at: T0 - HOUR };
    const result = limitRoutes({ routes: [entry(1), entry(2)], deliveries: [], holds: [hold], limits: LIMITS, now: T0 });
    expect(result.routes[0]!.held).toEqual(hold);
    expect(result.routes[0]!.plan.sends).toEqual([]);
    expect(result.routes[1]!.held).toBeUndefined();
    expect(result.holds).toEqual([]);
    // The hold is for its episode only: a later episode is a new escalation.
    expect(limitRoutes({ routes: [entry(1, { episode: 1 })], deliveries: [], holds: [hold], limits: LIMITS, now: T0 }).routes[0]!.held).toBeUndefined();
  });

  it("never holds a life-safety escalation", () => {
    const routes = Array.from({ length: 40 }, (_, index) => entry(index, { level: "life-safety" }));
    const result = limitRoutes({ routes, deliveries: [], holds: [], limits: LIMITS, now: T0 });
    expect(result.routes).toBe(routes);
    expect(result.holds).toEqual([]);
    expect(isLimitedLevel("life-safety")).toBe(false);
    expect(isLimitedLevel("digest")).toBe(false);
  });

  it("takes the share of the copy, and keeps one place at least", () => {
    const routes = Array.from({ length: 12 }, (_, index) => entry(index, { level: "urgent", due: T0 + index }));
    const half = limitRoutes({ routes, deliveries: [], holds: [], limits: { ...LIMITS, urgent: 10 }, share: 0.5, now: T0 });
    expect(half.routes.filter((item) => item.held === undefined)).toHaveLength(5);
    const tiny = limitRoutes({ routes, deliveries: [], holds: [], limits: { ...LIMITS, urgent: 1 }, share: 0.5, now: T0 });
    expect(tiny.routes.filter((item) => item.held === undefined)).toHaveLength(1);
    // A share that is not above 0 and at most 1 counts as 1.
    expect(limitRoutes({ routes, deliveries: [], holds: [], limits: { ...LIMITS, urgent: 10 }, share: 0, now: T0 }).holds).toHaveLength(2);
  });

  it("gives the same holds for each order of the routes", () => {
    const routes = Array.from({ length: 30 }, (_, index) => entry(index % 15, { level: index % 2 === 0 ? "notice" : "urgent", due: T0 + (index % 7) * MINUTE, who: index < 15 ? person : other }));
    const key = (holds: readonly EscalationHold[]): string[] => holds.map((hold) => holdKey(hold)).sort();
    const expected = key(limitRoutes({ routes, deliveries: [], holds: [], limits: LIMITS, now: T0 }).holds);
    expect(expected.length).toBeGreaterThan(0);
    for (const seed of SEEDS) {
      const rng = random(seed);
      const shuffled = routes.map((item) => ({ item, at: rng.next() })).sort((a, b) => a.at - b.at).map(({ item }) => item);
      expect(key(limitRoutes({ routes: shuffled, deliveries: [], holds: [], limits: LIMITS, now: T0 }).holds), `seed ${String(seed)}`).toEqual(expected);
    }
  });

  it("keeps the place of an admitted send with no delivery yet over the next passes", () => {
    // Pass 1 admits 0, 1 and 2. The send of 2 fails, thus it has no delivery. Pass 2 has a later incident 3.
    const first = limitRoutes({ routes: [entry(0), entry(1), entry(2)], deliveries: [], holds: [], limits: LIMITS, now: T0 });
    expect(first.holds).toEqual([]);
    const deliveries = [sent(idOf(0), "notice", T0), sent(idOf(1), "notice", T0)];
    const second = limitRoutes({ routes: [entry(0, { delivered: T0 }), entry(1, { delivered: T0 }), entry(2), entry(3, { due: T0 + MINUTE })], deliveries, holds: [], limits: LIMITS, now: T0 + MINUTE });
    expect(heldOf(second.routes)).toEqual(["03:person-1:0"]);
  });
});

describe("the send limit and route", () => {
  const recipient: Recipient = { watch: { person, places: [home], rules: [] }, policies: [policyOf("notice")], addresses: { pushover: { user: "fake-user" } } };
  const channels: readonly ChannelDescriptor[] = [{ id: pushover, title: "pushover", dependsOn: [], uses: ["internet"], breaksThrough: false, repeats: false, ack: "none", maxTitle: 250, maxBody: 1024 }];
  const incidents = Array.from({ length: 20 }, (_, index): Incident => ({ ...entry(index).incident }));
  const base = { incidents, recipients: [recipient], places, cancelled: new Set<string>(), channels };

  it("holds a burst of 20 new incidents to the limit", () => {
    const routes = route({ ...base, state: { reports: [], deliveries: [], acks: [], ends: [], retired: [] }, starts: [], now: T0 });
    expect(routes).toHaveLength(20);
    const result = limitRoutes({ routes, deliveries: [], holds: [], now: T0 });
    expect(result.routes.filter((item) => item.held === undefined)).toHaveLength(DEFAULT_SEND_LIMITS.notice);
    expect(result.holds).toHaveLength(20 - DEFAULT_SEND_LIMITS.notice);
  });

  it("holds the episodes that a rollback opens again after the ends of a newer copy", () => {
    // Episode 0 of each incident sent at T0, and each one ended at T0 + 1 minute. The incidents are still live: an older
    // copy that misses the cause of the ends opens episode 1 of each one.
    const starts: EscalationStart[] = incidents.map((incident) => ({ incident: incident.anchor, level: "notice", person, at: T0 }));
    const deliveries = incidents.map((incident) => sent(incident.anchor, "notice", T0));
    const ends: EscalationEnd[] = incidents.map((incident) => ({ incident: incident.anchor, person, at: T0 + MINUTE }));
    const now = T0 + 2 * MINUTE;
    const routes = route({ ...base, state: { reports: [], deliveries, acks: [], ends: [], retired: [] }, starts, ends, now });
    const opened = routes.filter((item) => item.episode === 1 && item.plan.sends.length > 0);
    expect(opened).toHaveLength(20);
    const result = limitRoutes({ routes, deliveries, holds: [], now });
    expect(result.routes.filter((item) => item.episode === 1 && item.plan.sends.length > 0)).toEqual([]);
    expect(result.holds).toHaveLength(20);
    expect(result.holds.every((hold) => hold.episode === 1)).toBe(true);
  });

  it("keeps a held escalation out of the exhaustions, and the digest tells it", () => {
    const held = limitRoutes({ routes: [entry(1)], deliveries: [], holds: [], limits: { ...LIMITS, notice: 1 }, now: T0 }).routes;
    expect(held[0]!.held).toBeUndefined();
    const full = limitRoutes({ routes: [entry(1)], deliveries: [sent(idOf(9), "notice", T0)], holds: [], limits: { ...LIMITS, notice: 1 }, now: T0 }).routes;
    const exhausted: Route = { ...full[0]!, plan: { ...full[0]!.plan, state: "exhausted", exhaustedAt: T0 } };
    expect(exhaustions([exhausted], channels, [])).toEqual([]);

    const digest: EscalationPolicy = { level: "digest", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 0, daily: { zone: "America/Chicago", time: "07:00" } };
    const reader: Recipient = { ...recipient, policies: [policyOf("notice"), digest] };
    const morning = Date.UTC(2026, 3, 2, 12);
    const hold: EscalationHold = { incident: idOf(1), level: "notice", person, episode: 0, at: T0 };
    const state = { reports: [], deliveries: [], acks: [], ends: [], retired: [] };
    const plan = planDigests({ state, incidents: [incidents[1]!], recipients: [reader], places, channels, holds: [hold], now: morning });
    expect(plan.sends.flatMap((send) => send.entries.map((item) => `${item.incident.anchor.slice(-2)}:${item.level}`))).toEqual(["01:notice"]);
    // A message of the incident to the person keeps it out.
    const told = planDigests({ state: { ...state, deliveries: [sent(idOf(1), "urgent", T0)] }, incidents: [incidents[1]!], recipients: [reader], places, channels, holds: [hold], now: morning });
    expect(told.sends).toEqual([]);
  });
});

describe("the configuration of the send limit", () => {
  it("fills each absent field with its default", () => {
    expect(sendLimitsOf(undefined)).toEqual(DEFAULT_SEND_LIMITS);
    expect(sendLimitsOf({ notice: 2 })).toEqual({ ...DEFAULT_SEND_LIMITS, notice: 2 });
  });

  it("gives a problem for a window out of its bounds and for a count below 1", () => {
    expect(sendLimitProblems({ window: HOUR, notice: 1, urgent: 30 })).toEqual([]);
    expect(sendLimitProblems({ window: 1000, notice: 0, urgent: 1.5 })).toEqual([
      "The window of the send limit is 1000 ms. It must be an integer from 60000 to 86400000 ms.",
      "The send limit of the level notice is 0. It must be an integer of 1 or more.",
      "The send limit of the level urgent is 1.5. It must be an integer of 1 or more.",
    ]);
  });
});

describe("limitShare", () => {
  const watch = (read: number | undefined): CopyWatch => ({ copy: "b", skewLimit: 2000, maxAge: MINUTE, since: T0, ...(read === undefined ? {} : { read: { at: read, skew: 0, sameConfig: true } }) });

  it("gives 1 with each other copy read, and a part for each copy that is not read", () => {
    expect(limitShare([], T0)).toBe(1);
    expect(limitShare([watch(T0)], T0 + 30_000)).toBe(1);
    expect(limitShare([watch(T0)], T0 + MINUTE)).toBe(0.5);
    expect(limitShare([watch(undefined), watch(undefined)], T0 + MINUTE)).toBeCloseTo(1 / 3);
  });

  it("gives a part for a copy with no read from the start of its watch, because two copies can start in a split", () => {
    expect(limitShare([watch(undefined)], T0)).toBe(0.5);
    expect(limitShare([watch(undefined), watch(T0)], T0 + 1000)).toBe(0.5);
  });
});
