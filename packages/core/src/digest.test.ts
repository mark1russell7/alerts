import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { ChannelDescriptor, ChannelId, Delivery, EscalationPolicy, Incident, Level, MergeState, PersonId, PlaceId, QuietWindow, Report, ReportId, WatchedPlace } from "./contracts.ts";
import { recipientProblems, route, type Recipient } from "./delivery.ts";
import { digestDeliveries, digestMessageOf, planDigests, type DigestInput } from "./digest.ts";
import { dailyInstant, dailyTimeProblems, digestTimeOf } from "./escalation.ts";
import { digestEntryKey, digestKey, messageKey } from "./ids.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 2026-04-01 13:00 in Kansas (CDT, UTC-5). The quiet window ends at 07:00, thus the next digest time is 2026-04-02 12:00 UTC.
const T0 = Date.UTC(2026, 3, 1, 18);
const DIGEST = Date.UTC(2026, 3, 2, 12);
const ZONE = "America/Chicago";
const QUIET: QuietWindow = { zone: ZONE, start: "22:00", end: "07:00" };

const first = "a".repeat(64) as ReportId;
const second = "b".repeat(64) as ReportId;
const third = "c".repeat(64) as ReportId;
const pushover = "pushover" as ChannelId;
const sms = "sms" as ChannelId;
const person = "person-1" as PersonId;

// A public place in Kansas: Sedgwick County.
const home = "place-1" as PlaceId;
const places: readonly WatchedPlace[] = [{ id: home, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 5 }];
const atHome = [{ type: "code", system: "ugc", code: "KSC173" }] as const;

const LIFE_SAFETY: EscalationPolicy = { level: "life-safety", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 20 * MINUTE };
const NOTICE: EscalationPolicy = { level: "notice", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 0 };
const DIGEST_POLICY: EscalationPolicy = { level: "digest", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 0 };

function recipient(policies: readonly EscalationPolicy[] = [LIFE_SAFETY, NOTICE, DIGEST_POLICY], quiet: QuietWindow | undefined = QUIET): Recipient {
  return {
    watch: { person, places: [home], rules: [], ...(quiet === undefined ? {} : { quiet }) },
    policies,
    addresses: { pushover: { user: "fake-user" }, sms: { to: "fake-number" } },
  };
}

function channel(id: ChannelId): ChannelDescriptor {
  return { id, title: id, dependsOn: [], uses: ["internet", "dns"], breaksThrough: false, repeats: false, ack: "none", maxTitle: 250, maxBody: 1024 };
}
const CHANNELS = [channel(pushover), channel(sms)];

// A minor alert gives `digest`, and a moderate alert gives `notice`.
const MINOR = { severity: "minor", urgency: "expected" } as const;

function incident(anchor: ReportId, fields: Partial<Incident> = {}): Incident {
  return {
    anchor,
    reports: [anchor],
    status: "actual",
    kind: { code: "met.flood", label: "Flood" },
    ...MINOR,
    certainty: "observed",
    areas: atHome,
    about: [],
    live: true,
    corroboration: 1,
    ...fields,
  };
}

function report(id: ReportId, received: number, headline: string): Report {
  return {
    id,
    source: "nws-api" as Report["source"],
    origin: "nws",
    key: id,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.flood", label: "Flood" },
    categories: ["met"],
    ...MINOR,
    certainty: "observed",
    response: ["monitor"],
    sent: received,
    received,
    areas: atHome,
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline,
    observation: "obs" as Report["observation"],
    parameters: {},
  };
}

const REPORTS = [report(first, T0, "Flood Advisory for Sedgwick County"), report(second, T0 + HOUR, "Hydrologic Outlook"), report(third, T0 + 2 * HOUR, "Flood Statement")];

function input(extra: Partial<DigestInput> & { readonly merge?: Partial<MergeState> } = {}): DigestInput {
  const { merge, ...rest } = extra;
  return {
    state: { reports: REPORTS, deliveries: [], acks: [], ends: [], retired: [], ...merge },
    incidents: [incident(first)],
    recipients: [recipient()],
    places,
    channels: CHANNELS,
    now: DIGEST,
    ...rest,
  };
}

// A delivery of an escalation, as the route gives it.
function sent(anchor: ReportId, level: Level, at: number): Delivery {
  return { key: messageKey({ incident: anchor, level, person, step: 0 }), incident: anchor, level, person, channel: pushover, step: 0, at, receipt: {} };
}

const anchors = (extra: Partial<DigestInput> & { readonly merge?: Partial<MergeState> } = {}) => planDigests(input(extra)).sends.map((send) => send.entries.map((entry) => `${entry.incident.anchor[0]!}:${entry.level}`));

