import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type {
  Acknowledgment,
  ChannelDescriptor,
  ChannelId,
  Delivery,
  EscalationPolicy,
  Incident,
  Level,
  MergeState,
  PersonId,
  PlaceId,
  Report,
  ReportId,
  WatchedPlace,
} from "./contracts.ts";
import { LEVELS } from "./contracts.ts";
import { acknowledgmentOf, messageOf, recipientProblems, route, type EscalationStart, type Recipient, type Route, type RouteInput } from "./delivery.ts";
import { messageKey } from "./ids.ts";
import { placeWhy } from "./why.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 3, 1, 18);
const anchor = "a".repeat(64) as ReportId;
const merged = "b".repeat(64) as ReportId;
const pushover = "pushover" as ChannelId;
const sms = "sms" as ChannelId;

// A public place in Kansas: Sedgwick County.
const home = "place-1" as PlaceId;
const places: readonly WatchedPlace[] = [{ id: home, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 5 }];
const atHome = [{ type: "code", system: "ugc", code: "KSC173" }] as const;

const LIFE_SAFETY: EscalationPolicy = {
  level: "life-safety",
  steps: [
    { channel: pushover, at: 0 },
    { channel: sms, at: 5 * MINUTE },
  ],
  exhaustedAfter: 20 * MINUTE,
};
const URGENT: EscalationPolicy = { level: "urgent", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 10 * MINUTE };

function recipient(person = "person-1", policies: readonly EscalationPolicy[] = [LIFE_SAFETY, URGENT], watched: readonly PlaceId[] = [home]): Recipient {
  return { watch: { person: person as PersonId, places: watched, rules: [] }, policies, addresses: { pushover: { user: "fake-user" }, sms: { to: "fake-number" } } };
}

function channel(id: ChannelId, ack: ChannelDescriptor["ack"]): ChannelDescriptor {
  return { id, title: id, dependsOn: [], uses: ["internet"], breaksThrough: true, repeats: ack === "poll", ack, maxTitle: 250, maxBody: 1024 };
}
const CHANNELS = [channel(pushover, "poll"), channel(sms, "none")];

// A tornado warning gives `life-safety`, and a tornado watch gives `urgent`.
const WARNING = { severity: "extreme", urgency: "immediate" } as const;
const WATCH = { severity: "extreme", urgency: "future" } as const;

