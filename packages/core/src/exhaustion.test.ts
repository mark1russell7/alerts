import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { ESCALATION_KIND, PERSON_SUBJECT } from "./assess.ts";
import type { Acknowledgment, ChannelDescriptor, CopyWatch, ChannelId, EscalationPolicy, Incident, Level, PersonId, PlaceId, Report, ReportId, Status, WatchedPlace } from "./contracts.ts";
import { asksForAck, exhaustions, recipientProblems, route, type EscalationStart, type Exhaustion, type Recipient, type Route } from "./delivery.ts";
import { incidents, normalize } from "./merge.ts";
import { DRILL_SUBJECT, INCIDENT_SUBJECT, NO_SYSTEM_LINES, systemReports, type SystemSnapshot } from "./system-reports.ts";

// The alert to the next person when an escalation of a real warning ends with no acknowledgment (AL-21).

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 4, 2, 18, 0);
const pushover = "pushover" as ChannelId;
const sms = "sms" as ChannelId;
const pager = "pager" as ChannelId;
const watched = "person-1" as PersonId;
const watcher = "person-2" as PersonId;

// A public place in Kansas: Sedgwick County.
const home = "place-1" as PlaceId;
const places: readonly WatchedPlace[] = [{ id: home, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 0 }];

function channel(id: ChannelId, ack: ChannelDescriptor["ack"], ackLevels?: readonly Level[]): ChannelDescriptor {
  return { id, title: id, dependsOn: [], uses: ["internet", "dns"], breaksThrough: true, repeats: ack === "poll", ack, maxTitle: 250, maxBody: 1024, ...(ackLevels === undefined ? {} : { ackLevels }) };
}
// The push asks for an acknowledgment only at life-safety, as Pushover does. The pager asks at each level. The text never asks.
const CHANNELS = [channel(pushover, "poll", ["life-safety"]), channel(sms, "none"), channel(pager, "poll")];

const ASKS: EscalationPolicy = {
  level: "life-safety",
  steps: [
    { channel: pushover, at: 0 },
    { channel: sms, at: 5 * MINUTE },
  ],
  exhaustedAfter: 20 * MINUTE,
};
const TEXT_ONLY: EscalationPolicy = { level: "life-safety", steps: [{ channel: sms, at: 0 }], exhaustedAfter: 20 * MINUTE };
const NO_STEP: EscalationPolicy = { level: "life-safety", steps: [], exhaustedAfter: 20 * MINUTE };
/** The time of the exhaustion of the policy `ASKS` that starts at `T0`: the last step, then `exhaustedAfter`. */
const EXHAUSTED_AT = T0 + 25 * MINUTE;

const addresses = { [pushover]: { user: "fake-user" }, [sms]: { to: "+999 0100" }, [pager]: { to: "+999 0101" } };

function recipient(person: PersonId, extra: Partial<Recipient["watch"]> = {}, policies: readonly EscalationPolicy[] = [ASKS], rest: Partial<Recipient> = {}): Recipient {
  return { watch: { person, places: [], rules: [], ...extra }, policies, addresses, ...rest };
}

// A tornado warning at the place: a real warning with the status actual.
const WARNING: Incident = {
  anchor: "a".repeat(64) as ReportId,
  reports: ["a".repeat(64) as ReportId],
  status: "actual",
  kind: { code: "met.tornado", label: "Tornado" },
  severity: "extreme",
  urgency: "immediate",
  certainty: "observed",
  areas: [{ type: "code", system: "ugc", code: "KSC173" }],
  about: [],
  live: true,
  corroboration: 1,
};

// A drill run: a report of the system that wakes its person, and that only its person has a step for.
const DRILL_RUN: Incident = { ...WARNING, anchor: "b".repeat(64) as ReportId, reports: ["b".repeat(64) as ReportId], status: "system", kind: { code: "system.drill.run", label: "Drill" }, areas: [], about: [{ system: DRILL_SUBJECT, id: "push-weekly" }] };

/**
 * This function gives the routes at `now`, with the starts of the first route of each escalation at `from`, and the
 * acknowledgments to `now`.
 */
function routesAt(recipients: readonly Recipient[], list: readonly Incident[], now: number, acks: readonly Acknowledgment[] = [], from = T0): Route[] {
  const input = { incidents: list, recipients, places, cancelled: new Set<string>(), channels: CHANNELS };
  const first = route({ ...input, state: { reports: [], deliveries: [], acks: [], ends: [], retired: [] }, starts: [], now: from });
  const starts: EscalationStart[] = first.map((entry) => entry.start);
  return route({ ...input, state: { reports: [], deliveries: [], acks: acks.filter((ack) => ack.at <= now), ends: [], retired: [] }, starts, now });
}

