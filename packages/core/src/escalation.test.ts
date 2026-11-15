import { machineProblems, replay } from "@mark1russell7/algebra";
import { fakeClock } from "@mark1russell7/algebra/clock";
import { describe, expect, it } from "vitest";
import type { Acknowledgment, ChannelId, Delivery, EscalationPolicy, Level, PersonId, QuietWindow, ReportId } from "./contracts.ts";
import {
  ESCALATION_MACHINE,
  escalate,
  escalationProblems,
  inQuietWindow,
  quietWindowProblems,
  type EscalationInput,
  type EscalationPlan,
} from "./escalation.ts";

const MINUTE = 60_000;
const T0 = 1_763_157_600_000;
const anchor = "a".repeat(64) as ReportId;
const merged = "b".repeat(64) as ReportId;
const other = "c".repeat(64) as ReportId;
const person = "person-1" as PersonId;
const pushover = "pushover" as ChannelId;
const sms = "sms" as ChannelId;
const voice = "voice" as ChannelId;

const policy: EscalationPolicy = {
  level: "life-safety",
  steps: [
    { channel: pushover, at: 0 },
    { channel: sms, at: 5 * MINUTE },
    { channel: voice, at: 10 * MINUTE },
  ],
  exhaustedAfter: 20 * MINUTE,
};

const input = (extra: Partial<EscalationInput> = {}): EscalationInput => ({
  policy,
  person,
  incident: { anchor, reports: [anchor, merged] },
  since: T0,
  deliveries: [],
  acknowledgments: [],
  now: T0,
  ...extra,
});

const delivery = (step: number, at: number, extra: Partial<Delivery> = {}): Delivery => ({
  key: `key-${step}`,
  incident: anchor,
  level: "life-safety",
  person,
  step,
  channel: policy.steps[step]?.channel ?? pushover,
  at,
  ...extra,
});

const ack = (at: number, extra: Partial<Acknowledgment> = {}): Acknowledgment => ({ incident: anchor, level: "life-safety", person, at, via: pushover, ...extra });

describe("ESCALATION_MACHINE", () => {
  it("is a consistent machine document", () => {
    expect(machineProblems(ESCALATION_MACHINE)).toEqual([]);
  });
});