function incident(fields: Partial<Incident> = {}): Incident {
  return {
    anchor,
    reports: [anchor, merged],
    status: "actual",
    kind: { code: "met.tornado", label: "Tornado" },
    ...WARNING,
    certainty: "observed",
    areas: atHome,
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

const person = "person-1" as PersonId;

function delivery(level: Level, step: number, at: number, extra: Partial<Delivery> = {}): Delivery {
  return { key: messageKey({ incident: anchor, level, person, step }), incident: anchor, level, person, channel: pushover, step, at, receipt: { receipt: `r-${level}-${step}` }, ...extra };
}

function start(level: Level, at: number, incidentId: ReportId = anchor): EscalationStart {
  return { incident: incidentId, level, person, at };
}

function input(extra: Partial<RouteInput> & { readonly merge?: Partial<MergeState> } = {}): RouteInput {
  const { merge, ...rest } = extra;
  return {
    state: { reports: [], deliveries: [], acks: [], ends: [], ...merge },
    incidents: [incident()],
    recipients: [recipient()],
    places,
    starts: [],
    cancelled: new Set(),
    channels: CHANNELS,
    now: T0,
    ...rest,
  };
}

const summary = (routes: readonly Route[]) =>
  routes.map((entry) => ({ level: entry.policy.level, state: entry.plan.state, fresh: entry.fresh, sends: entry.plan.sends.map((send) => send.step), cancels: entry.plan.cancels.map((d) => d.key) }));

describe("route", () => {
  it("starts a new escalation at the assessed level, and sends its first step", () => {
    const routes = route(input());
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "sent", fresh: true, sends: [0], cancels: [] }]);
    expect(routes[0]!.start).toEqual(start("life-safety", T0));
    expect(routes[0]!.plan.wakeAt).toBe(T0 + 5 * MINUTE);
  });

  it("gives the why of the matched place with the first id, whatever the order of the places of the person", () => {
    const lake = "place-0" as PlaceId;
    const both: readonly WatchedPlace[] = [...places, { id: lake, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 5 }];
    const routes = route(input({ places: both, recipients: [recipient("person-1", [LIFE_SAFETY, URGENT], [home, lake])] }));
    expect(routes[0]!.why).toEqual(placeWhy([lake]));
    expect(routes[0]!.why).toEqual({ rule: "reach.place.places", subject: "place:place-0", kind: "place", anchor: "place:place-0", origin: "places", coverage: 1 });
    expect(route(input())[0]!.why?.anchor).toBe("place:place-1");
  });

  it("gives no why to a match by subjects alone, and none to an incident that is over", () => {
    const operator = recipient("person-1", [LIFE_SAFETY, URGENT], []);
    const watching: Recipient = { ...operator, watch: { ...operator.watch, subjects: [{ system: "alerts.source" }] } };
    const about = incident({ areas: [], about: [{ system: "alerts.source", id: "source-1" }] });
    const routes = route(input({ incidents: [about], recipients: [watching] }));
    expect(routes).toHaveLength(1);
    expect(routes[0]!.why).toBeUndefined();
    const sent = [delivery("life-safety", 0, T0)];
    const over = incident({ live: false, expires: T0 + MINUTE });
    const ended = route(input({ incidents: [over], starts: [start("life-safety", T0)], merge: { deliveries: sent }, now: T0 + 3 * MINUTE }));
    expect(ended).toHaveLength(1);
    expect(ended[0]!.why).toBeUndefined();
  });

  it("routes an incident by a topic alone, with no area and no place of the person", () => {
    const base = recipient("person-1", [LIFE_SAFETY, URGENT], []);
    const follower: Recipient = { ...base, watch: { ...base.watch, subjects: [{ system: "topic", id: "infra.power.outage" }] } };
    // A power cut has no class of its own. Thus the table of the other kinds gives it `urgent` at most.
    const outage = incident({ kind: { code: "infra.power.outage", label: "Power outage" }, areas: [], about: [{ system: "topic", id: "infra.power.outage" }] });
    const routes = route(input({ incidents: [outage], recipients: [follower] }));
    expect(summary(routes)).toEqual([{ level: "urgent", state: "last", fresh: true, sends: [0], cancels: [] }]);
    expect(routes[0]!.start).toEqual(start("urgent", T0));
    // The why of a topic comes with the relevance step of AL-35. A match by a topic alone has no why at this time.
    expect(routes[0]!.why).toBeUndefined();
    // A topic of a life-safety kind escalates as a place does: the first step at once, the second step after 5 minutes.
    const storm: Recipient = { ...base, watch: { ...base.watch, subjects: [{ system: "topic", id: "met.tornado" }] } };
    const tornado = incident({ areas: [], about: [{ system: "topic", id: "met.tornado" }] });
    const first = route(input({ incidents: [tornado], recipients: [storm] }));
    expect(summary(first)).toEqual([{ level: "life-safety", state: "sent", fresh: true, sends: [0], cancels: [] }]);
    expect(first[0]!.plan.wakeAt).toBe(T0 + 5 * MINUTE);
    const later = route(input({ incidents: [tornado], recipients: [storm], starts: [start("life-safety", T0)], now: T0 + 6 * MINUTE }));
    expect(summary(later)).toEqual([{ level: "life-safety", state: "last", fresh: false, sends: [0, 1], cancels: [] }]);
  });

  it("matches a topic by its system and its id, and a watch of a system with no id matches each topic", () => {
    const base = recipient("person-1", [LIFE_SAFETY, URGENT], []);
    const watching = (subjects: NonNullable<Recipient["watch"]["subjects"]>): Recipient => ({ ...base, watch: { ...base.watch, subjects } });
    const flood = incident({ areas: [], about: [{ system: "topic", id: "met.flood" }] });
    expect(route(input({ incidents: [flood], recipients: [watching([{ system: "topic", id: "met.tornado" }])] }))).toEqual([]);
    expect(route(input({ incidents: [flood], recipients: [watching([{ system: "iptc", id: "met.flood" }])] }))).toEqual([]);
    expect(route(input({ incidents: [flood], recipients: [watching([{ system: "topic" }])] }))).toHaveLength(1);
    expect(route(input({ incidents: [flood], recipients: [base] }))).toEqual([]);
  });

  it("reaches a person by a topic when no place of the person is in the area, and gives the why of a place in the area", () => {
    const base = recipient();
    const follower: Recipient = { ...base, watch: { ...base.watch, subjects: [{ system: "topic", id: "met.tornado" }] } };
    // Harvey County, Kansas: a county next to the place of the person.
    const elsewhere = incident({ areas: [{ type: "code", system: "ugc", code: "KSC079" }], about: [{ system: "topic", id: "met.tornado" }] });
    const far = route(input({ incidents: [elsewhere], recipients: [follower] }));
    expect(summary(far)).toEqual([{ level: "life-safety", state: "sent", fresh: true, sends: [0], cancels: [] }]);
    expect(far[0]!.why).toBeUndefined();
    // Without the topic, the incident does not reach the person.
    expect(route(input({ incidents: [elsewhere] }))).toEqual([]);
    const near = route(input({ incidents: [incident({ about: [{ system: "topic", id: "met.tornado" }] })], recipients: [follower] }));
    expect(near[0]!.why).toEqual(placeWhy([home]));
  });

  it("keeps the start of the log, thus a step comes at its time after a restart", () => {
    const routes = route(input({ starts: [start("life-safety", T0)], now: T0 + 6 * MINUTE }));
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "last", fresh: false, sends: [0, 1], cancels: [] }]);
    expect(routes[0]!.start.at).toBe(T0);
  });

  it("finds a start of a merged report of the incident", () => {
    const routes = route(input({ starts: [start("life-safety", T0, merged)], now: T0 + MINUTE }));
    expect(routes[0]!.fresh).toBe(false);
    expect(routes[0]!.start).toEqual(start("life-safety", T0, merged));
  });

  it("starts nothing for a level with no policy of the person", () => {
    expect(route(input({ recipients: [recipient("person-1", [URGENT])] }))).toEqual([]);
  });

  it("starts nothing for a person who does not watch the place", () => {
    expect(route(input({ recipients: [recipient("person-1", [LIFE_SAFETY], [])] }))).toEqual([]);
  });

  it("ends a lower level at the start of a higher level, and cancels its deliveries", () => {
    const routes = route(input({ starts: [start("urgent", T0)], merge: { deliveries: [delivery("urgent", 0, T0)] }, now: T0 + 10 * MINUTE }));
    expect(summary(routes)).toEqual([
      { level: "urgent", state: "ended", fresh: false, sends: [], cancels: [delivery("urgent", 0, T0).key] },
      { level: "life-safety", state: "sent", fresh: true, sends: [0], cancels: [] },
    ]);
  });

  it("does not go down: a higher level of the log continues when the assessed level is lower", () => {
    const routes = route(input({ incidents: [incident(WATCH)], starts: [start("life-safety", T0)], merge: { deliveries: [delivery("life-safety", 0, T0)] }, now: T0 + 6 * MINUTE }));
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "last", fresh: false, sends: [1], cancels: [] }]);
  });

  it("polls each open delivery of a channel that polls, until the acknowledgment", () => {
    const sent = [delivery("life-safety", 0, T0), delivery("life-safety", 1, T0 + 5 * MINUTE, { channel: sms })];
    const open = route(input({ starts: [start("life-safety", T0)], merge: { deliveries: sent }, now: T0 + 6 * MINUTE }));
    expect(open[0]!.polls).toEqual([sent[0]]);
    const cancelled = route(input({ starts: [start("life-safety", T0)], merge: { deliveries: sent }, cancelled: new Set([sent[0]!.key]), now: T0 + 6 * MINUTE }));
    expect(cancelled[0]!.polls).toEqual([]);

    const acknowledged: Acknowledgment = { incident: merged, level: "life-safety", person, at: T0 + 2 * MINUTE, via: pushover };
    const after = route(input({ starts: [start("life-safety", T0)], merge: { deliveries: sent, acks: [acknowledged] }, now: T0 + 6 * MINUTE }));
    expect(summary(after)).toEqual([{ level: "life-safety", state: "acknowledged", fresh: false, sends: [], cancels: sent.map((d) => d.key) }]);
    expect(after[0]!.polls).toEqual([]);
  });

  it("cancels the deliveries of an incident that is over, and then gives it no route", () => {
    const sent = [delivery("life-safety", 0, T0)];
    const over = incident({ live: false, expires: T0 + MINUTE });
    const routes = route(input({ incidents: [over], starts: [start("life-safety", T0)], merge: { deliveries: sent }, now: T0 + 3 * MINUTE }));
    expect(summary(routes)).toEqual([{ level: "life-safety", state: "ended", fresh: false, sends: [], cancels: [sent[0]!.key] }]);
    expect(route(input({ incidents: [over], starts: [start("life-safety", T0)], merge: { deliveries: sent }, cancelled: new Set([sent[0]!.key]), now: T0 + 3 * MINUTE }))).toEqual([]);
    expect(route(input({ incidents: [over] }))).toEqual([]);
  });

  it("gives the same routes for each order of the incidents and the recipients", () => {
    const second = incident({ anchor: "c".repeat(64) as ReportId, reports: ["c".repeat(64) as ReportId] });
    const people = [recipient("person-1"), recipient("person-2")];
    const a = route(input({ incidents: [incident(), second], recipients: people }));
    const b = route(input({ incidents: [second, incident()], recipients: [...people].reverse() }));
    expect(b).toEqual(a);
    expect(a.map((entry) => [entry.incident.anchor[0], entry.person])).toEqual([
      ["a", "person-1"],
      ["a", "person-2"],
      ["c", "person-1"],
      ["c", "person-2"],
    ]);
  });

  it("holds its laws over seeded histories of an incident", () => {
    for (const seed of SEEDS) {
      const r = random(`route:${seed}`);
      const starts: EscalationStart[] = [];
      const deliveries: Delivery[] = [];
      const acks: Acknowledgment[] = [];
      const cancelled = new Set<string>();
      let phase: "warning" | "watch" | "over" = "watch";
      let top = -1;
      let acknowledgedAt: number | undefined;
      for (let step = 0; step < 60; step += 1) {
        const now = T0 + step * MINUTE;
        if (r.chance(0.15)) phase = r.pick(["warning", "watch", "over"] as const);
        const current = phase === "over" ? incident({ live: false, expires: now }) : incident(phase === "warning" ? WARNING : WATCH);
        const routes = route(input({ incidents: [current], merge: { deliveries, acks }, starts, cancelled, now }));
        const context = `seed ${seed}, minute ${step}`;

        // Only the highest level continues, and the level does not go down.
        const open = routes.filter((entry) => entry.plan.state !== "acknowledged" && entry.plan.state !== "ended");
        expect(open.length, context).toBeLessThanOrEqual(1);
        const levels = routes.map((entry) => LEVELS.indexOf(entry.policy.level));
        const highest = Math.max(-1, ...levels);
        expect(highest, context).toBeGreaterThanOrEqual(phase === "over" ? -1 : top);
        if (routes.length > 0) top = Math.max(top, highest);
        for (const entry of routes) {
          if (LEVELS.indexOf(entry.policy.level) < highest) expect(entry.plan.sends, context).toEqual([]);
          // A new start is at the highest level only.
          if (entry.fresh) expect(LEVELS.indexOf(entry.policy.level), context).toBe(highest);
          // A start of the log does not move.
          const logged = starts.find((item) => item.level === entry.policy.level);
          if (logged !== undefined) expect(entry.start.at, context).toBe(logged.at);
          // An escalation that is over cancels each delivery with no cancel.
          if (entry.plan.state === "acknowledged" || entry.plan.state === "ended") {
            expect(new Set(entry.plan.cancels.map((d) => d.key)), context).toEqual(new Set(entry.deliveries.filter((d) => !cancelled.has(d.key)).map((d) => d.key)));
          }
        }
        // An acknowledgment of the highest level stops each send.
        if (acknowledgedAt !== undefined) expect(routes.flatMap((entry) => entry.plan.sends), context).toEqual([]);

        // The runtime: it writes the new starts, sends with some failures, cancels, and the person acknowledges at times.
        for (const entry of routes) {
          if (entry.fresh) starts.push(entry.start);
          for (const send of entry.plan.sends) {
            if (r.chance(0.2)) continue;
            deliveries.push({ key: messageKey(send), incident: send.incident, level: send.level, person: send.person, channel: send.channel, step: send.step, at: now, receipt: { receipt: `${send.level}:${send.step}` } });
          }
          for (const done of entry.plan.cancels) cancelled.add(done.key);
          const ours = entry.deliveries.length > 0 && LEVELS.indexOf(entry.policy.level) === LEVELS.length - 1;
          if (ours && acknowledgedAt === undefined && r.chance(0.1)) {
            acknowledgedAt = now;
            acks.push({ incident: anchor, level: entry.policy.level, person, at: now, via: pushover });
          }
        }
      }
      expect(starts.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });
});