/** The exhaustions of the routes. With no report, the title of each warning is the label of its kind. */
const exhausted = (routes: readonly Route[]): Exhaustion[] => exhaustions(routes, CHANNELS, []);

function ack(at: number, incident: Incident = WARNING, person: PersonId = watched, level: Level = "life-safety"): Acknowledgment {
  return { incident: incident.anchor, level, person, at, via: pushover };
}

/** This function gives the system reports of a list of exhaustions at `at`, and the incidents that they make. */
function reported(list: readonly Exhaustion[], at: number, extra: Partial<SystemSnapshot> = {}) {
  const step = systemReports(NO_SYSTEM_LINES, { sources: [], health: [], coverage: [], threats: [], exhausted: list, ...extra }, at);
  return { step, incidents: incidents(normalize({ reports: step.reports }), at) };
}

describe("exhaustions() of the routes (AL-21)", () => {
  const people = [recipient(watched, { places: [home] })];

  it("gives the label of the kind as the title of a private warning, and not its text (AL-92)", () => {
    // The fields of the report that the title reads.
    const text = { id: WARNING.anchor, severity: WARNING.severity, urgency: WARNING.urgency, sent: T0, headline: "A private message" } as unknown as Report;
    const secret: Incident = { ...WARNING, addresses: [watched] };
    expect(exhaustions(routesAt(people, [WARNING], EXHAUSTED_AT), CHANNELS, [text]).map((one) => one.title)).toEqual(["A private message"]);
    expect(exhaustions(routesAt(people, [secret], EXHAUSTED_AT), CHANNELS, [text]).map((one) => one.title)).toEqual(["Tornado"]);
  });

  it("gives one exhaustion of a real warning at the end of its policy, and none before it", () => {
    expect(exhausted(routesAt(people, [WARNING], EXHAUSTED_AT - 1))).toEqual([]);
    expect(exhausted(routesAt(people, [WARNING], EXHAUSTED_AT))).toEqual([
      { incident: WARNING.anchor, person: watched, level: "life-safety", episode: 0, at: EXHAUSTED_AT, kind: WARNING.kind, title: "Tornado" },
    ]);
  });

  it("gives none after an acknowledgment, before or after the exhaustion", () => {
    expect(exhausted(routesAt(people, [WARNING], EXHAUSTED_AT + MINUTE, [ack(T0 + 3 * MINUTE)]))).toEqual([]);
    expect(exhausted(routesAt(people, [WARNING], EXHAUSTED_AT + 2 * MINUTE, [ack(EXHAUSTED_AT + MINUTE)]))).toEqual([]);
  });

  it("gives none after the end of the warning, before or after the exhaustion", () => {
    for (const expires of [T0 + 10 * MINUTE, EXHAUSTED_AT + MINUTE]) {
      const ended = routesAt(people, [{ ...WARNING, expires }], EXHAUSTED_AT + 2 * MINUTE);
      expect(ended.map((entry) => entry.plan.state), String(expires)).toEqual(["ended"]);
      expect(exhausted(ended)).toEqual([]);
    }
  });

  it("skips a plan with no step, and a drill run: a channel rule that empties a plan on purpose gives no alert (the gate)", () => {
    // 1. A real warning, and a policy with no step: the plan is exhausted at once, and it sent nothing.
    const empty = routesAt([recipient(watched, { places: [home] }, [NO_STEP])], [WARNING], EXHAUSTED_AT);
    expect(empty.map((entry) => [entry.plan.state, entry.policy.steps.length])).toEqual([["exhausted", 0]]);
    expect(exhausted(empty)).toEqual([]);

    // 2. A drill run that nobody acknowledges. The person of the drill has a step, and the rule of the drill empties the plan of the other person.
    const drill = { subjects: [{ system: DRILL_SUBJECT }] };
    const onlyWatcher = recipient(watcher, drill, [ASKS], { channelRules: [{ kinds: ["system.drill"], keep: "only", channels: [] }] });
    const runs = routesAt([recipient(watched, drill), onlyWatcher], [DRILL_RUN], EXHAUSTED_AT);
    // Each rule of the gate applies: the plan of the person of the drill is exhausted with steps, and the plan of the watcher has no step.
    expect(runs.map((entry) => [entry.person, entry.plan.state, entry.policy.steps.length])).toEqual([
      [watched, "exhausted", 2],
      [watcher, "exhausted", 0],
    ]);
    expect(exhausted(runs)).toEqual([]);
  });

  it("skips a plan with no step that asks for an acknowledgment", () => {
    const texts = routesAt([recipient(watched, { places: [home] }, [TEXT_ONLY])], [WARNING], EXHAUSTED_AT);
    expect(texts.map((entry) => entry.plan.state)).toEqual(["exhausted"]);
    expect(exhausted(texts)).toEqual([]);
  });
});