describe("escalate", () => {
  it("sends the first step at the start, and wakes at the next step", () => {
    const plan = escalate(input());
    expect(plan.state).toBe("sent");
    expect(plan.due).toEqual([0]);
    expect(plan.sends).toEqual([{ incident: anchor, level: "life-safety", person, step: 0, channel: pushover, due: T0, quiet: false }]);
    expect(plan.cancels).toEqual([]);
    expect(plan.wakeAt).toBe(T0 + 5 * MINUTE);
  });

  it("sends nothing for a step that the ledger has, also from a merged report of the incident", () => {
    const plan = escalate(input({ deliveries: [delivery(0, T0 + 1000, { incident: merged })], now: T0 + 2 * MINUTE }));
    expect(plan.sends).toEqual([]);
    expect(plan.wakeAt).toBe(T0 + 5 * MINUTE);
  });

  it("ignores the deliveries and the acknowledgments of another incident, level or person", () => {
    const plan = escalate(
      input({
        deliveries: [delivery(0, T0, { incident: other }), delivery(0, T0, { level: "urgent" }), delivery(0, T0, { person: "person-2" as PersonId })],
        acknowledgments: [ack(T0, { incident: other }), ack(T0, { level: "urgent" as Level }), ack(T0, { person: "person-2" as PersonId })],
      }),
    );
    expect(plan.state).toBe("sent");
    expect(plan.sends.map((send) => send.step)).toEqual([0]);
  });

  it("sends each due step that the ledger does not have, also a late one", () => {
    const plan = escalate(input({ deliveries: [delivery(0, T0)], now: T0 + 12 * MINUTE }));
    expect(plan.state).toBe("last");
    expect(plan.due).toEqual([0, 1, 2]);
    expect(plan.sends.map((send) => [send.step, send.channel, send.due])).toEqual([
      [1, sms, T0 + 5 * MINUTE],
      [2, voice, T0 + 10 * MINUTE],
    ]);
    expect(plan.wakeAt).toBe(T0 + 30 * MINUTE);
  });

  it("is exhausted after the last step and exhaustedAfter, and the repeats continue", () => {
    const deliveries = [delivery(0, T0), delivery(1, T0 + 5 * MINUTE), delivery(2, T0 + 10 * MINUTE)];
    const plan = escalate(input({ deliveries, now: T0 + 30 * MINUTE }));
    expect(plan.state).toBe("exhausted");
    expect(plan.exhaustedAt).toBe(T0 + 30 * MINUTE);
    expect(plan.sends).toEqual([]);
    expect(plan.cancels).toEqual([]);
    expect(plan.wakeAt).toBeUndefined();
  });

  it("stops at an acknowledgment, and cancels each delivery one time", () => {
    const deliveries = [delivery(0, T0), delivery(0, T0 + 2000, { key: "key-0-copy-2", incident: merged })];
    const plan = escalate(input({ deliveries, acknowledgments: [ack(T0 + 3 * MINUTE)], now: T0 + 8 * MINUTE }));
    expect(plan.state).toBe("acknowledged");
    expect(plan.due).toEqual([0]);
    expect(plan.sends).toEqual([]);
    expect(plan.cancels.map((each) => each.key)).toEqual(["key-0", "key-0-copy-2"]);
    expect(plan.acknowledgment?.at).toBe(T0 + 3 * MINUTE);
    expect(plan.wakeAt).toBeUndefined();
    expect(plan.transitions.map((each) => `${each.from}>${each.to}`)).toEqual(["idle>sent", "sent>acknowledged"]);
    expect(escalate(input({ deliveries, acknowledgments: [ack(T0 + 3 * MINUTE)], cancelled: new Set(["key-0"]), now: T0 + 8 * MINUTE })).cancels).toHaveLength(1);
  });

  it("stops at an acknowledgment of a higher level, as the merge does", () => {
    const urgent: EscalationPolicy = { ...policy, level: "urgent" };
    const deliveries = [delivery(0, T0, { level: "urgent" })];
    expect(escalate(input({ policy: urgent, deliveries, acknowledgments: [ack(T0 + MINUTE)], now: T0 + 2 * MINUTE })).state).toBe("acknowledged");
    expect(escalate(input({ deliveries: [delivery(0, T0)], acknowledgments: [ack(T0 + MINUTE, { level: "urgent" })], now: T0 + 2 * MINUTE })).state).toBe("sent");
  });

  it("takes the first acknowledgment, and one from a copy with a clock ahead", () => {
    const plan = escalate(input({ acknowledgments: [ack(T0 + 9 * MINUTE, { via: "ui" }), ack(T0 + 4 * MINUTE)], now: T0 + 2 * MINUTE }));
    expect(plan.state).toBe("acknowledged");
    expect(plan.acknowledgment?.via).toBe(pushover);
    expect(plan.transitions.at(-1)?.at).toBe(T0 + 2 * MINUTE);
  });

  it("ends with the incident, and wakes at the end when the end comes first", () => {
    const ended = escalate(input({ deliveries: [delivery(0, T0)], endsAt: T0 + 4 * MINUTE, now: T0 + 6 * MINUTE }));
    expect(ended.state).toBe("ended");
    expect(ended.due).toEqual([0]);
    expect(ended.sends).toEqual([]);
    expect(ended.cancels.map((each) => each.key)).toEqual(["key-0"]);
    expect(escalate(input({ endsAt: T0 + 3 * MINUTE, now: T0 + MINUTE })).wakeAt).toBe(T0 + 3 * MINUTE);
  });

  it("makes a copy wait for its rank before each send", () => {
    const first = escalate(input({ rank: 1, rankDelay: 20_000 }));
    expect(first.state).toBe("idle");
    expect(first.sends).toEqual([]);
    expect(first.wakeAt).toBe(T0 + 20_000);
    // The copy of rank 0 sent the step, and the merge brought its delivery
    const later = escalate(input({ rank: 1, rankDelay: 20_000, deliveries: [delivery(0, T0 + 500)], now: T0 + 20_000 }));
    expect(later.state).toBe("sent");
    expect(later.sends).toEqual([]);
    // The copy of rank 0 did not send: the copy of rank 1 sends
    expect(escalate(input({ rank: 1, rankDelay: 20_000, now: T0 + 20_000 })).sends.map((send) => send.step)).toEqual([0]);
  });

  it("takes the start of a copy that started first from its delivery", () => {
    const plan = escalate(input({ since: T0 + 2 * MINUTE, deliveries: [delivery(0, T0)], now: T0 + 5 * MINUTE }));
    expect(plan.start).toBe(T0);
    expect(plan.sends.map((send) => send.step)).toEqual([1]);
  });

  it("goes from idle to last with one step, and from idle to exhausted with no step", () => {
    const one: EscalationPolicy = { level: "life-safety", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: MINUTE };
    expect(escalate(input({ policy: one })).transitions.map((each) => each.to)).toEqual(["last"]);
    const none: EscalationPolicy = { level: "life-safety", steps: [], exhaustedAfter: MINUTE };
    expect(escalate(input({ policy: none })).state).toBe("idle");
    expect(escalate(input({ policy: none, now: T0 + MINUTE })).state).toBe("exhausted");
  });

  it("is total over odd input, and its order does not depend on the order of the merge state", () => {
    const deliveries = [
      delivery(7, T0 - 60 * MINUTE, { key: "key-old-policy" }),
      delivery(1, Number.NaN, { key: "key-no-time" }),
      delivery(0, T0, { key: "key-b" }),
      delivery(0, T0, { key: "key-a" }),
      delivery(0, T0, { key: "key-a" }),
    ];
    const acknowledgments = [ack(T0 + MINUTE, { via: pushover }), ack(T0 + MINUTE, { via: "ui" })];
    const plan = escalate(input({ deliveries, acknowledgments, rank: -1, rankDelay: Number.NaN, now: T0 + 2 * MINUTE }));
    expect(plan.start).toBe(T0);
    expect(plan.acknowledgment?.via).toBe(pushover);
    expect(plan.cancels.map((each) => each.key)).toEqual(["key-old-policy", "key-a", "key-b", "key-no-time"]);
    const reversed = escalate(input({ deliveries: [...deliveries].reverse(), acknowledgments: [...acknowledgments].reverse(), now: T0 + 2 * MINUTE }));
    expect(reversed.cancels).toEqual(plan.cancels);
    expect(reversed.acknowledgment).toEqual(plan.acknowledgment);
  });

  it("puts the last step before the exhaustion at the same time", () => {
    const zero: EscalationPolicy = { ...policy, exhaustedAfter: 0 };
    const plan = escalate(input({ policy: zero, now: T0 + 10 * MINUTE }));
    expect(plan.transitions.map((each) => each.to)).toEqual(["sent", "sent", "last", "exhausted"]);
  });
});