describe("recipientProblems", () => {
  it("finds a repeated level, a channel that does not exist and a missing address", () => {
    const fax = "fax" as ChannelId;
    const broken: Recipient = {
      ...recipient("person-1", [LIFE_SAFETY, { level: "life-safety", steps: [{ channel: fax, at: 0 }], exhaustedAfter: 0 }]),
      addresses: { pushover: { user: "fake-user" } },
    };
    expect(recipientProblems(broken, CHANNELS)).toEqual([
      "Step 1 of life-safety uses the channel sms, and the person has no address on it.",
      "Two policies have the level life-safety. Only the first one applies.",
      "Step 0 of life-safety uses the channel fax, and the system has no such channel.",
      "Step 0 of life-safety uses the channel fax, and the person has no address on it.",
    ]);
    expect(recipientProblems(recipient(), CHANNELS)).toEqual([]);
  });

  it("finds a kind of a rule that the taxonomy does not have", () => {
    const base = recipient();
    const typo: Recipient = { ...base, watch: { ...base.watch, rules: [{ kinds: ["met", "met.tornado"], max: "life-safety" }, { kinds: ["met.tornadoo"], max: "urgent" }] } };
    expect(recipientProblems(typo, CHANNELS)).toEqual(["Rule 1 names the kind met.tornadoo, and the taxonomy has no such code. The rule matches no alert of it."]);
  });

  it("finds a person who watches a place or a subject and has no life-safety policy", () => {
    const missing = "The person watches a place or a subject, and has no policy of the level life-safety. A life-safety alert sends nothing to the person.";
    expect(recipientProblems(recipient("person-1", [URGENT]), CHANNELS)).toEqual([missing]);
    const operator = recipient("person-1", [URGENT], []);
    expect(recipientProblems({ ...operator, watch: { ...operator.watch, subjects: [{ system: "alerts.source" }] } }, CHANNELS)).toEqual([missing]);
    // A person who watches nothing gets no alert, thus no level is missing.
    expect(recipientProblems(recipient("person-1", [URGENT], []), CHANNELS)).toEqual([]);
  });

  it("finds a rule that keeps a life-safety kind below life-safety", () => {
    const base = recipient();
    const rules = (...list: Recipient["watch"]["rules"]): Recipient => ({ ...base, watch: { ...base.watch, rules: list } });
    const keeps = (index: number, kinds: string, max: string): string => `Rule ${index} keeps ${kinds} at ${max} or lower. A life-safety kind is in it, and a rule does not keep a life-safety kind below life-safety.`;
    expect(recipientProblems(rules({ max: "urgent" }), CHANNELS)).toEqual([keeps(0, "each kind", "urgent")]);
    // A prefix above a life-safety kind, a code below one, and the coverage of one overlap it.
    expect(recipientProblems(rules({ kinds: ["met.wind", "met.heat"], max: "notice" }, { kinds: ["cbrne.radiological"], max: "urgent" }, { kinds: ["system.coverage"], max: "digest" }), CHANNELS)).toEqual([
      keeps(0, "met.wind", "notice"),
      keeps(1, "cbrne.radiological", "urgent"),
      keeps(2, "system.coverage", "digest"),
    ]);
    // A rule at a place that the person watches keeps the kinds there.
    expect(recipientProblems(rules({ places: ["place-9" as PlaceId, home], kinds: ["met"], max: "urgent" }), CHANNELS)).toEqual([keeps(0, "met", "urgent")]);
    // A rule at life-safety, a rule of other kinds, and a rule with no watched place or no kind keep nothing.
    expect(
      recipientProblems(rules({ max: "life-safety" }, { kinds: ["met.heat", "system.health"], max: "notice" }, { places: [], max: "digest" }, { places: ["place-9" as PlaceId], max: "digest" }, { kinds: [], max: "digest" }), CHANNELS),
    ).toEqual([]);
  });

  it("finds a bad quiet window", () => {
    const base = recipient();
    const quiet = (zone: string, start: string, end: string): Recipient => ({ ...base, watch: { ...base.watch, quiet: { zone, start, end } } });
    expect(recipientProblems(quiet("America/Chicago", "22:00", "07:00"), CHANNELS)).toEqual([]);
    const problems = recipientProblems(quiet("America/Chicagoo", "22:00", "7:00"), CHANNELS);
    expect(problems.length).toBeGreaterThanOrEqual(2);
    for (const problem of problems) expect(problem).toMatch(/^The quiet window: /);
  });
});