describe("asksForAck() of a policy", () => {
  const policy = (level: Level, step: ChannelId): EscalationPolicy => ({ level, steps: [{ channel: step, at: 0 }], exhaustedAfter: MINUTE });

  it("asks only on a channel with an acknowledgment, at a level of its ackLevels, and each level with no ackLevels", () => {
    expect(asksForAck(policy("life-safety", pushover), CHANNELS)).toBe(true);
    expect(asksForAck(policy("urgent", pushover), CHANNELS)).toBe(false);
    expect(asksForAck(policy("life-safety", sms), CHANNELS)).toBe(false);
    expect(asksForAck(policy("notice", pager), CHANNELS)).toBe(true);
    expect(asksForAck(policy("life-safety", "unknown" as ChannelId), CHANNELS)).toBe(false);
  });
});

describe("the system reports of the exhaustions (AL-21)", () => {
  const title = "Tornado Warning until 13:45 CDT";
  const exhaustion: Exhaustion = { incident: WARNING.anchor, person: watched, level: "life-safety", episode: 0, at: EXHAUSTED_AT, kind: WARNING.kind, title };

  it("open one line for each exhaustion, keep it while the list is absent, and cancel it when the exhaustion ends", () => {
    const { step } = reported([exhaustion], EXHAUSTED_AT);
    expect(step.reports.map((report) => [report.op, report.kind.code, report.status, report.severity, report.urgency, report.areas.length])).toEqual([
      ["alert", `${ESCALATION_KIND}.exhausted`, "system", "extreme", "immediate", 0],
    ]);
    // The report tells what the person missed: the kind, the level and the title, with a link to the warning.
    expect(step.reports[0]?.headline).toBe(`${watched} did not acknowledge Tornado (life-safety): ${title}`);
    expect(step.reports[0]?.about).toEqual([
      { system: PERSON_SUBJECT, id: watched, label: `Person ${watched}` },
      { system: INCIDENT_SUBJECT, id: WARNING.anchor, label: title },
    ]);
    // With no text of the warning, the title is the label of the kind, and the headline does not tell it two times.
    expect(reported([{ ...exhaustion, title: "Tornado" }], EXHAUSTED_AT).step.reports[0]?.headline).toBe(`${watched} did not acknowledge Tornado (life-safety)`);
    const empty = { sources: [], health: [], coverage: [], threats: [] };
    // The same exhaustion gives no new report, and an absent list cancels nothing: a restart keeps the line.
    expect(systemReports(step.lines, { ...empty, exhausted: [exhaustion] }, EXHAUSTED_AT + MINUTE).reports).toEqual([]);
    expect(systemReports(step.lines, empty, EXHAUSTED_AT + MINUTE).reports).toEqual([]);
    expect(systemReports(step.lines, { ...empty, exhausted: [] }, EXHAUSTED_AT + MINUTE).reports.map((report) => report.op)).toEqual(["cancel"]);
  });

  it("come from one copy: the copy that reports the facts of a shared account", () => {
    // The copy a has the smaller id, and it answers. Thus it reports, and the copy b does not.
    const watch = (copy: string): CopyWatch => ({ copy, skewLimit: MINUTE, maxAge: 10 * MINUTE, since: EXHAUSTED_AT });
    const count = (copy: string, other: string): number =>
      reported([exhaustion], EXHAUSTED_AT, { copy, copies: [watch(other)] }).step.reports.filter((report) => report.kind.code === `${ESCALATION_KIND}.exhausted`).length;
    expect([count("a", "b"), count("b", "a")]).toEqual([1, 0]);
  });

  it("reach each watcher of the person at the level of the exhaustion, and never the person itself", () => {
    // The person watches the subject of the person itself, with an id and with no id. The watcher watches the person.
    const self = recipient(watched, { places: [home], subjects: [{ system: PERSON_SUBJECT }, { system: PERSON_SUBJECT, id: watched }] });
    const other = recipient(watcher, { subjects: [{ system: PERSON_SUBJECT, id: watched }] }, [ASKS, { ...ASKS, level: "urgent" }, { ...ASKS, level: "notice" }]);
    for (const level of ["life-safety", "urgent", "notice"] as const) {
      const found = reported([{ ...exhaustion, level }], EXHAUSTED_AT).incidents;
      const routes = routesAt([self, other], found, EXHAUSTED_AT, [], EXHAUSTED_AT);
      expect(routes.map((entry) => [entry.person, entry.policy.level]), level).toEqual([[watcher, level]]);
    }
    expect(recipientProblems(self, CHANNELS)).toContain(`The person watches the subject ${PERSON_SUBJECT} of the person itself. The exhausted escalations of a person never reach that person.`);
    expect(recipientProblems(other, CHANNELS)).toEqual([]);
  });

  it("keep the quiet window of the watcher: an urgent exhaustion is quiet in it, and a life-safety exhaustion is loud", () => {
    // The time of the exhaustion is 13:25 in Chicago, in the quiet window of the watcher from 12:00 to 14:00.
    const quiet = { zone: "America/Chicago", start: "12:00", end: "14:00" };
    const other = recipient(watcher, { subjects: [{ system: PERSON_SUBJECT, id: watched }], quiet }, [ASKS, { ...ASKS, level: "urgent" }]);
    const sends = (level: Level) => routesAt([other], reported([{ ...exhaustion, level }], EXHAUSTED_AT).incidents, EXHAUSTED_AT, [], EXHAUSTED_AT).flatMap((entry) => entry.plan.sends.map((send) => send.quiet));
    expect(sends("urgent")).toEqual([true]);
    expect(sends("life-safety")).toEqual([false]);
  });

  it("give no exhaustion of an exhaustion: the report of the system does not chain", () => {
    const other = recipient(watcher, { subjects: [{ system: PERSON_SUBJECT, id: watched }] });
    const found = reported([exhaustion], EXHAUSTED_AT).incidents;
    // The watcher does not acknowledge the alert either. Its plan ends exhausted, and it gives no exhaustion.
    const later = routesAt([other], found, T0 + 3 * 60 * MINUTE, [], EXHAUSTED_AT);
    expect(later.map((entry) => entry.plan.state)).toEqual(["exhausted"]);
    expect(exhausted(later)).toEqual([]);
  });
});