describe("escalate over a grid of inputs", () => {
  const policies: EscalationPolicy[] = [
    { level: "life-safety", steps: [], exhaustedAfter: 10 * MINUTE },
    { level: "life-safety", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 0 },
    policy,
    { ...policy, steps: [...policy.steps, { channel: pushover, at: 10 * MINUTE }], exhaustedAfter: 0 },
  ];
  const acks = [undefined, 0, 4 * MINUTE, 26 * MINUTE];
  const ends = [undefined, 6 * MINUTE, 35 * MINUTE];
  const ranks = [0, 2];
  const times = Array.from({ length: 41 }, (_, minute) => minute * MINUTE);

  it("makes only the transitions of the machine document, and each later plan extends the earlier one", () => {
    let count = 0;
    for (const each of policies)
      for (const ackAt of acks)
        for (const endAt of ends)
          for (const rank of ranks) {
            let before: EscalationPlan | undefined;
            for (const time of times) {
              const plan = escalate(
                input({
                  policy: each,
                  rank,
                  rankDelay: 15_000,
                  acknowledgments: ackAt === undefined || ackAt > time ? [] : [ack(T0 + ackAt)],
                  ...(endAt === undefined ? {} : { endsAt: T0 + endAt }),
                  now: T0 + time,
                }),
              );
              expect(replay(ESCALATION_MACHINE, plan.transitions)).toEqual([]);
              const final = plan.state === "acknowledged" || plan.state === "ended";
              if (final) expect(plan.sends).toEqual([]);
              else expect(plan.cancels).toEqual([]);
              if (plan.wakeAt !== undefined) expect(plan.wakeAt).toBeGreaterThan(T0 + time);
              if (before !== undefined) expect(plan.transitions.slice(0, before.transitions.length)).toEqual(before.transitions);
              before = plan;
              count += 1;
            }
          }
    expect(count).toBe(policies.length * acks.length * ends.length * ranks.length * times.length);
  });
});