describe("dailyInstant", () => {
  const daily = { zone: ZONE, time: "07:00" };

  it("gives the last daily time at or before the instant, and with next the first one after it", () => {
    expect(dailyInstant(daily, DIGEST)).toBe(DIGEST);
    expect(dailyInstant(daily, DIGEST - 1)).toBe(DIGEST - 24 * HOUR);
    expect(dailyInstant(daily, DIGEST, true)).toBe(DIGEST + 24 * HOUR);
    expect(dailyInstant(daily, DIGEST - 1, true)).toBe(DIGEST);
  });

  it("gives the end of the gap for a time in the gap of the change forward, and the first instant in the hour of the change back", () => {
    // 2026-03-08: the clocks of Kansas go from 02:00 CST to 03:00 CDT. 2026-11-01: from 02:00 CDT back to 01:00 CST.
    expect(dailyInstant({ zone: ZONE, time: "02:30" }, Date.UTC(2026, 2, 8, 12))).toBe(Date.UTC(2026, 2, 8, 8));
    expect(dailyInstant({ zone: ZONE, time: "01:30" }, Date.UTC(2026, 10, 1, 12))).toBe(Date.UTC(2026, 10, 1, 6, 30));
    // A day of 25 hours: the next 07:00 after the change back is 25 hours after the 07:00 before it.
    expect(dailyInstant(daily, Date.UTC(2026, 9, 31, 12), true)).toBe(Date.UTC(2026, 10, 1, 13));
  });

  it("gives undefined for a bad zone, a bad time or a bad instant, and the problems name them", () => {
    expect(dailyInstant({ zone: "Mars/Olympus", time: "07:00" }, DIGEST)).toBeUndefined();
    expect(dailyInstant({ zone: ZONE, time: "7:00" }, DIGEST)).toBeUndefined();
    expect(dailyInstant(daily, Number.NaN)).toBeUndefined();
    expect(dailyTimeProblems(daily)).toEqual([]);
    expect(dailyTimeProblems({ zone: "Mars/Olympus", time: "24:00" })).toEqual([
      "The time zone Mars/Olympus is not an IANA time zone.",
      "The time 24:00 is not a local time HH:MM from 00:00 to 23:59.",
    ]);
  });

  it("takes the daily time of the policy first, then the end of the quiet window", () => {
    expect(digestTimeOf(DIGEST_POLICY, QUIET)).toEqual({ zone: ZONE, time: "07:00" });
    expect(digestTimeOf({ ...DIGEST_POLICY, daily: { zone: "UTC", time: "09:15" } }, QUIET)).toEqual({ zone: "UTC", time: "09:15" });
    expect(digestTimeOf(DIGEST_POLICY, undefined)).toBeUndefined();
  });
});