describe("the exhaustions of seeded escalations (AL-21)", () => {
  it("give one exhaustion exactly for a real warning with a step that asks, past its time and with no acknowledgment", () => {
    const policies: readonly { readonly policy: EscalationPolicy; readonly asks: boolean; readonly at: number }[] = [
      { policy: ASKS, asks: true, at: EXHAUSTED_AT },
      { policy: TEXT_ONLY, asks: false, at: T0 + 20 * MINUTE },
      { policy: NO_STEP, asks: false, at: T0 },
    ];
    for (const seed of SEEDS) {
      const r = random(`exhaustion:${seed}`);
      for (let round = 0; round < 25; round += 1) {
        const context = `seed ${seed}, round ${round}`;
        const chosen = r.pick(policies);
        const status = r.pick(["actual", "actual", "system", "test", "exercise"] as const satisfies readonly Status[]);
        const now = T0 + r.int(0, 60) * MINUTE;
        const ackAt = r.chance(0.5) ? T0 + r.int(0, 60) * MINUTE : undefined;
        const warning: Incident = { ...WARNING, status };
        const routes = routesAt([recipient(watched, { places: [home] }, [chosen.policy])], [warning], now, ackAt === undefined ? [] : [ack(ackAt, warning)]);
        const acked = ackAt !== undefined && ackAt <= now;
        const expected = status === "actual" && chosen.asks && now >= chosen.at && !acked;
        const found = exhausted(routes);
        expect(found.length, context).toBe(expected ? 1 : 0);
        if (!expected) continue;
        // The exhaustion gives one alert from the system, and the alert reaches no route of the person itself.
        const { step, incidents: made } = reported(found, now);
        expect(step.reports.map((report) => report.op), context).toEqual(["alert"]);
        expect(routesAt([recipient(watched, { places: [home], subjects: [{ system: PERSON_SUBJECT }] })], made, now), context).toEqual([]);
      }
    }
  });
});