describe("escalate on the test clock", () => {
  it("sends each step at its time, and stops at the acknowledgment", async () => {
    const clock = fakeClock(T0);
    const ledger: Delivery[] = [];
    const acknowledgments: Acknowledgment[] = [];
    const sent: Array<[number, number]> = [];
    // A small runtime: it sends the due steps, writes them to the ledger and waits for wakeAt.
    const tick = (): void => {
      const plan = escalate(input({ deliveries: ledger, acknowledgments, now: clock.now() }));
      for (const send of plan.sends) {
        sent.push([send.step, clock.now()]);
        ledger.push(delivery(send.step, clock.now()));
      }
      if (plan.wakeAt !== undefined) clock.after(plan.wakeAt - clock.now(), tick);
    };
    tick();
    await clock.advance(7 * MINUTE);
    acknowledgments.push(ack(clock.now()));
    tick();
    await clock.advance(60 * MINUTE);
    expect(sent).toEqual([
      [0, T0],
      [1, T0 + 5 * MINUTE],
    ]);
    expect(escalate(input({ deliveries: ledger, acknowledgments, now: clock.now() })).state).toBe("acknowledged");
  });
});

describe("escalationProblems", () => {
  it("finds a policy with no step, a step out of order, a negative time and a negative exhaustion", () => {
    expect(escalationProblems(policy)).toEqual([]);
    expect(escalationProblems({ level: "urgent", steps: [], exhaustedAfter: -1 })).toHaveLength(2);
    expect(
      escalationProblems({
        level: "urgent",
        steps: [
          { channel: sms, at: 5 * MINUTE },
          { channel: pushover, at: -1 },
        ],
        exhaustedAfter: 0,
      }),
    ).toHaveLength(2);
  });
});