describe("planDigests", () => {
  it("sends one digest at the end of the quiet window, with each incident of the level digest", () => {
    const plan = planDigests(input({ incidents: [incident(first), incident(second)] }));
    expect(plan.sends).toHaveLength(1);
    const send = plan.sends[0]!;
    expect(send).toMatchObject({ person, channel: pushover, step: 0, at: DIGEST, due: DIGEST, quiet: false, key: digestKey({ person, at: DIGEST, step: 0 }) });
    expect(send.entries.map((entry) => [entry.incident.anchor, entry.level])).toEqual([
      [first, "digest"],
      [second, "digest"],
    ]);
    expect(plan.wakeAt).toBe(DIGEST + 24 * HOUR);
  });

  it("waits for the digest time, and gives it as the time to wake", () => {
    const plan = planDigests(input({ now: DIGEST - 1 }));
    expect(plan.sends).toEqual([]);
    expect(plan.wakeAt).toBe(DIGEST);
  });

  it("sends nothing to a person with no digest policy or no daily time, and the check names the missing time", () => {
    expect(planDigests(input({ recipients: [recipient([LIFE_SAFETY, NOTICE])] })).sends).toEqual([]);
    const { quiet: _quiet, ...watch } = recipient().watch;
    const timeless: Recipient = { ...recipient(), watch };
    expect(planDigests(input({ recipients: [timeless] }))).toEqual({ sends: [] });
    expect(recipientProblems(timeless, CHANNELS)).toContain("The policy of digest has no daily time, and the person has no quiet window. The person gets no digest.");
    expect(recipientProblems(recipient(), CHANNELS)).toEqual([]);
  });

  it("uses the daily time of the policy, the time of the step and the wait of the rank", () => {
    const policy: EscalationPolicy = { ...DIGEST_POLICY, daily: { zone: ZONE, time: "08:30" }, steps: [{ channel: pushover, at: 10 * MINUTE }] };
    const at = DIGEST + 90 * MINUTE;
    const recipients = [recipient([LIFE_SAFETY, policy])];
    expect(planDigests(input({ recipients, now: at + 10 * MINUTE - 1 }))).toEqual({ sends: [], wakeAt: at + 10 * MINUTE });
    expect(planDigests(input({ recipients, now: at + 10 * MINUTE })).sends[0]).toMatchObject({ at, due: at + 10 * MINUTE });
    // A copy of rank 2 waits two rank delays of the level digest.
    const ranked = planDigests(input({ recipients, now: at + 10 * MINUTE, rank: 2, rankDelay: HOUR, rankDelays: { digest: 5 * MINUTE } }));
    expect(ranked).toEqual({ sends: [], wakeAt: at + 20 * MINUTE });
  });

  it("sends each incident in one digest: the record of a digest keeps it out after a restart and on the next day", () => {
    const [send] = planDigests(input()).sends;
    const record = digestDeliveries(send!, DIGEST + 2_000, { receipt: "r-1" });
    expect(record).toEqual([{ key: digestEntryKey(send!.key, first), incident: first, level: "digest", person, channel: pushover, step: 0, at: DIGEST + 2_000, receipt: { receipt: "r-1" } }]);
    expect(planDigests(input({ merge: { deliveries: record }, now: DIGEST + HOUR })).sends).toEqual([]);
    expect(planDigests(input({ merge: { deliveries: record }, now: DIGEST + 24 * HOUR })).sends).toEqual([]);
    // The record of another step does not keep it out of this step.
    const twoSteps = recipient([LIFE_SAFETY, { ...DIGEST_POLICY, steps: [{ channel: pushover, at: 0 }, { channel: sms, at: 0 }] }]);
    expect(planDigests(input({ recipients: [twoSteps], merge: { deliveries: record } })).sends.map((item) => item.channel)).toEqual([sms]);
  });

  it("sends one digest for each digest time across the copies, and the entries that only this copy knows wait for the next digest", () => {
    // Another copy knew only the first incident, and its digest told it. This copy also knows the second incident.
    const [other] = planDigests(input()).sends;
    const record = digestDeliveries(other!, DIGEST + 18_000, { receipt: "r-cloud" });
    const both = [incident(first), incident(second)];
    expect(anchors({ incidents: both })).toEqual([["a:digest", "b:digest"]]);
    expect(planDigests(input({ incidents: both, merge: { deliveries: record }, now: DIGEST + 30_000 })).sends).toEqual([]);
    expect(anchors({ incidents: both, merge: { deliveries: record }, now: DIGEST + 24 * HOUR })).toEqual([["b:digest"]]);
    // A digest of the day before does not keep the digest of today quiet.
    const yesterday = digestDeliveries(other!, DIGEST - 24 * HOUR + 18_000, { receipt: "r-old" }).map((delivery) => ({ ...delivery, incident: third }));
    expect(anchors({ incidents: both, merge: { deliveries: yesterday } })).toEqual([["a:digest", "b:digest"]]);
  });

  it("keeps an incident that came after the digest time for the next digest", () => {
    const late = report(third, DIGEST + HOUR, "Flood Statement");
    const merge = { reports: [...REPORTS.slice(0, 2), late] };
    expect(anchors({ incidents: [incident(third)], merge, now: DIGEST + 2 * HOUR })).toEqual([]);
    expect(anchors({ incidents: [incident(third)], merge, now: DIGEST + 24 * HOUR })).toEqual([["c:digest"]]);
  });

  it("sends the digest late after a runtime was down at the digest time, until the next digest time", () => {
    expect(planDigests(input({ now: DIGEST + 6 * HOUR })).sends[0]).toMatchObject({ at: DIGEST, due: DIGEST });
  });

  it("tells again each quiet notice of the night, with its highest level, and not a notice of the day", () => {
    const night = DIGEST - 6 * HOUR; // 01:00 in Kansas, in the quiet window
    const day = DIGEST - 16 * HOUR; // 15:00 the day before, out of the quiet window
    const deliveries = [sent(first, "notice", night), sent(first, "urgent", night + MINUTE), sent(second, "notice", day)];
    expect(anchors({ incidents: [incident(first), incident(second)], merge: { deliveries } })).toEqual([["a:urgent"]]);
    // A night notice of an incident that is over still goes in the digest: the digest tells what the night held.
    expect(anchors({ incidents: [incident(first, { live: false })], merge: { deliveries } })).toEqual([["a:urgent"]]);
    // A life-safety message is never quiet, thus it is not in the digest.
    expect(anchors({ merge: { deliveries: [sent(first, "life-safety", night)] } })).toEqual([]);
  });

  it("tells a night notice in one digest only, also when an earlier digest told the incident", () => {
    const night = DIGEST - 6 * HOUR;
    const yesterday = digestDeliveries(planDigests(input({ now: DIGEST - 24 * HOUR, merge: { reports: [report(first, T0 - 24 * HOUR, "Flood Advisory")] } })).sends[0]!, DIGEST - 24 * HOUR);
    const deliveries = [...yesterday, sent(first, "notice", night)];
    const [send] = planDigests(input({ merge: { deliveries } })).sends;
    expect(send!.entries.map((entry) => entry.level)).toEqual(["notice"]);
    const today = digestDeliveries(send!, DIGEST + 1_000);
    expect(planDigests(input({ merge: { deliveries: [...deliveries, ...today] }, now: DIGEST + HOUR })).sends).toEqual([]);
    // The night after the next digest time is a new night: the old notice does not come again.
    expect(planDigests(input({ merge: { deliveries: [...deliveries, ...today] }, now: DIGEST + 24 * HOUR })).sends).toEqual([]);
  });

  it("keeps out an incident that a louder message told in the day, an incident that is over, and an incident of another level", () => {
    expect(anchors({ merge: { deliveries: [sent(first, "notice", DIGEST - 16 * HOUR)] } })).toEqual([]);
    expect(anchors({ incidents: [incident(first, { live: false })] })).toEqual([]);
    expect(anchors({ incidents: [incident(first, { severity: "moderate" })] })).toEqual([]);
    expect(anchors({ incidents: [incident(first, { areas: [{ type: "code", system: "ugc", code: "TXC201" }] })] })).toEqual([]);
  });

  it("gives the same plan for each order of the incidents and the deliveries", () => {
    const night = DIGEST - 6 * HOUR;
    const incidents = [incident(first), incident(second), incident(third)];
    const deliveries = [sent(third, "notice", night), sent(second, "notice", DIGEST - 16 * HOUR)];
    const expected = planDigests(input({ incidents, merge: { deliveries } }));
    expect(expected.sends[0]!.entries.map((entry) => entry.incident.anchor)).toEqual([third, first]);
    for (const seed of SEEDS) {
      const rng = random(seed);
      const shuffle = <T,>(items: readonly T[]): T[] => [...items].map((item) => ({ item, at: rng.next() })).sort((a, b) => a.at - b.at).map(({ item }) => item);
      expect(planDigests(input({ incidents: shuffle(incidents), merge: { deliveries: shuffle(deliveries), reports: shuffle(REPORTS) } }))).toEqual(expected);
    }
  });
});