function report(id: ReportId, fields: Partial<Report> = {}): Report {
  return {
    id,
    source: "nws-api" as Report["source"],
    origin: "nws",
    key: id,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado" },
    categories: ["met"],
    ...WARNING,
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received: T0,
    areas: atHome,
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning issued April 1 at 1:00PM CDT by NWS Wichita KS",
    observation: "obs" as Report["observation"],
    parameters: {},
    ...fields,
  };
}

describe("messageOf", () => {
  const send = { incident: anchor, level: "life-safety", person, step: 0, channel: pushover, due: T0, quiet: false } as const;

  it("takes the text of the latest report at the severity and the urgency of the incident", () => {
    const reports = [
      report(anchor, { sent: T0, headline: "First" }),
      report(merged, { sent: T0 + MINUTE, headline: "Update", instruction: "TAKE COVER NOW!", areaText: "Sedgwick, KS", description: "A tornado was seen.", web: "https://www.weather.gov/" }),
      report("c".repeat(64) as ReportId, { sent: T0 + 2 * MINUTE, headline: "Not a member" }),
      report("d".repeat(64) as ReportId, { ...WATCH, sent: T0 + 3 * MINUTE, headline: "Lower" }),
    ];
    const members = incident({ reports: [anchor, merged, "d".repeat(64) as ReportId], expires: T0 + 30 * MINUTE });
    expect(messageOf(members, reports, send)).toEqual({
      key: messageKey(send),
      person,
      level: "life-safety",
      title: "Update",
      body: "TAKE COVER NOW!\n\nSedgwick, KS\n\nA tornado was seen.",
      url: "https://www.weather.gov/",
      incident: anchor,
      expires: T0 + 30 * MINUTE,
      quiet: false,
    });
    // The why line of the channel goes into its own field. An empty line gives no field.
    expect(messageOf(members, reports, send, "Why: your place is in the area").why).toBe("Why: your place is in the area");
    expect("why" in messageOf(members, reports, send, "")).toBe(false);
  });

  it("uses the label of the kind when no report of the incident is in the state", () => {
    const message = messageOf(incident(), [], { ...send, quiet: true });
    expect(message.title).toBe("Tornado");
    expect(message.body).toBe("");
    expect(message.quiet).toBe(true);
    expect(message).not.toHaveProperty("url");
  });
});

describe("acknowledgmentOf", () => {
  it("gives an acknowledgment only for the state acknowledged", () => {
    const sent = delivery("life-safety", 0, T0);
    expect(acknowledgmentOf(sent, { state: "acknowledged", at: T0 + MINUTE, by: "phone" })).toEqual({ incident: anchor, level: "life-safety", person, at: T0 + MINUTE, via: pushover });
    for (const state of ["accepted", "delivered", "expired", "failed"] as const) expect(acknowledgmentOf(sent, { state, at: T0 })).toBeUndefined();
  });
});