describe("inQuietWindow", () => {
  const night: QuietWindow = { zone: "Europe/Berlin", start: "22:00", end: "07:00" };
  const utc = (month: number, day: number, hour: number, minute = 0): number => Date.UTC(2026, month - 1, day, hour, minute);

  it("holds a window across midnight on a day with no change of the clock", () => {
    // In January, Berlin is at UTC+1.
    expect(inQuietWindow(night, utc(1, 15, 20, 59))).toBe(false);
    expect(inQuietWindow(night, utc(1, 15, 21, 0))).toBe(true);
    expect(inQuietWindow(night, utc(1, 15, 23, 0))).toBe(true);
    expect(inQuietWindow(night, utc(1, 16, 5, 59))).toBe(true);
    expect(inQuietWindow(night, utc(1, 16, 6, 0))).toBe(false);
  });

  it("moves the end with the clock on the day of the change to summer time", () => {
    // 2026-03-29 01:00Z: 02:00 CET becomes 03:00 CEST.
    expect(inQuietWindow(night, utc(3, 29, 0, 59))).toBe(true);
    expect(inQuietWindow(night, utc(3, 29, 1, 0))).toBe(true);
    expect(inQuietWindow(night, utc(3, 29, 4, 59))).toBe(true);
    // 05:00Z is 07:00 CEST. A fixed offset of UTC+1 gives 06:00, in the window.
    expect(inQuietWindow(night, utc(3, 29, 5, 0))).toBe(false);
  });

  it("moves the end with the clock on the day of the change to winter time", () => {
    // 2026-10-25 01:00Z: 03:00 CEST becomes 02:00 CET.
    expect(inQuietWindow(night, utc(10, 24, 19, 59))).toBe(false);
    expect(inQuietWindow(night, utc(10, 24, 20, 0))).toBe(true);
    // 05:00Z is 06:00 CET. A fixed offset of UTC+2 gives 07:00, out of the window.
    expect(inQuietWindow(night, utc(10, 25, 5, 0))).toBe(true);
    expect(inQuietWindow(night, utc(10, 25, 5, 59))).toBe(true);
    expect(inQuietWindow(night, utc(10, 25, 6, 0))).toBe(false);
  });

  it("holds an hour that occurs two times, and an hour that does not occur", () => {
    const two: QuietWindow = { zone: "Europe/Berlin", start: "02:00", end: "03:00" };
    // 02:30 occurs at 00:30Z (CEST) and at 01:30Z (CET).
    expect(inQuietWindow(two, utc(10, 25, 0, 30))).toBe(true);
    expect(inQuietWindow(two, utc(10, 25, 1, 30))).toBe(true);
    expect(inQuietWindow(two, utc(10, 25, 2, 0))).toBe(false);
    // On 2026-03-29 the local clock goes from 01:59 to 03:00, so the window is empty on that day.
    expect(inQuietWindow(two, utc(3, 29, 0, 59))).toBe(false);
    expect(inQuietWindow(two, utc(3, 29, 1, 0))).toBe(false);
  });

  it("agrees with the offsets of the zone at each 5 minutes around the two changes", () => {
    const summerFrom = utc(3, 29, 1);
    const winterFrom = utc(10, 25, 1);
    const offset = (at: number): number => (at >= summerFrom && at < winterFrom ? 120 : 60);
    const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const windows: QuietWindow[] = [
      night,
      { zone: "Europe/Berlin", start: "02:00", end: "03:00" },
      { zone: "Europe/Berlin", start: "09:00", end: "17:00" },
      { zone: "Europe/Berlin", start: "23:30", end: "00:30" },
    ];
    let checked = 0;
    for (const change of [summerFrom, winterFrom]) {
      for (let at = change - 36 * 60 * MINUTE; at <= change + 36 * 60 * MINUTE; at += 5 * MINUTE) {
        const local = (((Math.floor(at / MINUTE) + offset(at)) % 1440) + 1440) % 1440;
        for (const window of windows) {
          const start = minutes(window.start);
          const end = minutes(window.end);
          const expected = start < end ? start <= local && local < end : local >= start || local < end;
          expect(inQuietWindow(window, at), `${new Date(at).toISOString()} ${window.start}-${window.end}`).toBe(expected);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(2 * 865 * 4);
  });

  it("gives the full day for an end equal to the start", () => {
    expect(inQuietWindow({ ...night, end: "22:00" }, utc(1, 15, 12, 0))).toBe(true);
    expect(inQuietWindow({ ...night, end: "22:00" }, utc(1, 15, 21, 59))).toBe(true);
  });

  it("gives false for an absent or bad window and for a bad time", () => {
    const at = utc(1, 15, 23, 0);
    expect(inQuietWindow(undefined, at)).toBe(false);
    expect(inQuietWindow({ ...night, zone: "Mars/Olympus" }, at)).toBe(false);
    expect(inQuietWindow({ ...night, start: "7:00" }, at)).toBe(false);
    expect(inQuietWindow({ ...night, end: "24:00" }, at)).toBe(false);
    expect(inQuietWindow(night, Number.NaN)).toBe(false);
    expect(inQuietWindow(night, 1e20)).toBe(false);
  });
});

describe("quietWindowProblems", () => {
  it("finds a bad time zone and a bad local time", () => {
    expect(quietWindowProblems({ zone: "Europe/Berlin", start: "22:00", end: "07:00" })).toEqual([]);
    expect(quietWindowProblems({ zone: "Mars/Olympus", start: "22:60", end: "7:00" })).toEqual([
      '"Mars/Olympus" is not the IANA name of a time zone.',
      'The start "22:60" is not a local time HH:MM from 00:00 to 23:59.',
      'The end "7:00" is not a local time HH:MM from 00:00 to 23:59.',
    ]);
    expect(quietWindowProblems({ zone: "UTC", start: "06:00", end: "06:00" })).toEqual([]);
  });
});

describe("escalate with a quiet window", () => {
  const quiet: QuietWindow = { zone: "UTC", start: "22:00", end: "07:00" };
  const atNight = Date.UTC(2026, 0, 15, 23, 0);
  const atDay = Date.UTC(2026, 0, 15, 12, 0);
  const notice: EscalationPolicy = { level: "notice", steps: [{ channel: pushover, at: 0 }], exhaustedAfter: 0 };

  it("makes each send below life-safety quiet in the window", () => {
    const plan = escalate(input({ policy: notice, quiet, since: atNight, now: atNight }));
    expect(plan.sends.map((send) => send.quiet)).toEqual([true]);
  });

  it("never makes a life-safety send quiet", () => {
    const plan = escalate(input({ quiet, since: atNight, now: atNight + 10 * MINUTE }));
    expect(plan.sends.map((send) => send.quiet)).toEqual([false, false, false]);
  });

  it("takes the time of now, not the time at which the step became due", () => {
    // The step became due at 06:55 and goes out at 07:05, out of the window.
    const due = Date.UTC(2026, 0, 16, 6, 55);
    expect(escalate(input({ policy: notice, quiet, since: due, now: due })).sends[0]?.quiet).toBe(true);
    expect(escalate(input({ policy: notice, quiet, since: due, now: due + 10 * MINUTE })).sends[0]?.quiet).toBe(false);
  });

  it("makes no send quiet out of the window or with no window", () => {
    expect(escalate(input({ policy: notice, quiet, since: atDay, now: atDay })).sends[0]?.quiet).toBe(false);
    expect(escalate(input({ policy: notice, since: atNight, now: atNight })).sends[0]?.quiet).toBe(false);
  });
});