describe("digestMessageOf", () => {
  it("gives the count in the title, and one line for each incident with its level when it is not digest", () => {
    const night = DIGEST - 6 * HOUR;
    const [send] = planDigests(input({ incidents: [incident(first), incident(second)], merge: { deliveries: [sent(second, "notice", night)] } })).sends;
    expect(digestMessageOf(send!, REPORTS)).toEqual({
      key: send!.key,
      person,
      level: "digest",
      title: "The digest: 2 alerts",
      body: "- notice: Hydrologic Outlook\n- Flood Advisory for Sedgwick County",
      incident: second,
      quiet: false,
    });
    const [one] = planDigests(input()).sends;
    expect(digestMessageOf(one!, []).title).toBe("The digest: 1 alert");
    expect(digestMessageOf(one!, []).body).toBe("- Flood");
  });
});

describe("route and the digest", () => {
  it("starts no escalation for the level digest, and a delivery of a digest is not a step of an escalation", () => {
    const routeInput = { state: input().state, incidents: [incident(first)], recipients: [recipient()], places, starts: [], cancelled: new Set<string>(), channels: CHANNELS, now: DIGEST };
    expect(route(routeInput)).toEqual([]);
    const [send] = planDigests(input()).sends;
    const deliveries = digestDeliveries(send!, DIGEST);
    expect(route({ ...routeInput, state: { ...routeInput.state, deliveries }, incidents: [incident(first, { live: false })] })).toEqual([]);
  });

  it("gives a problem for a daily time on a policy of another level, and for a bad daily time", () => {
    const problems = recipientProblems(recipient([{ ...LIFE_SAFETY, daily: { zone: ZONE, time: "07:00" } }, { ...DIGEST_POLICY, daily: { zone: ZONE, time: "7am" } }]), CHANNELS);
    expect(problems).toEqual([
      "The policy of life-safety has a daily time. Only a policy of the level digest uses it.",
      "The daily time of the policy of digest: The time 7am is not a local time HH:MM from 00:00 to 23:59.",
    ]);
  });
});
