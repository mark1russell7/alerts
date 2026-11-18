import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { CONFIG_FORMAT, loadConfig, type AlertConfig, type ContactConfig, type PersonConfig } from "./config.ts";
import type { ChannelDescriptor, ChannelId, EscalationPolicy, Incident, PersonId, PlaceId, ReportId, WatchedPlace } from "./contracts.ts";
import { route, type ChannelRule, type Recipient, type Route } from "./delivery.ts";
import { DRILL_PROBES, nextDrillAt, type DrillConfig } from "./drill.ts";
import { incidents, normalize } from "./merge.ts";
import { DRILL_SUBJECT, NO_SYSTEM_LINES, systemReports } from "./system-reports.ts";

// The channel rules of the drills, from the configuration to the plans of route(). The rules of `loadConfig` send a run
// only to the person of the drill on its path, and a failure on each other channel. No rule changes a real warning.

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const MINUTE = 60_000;
const pushover = "pushover" as ChannelId;
const sms = "sms" as ChannelId;

// A public place in Kansas: Sedgwick County.
const home = "place-1" as PlaceId;
const places: readonly WatchedPlace[] = [{ id: home, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 0 }];

function channel(id: ChannelId, ack: ChannelDescriptor["ack"]): ChannelDescriptor {
  return { id, title: id, dependsOn: [], uses: ["internet", "dns"], breaksThrough: true, repeats: ack === "poll", ack, maxTitle: 250, maxBody: 1024 };
}
const CHANNELS = [channel(pushover, "poll"), channel(sms, "none")];

const LIFE_SAFETY: EscalationPolicy = {
  level: "life-safety",
  steps: [
    { channel: pushover, at: 0 },
    { channel: sms, at: 5 * MINUTE },
  ],
  exhaustedAfter: 20 * MINUTE,
};
// Two notice policies: one has the path of the drill, and one does not.
const NOTICES: readonly EscalationPolicy[] = [
  { level: "notice", steps: [{ channel: sms, at: 0 }], exhaustedAfter: 10 * MINUTE },
  {
    level: "notice",
    steps: [
      { channel: pushover, at: 0 },
      { channel: sms, at: MINUTE },
    ],
    exhaustedAfter: 10 * MINUTE,
  },
];

const window = { zone: "America/Chicago", start: "11:00", end: "17:00", days: [6] };
const DRILL = { id: "push-weekly", path: { kind: "channel", channel: pushover }, every: 6 * 24 * 60 * MINUTE, window, ackWithin: 30 * MINUTE } as const;

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

function routeAt(recipients: readonly Recipient[], list: readonly Incident[], now: number): Route[] {
  return route({ state: { reports: [], deliveries: [], acks: [], ends: [], retired: [] }, incidents: list, recipients, places, starts: [], cancelled: new Set(), channels: CHANNELS, now });
}

// The parts of a plan that a person sees: the policy, the state and the sends.
const view = (routes: readonly Route[]) => routes.map((entry) => ({ person: entry.person, policy: entry.policy, state: entry.plan.state, sends: entry.plan.sends.map((send) => [send.step, send.channel]) }));

describe("the channel rules of the drills in route() (AL-43)", () => {
  it("change no plan of a real warning, send a run only to the person of the drill, and keep the failure off the path", () => {
    for (const seed of SEEDS) {
      const r = random(`drill-rules:${seed}`);
      const context = `seed ${seed}`;
      const ids = Array.from({ length: r.int(1, 4) }, (_, index) => `person-${index + 1}` as PersonId);
      const owner = r.pick(ids);
      // The person of the drill watches it. Each other person watches it, or each drill, or nothing.
      const people: PersonConfig[] = ids.map((id) => ({
        watch: { person: id, places: [home], rules: [], ...(id === owner || r.chance(0.6) ? { subjects: [{ system: DRILL_SUBJECT, ...(r.chance(0.5) ? { id: DRILL.id } : {}) }] } : {}) },
        policies: [LIFE_SAFETY, r.pick(NOTICES)],
      }));
      const contacts: ContactConfig[] = ids.flatMap((id) => [
        { person: id, channel: pushover, address: { user: { secret: "PUSHOVER_USER_KEY" } } },
        { person: id, channel: sms, address: { to: { secret: "SMS_NUMBER" } } },
      ]);
      const drill: DrillConfig = { ...DRILL, person: owner };
      const config: AlertConfig = { format: CONFIG_FORMAT, places: [{ id: home, label: "Place A", codes: places[0]!.codes, bufferKm: 0 }], people, contacts, policies: [LIFE_SAFETY, NOTICES[0]!], drills: [drill] };
      const loaded = loadConfig(config, CHANNELS, () => "fake-value");
      expect(loaded.problems, context).toEqual([]);

      // 1. No rule changes a plan of a real warning: also seeded rules of each kind on top of the rules of the drill.
      const extra = (): ChannelRule[] =>
        Array.from({ length: r.int(0, 2) }, () => ({ kinds: [r.pick(["met.tornado", "met", "system.drill", "system"])], keep: r.pick(["only", "except"] as const), channels: r.sample([pushover, sms], r.int(0, 2)) }));
      const ruled = loaded.recipients.map((recipient) => ({ ...recipient, channelRules: [...(recipient.channelRules ?? []), ...extra()] }));
      const plain = loaded.recipients.map((recipient) => ({ ...recipient, channelRules: [] }));
      const warningAt = DRILL_PROBES[0]! + r.int(0, 600) * MINUTE;
      const warned = routeAt(ruled, [WARNING], warningAt);
      expect(view(warned), context).toEqual(view(routeAt(plain, [WARNING], warningAt)));
      expect(warned.length, context).toBe(ids.length);
      expect(warned.every((entry) => entry.ruled === undefined && entry.plan.sends.length > 0), context).toBe(true);

      // 2. A run of the drill sends only to its person, only on its path. Each other watcher has a plan with no step.
      const at = nextDrillAt(drill, [], DRILL_PROBES[0]!);
      if (at === undefined) throw new Error(`${context}: the drill has no start.`);
      const snapshot = { sources: [], health: [], coverage: [], threats: [], drills: [{ copy: "home", drill, run: { drill: drill.id, at } }] };
      const run = systemReports(NO_SYSTEM_LINES, snapshot, at);
      const runRoutes = routeAt(loaded.recipients, incidents(normalize({ reports: run.reports }), at), at);
      expect(runRoutes.flatMap((entry) => entry.plan.sends.map((send) => ({ person: entry.person, channel: send.channel }))), context).toEqual([{ person: owner, channel: pushover }]);
      for (const entry of runRoutes) if (entry.person !== owner) expect(entry.policy.steps, context).toEqual([]);

      // 3. Each plan tells the steps that the rules remove: the steps that stay and the dropped steps split the policy.
      for (const entry of runRoutes) {
        const own = loaded.recipients.find((recipient) => recipient.watch.person === entry.person)?.policies.find((policy) => policy.level === entry.policy.level);
        expect(own?.steps.filter((_, index) => !(entry.ruled?.dropped ?? []).includes(index)), context).toEqual(entry.policy.steps);
      }

      // 4. The failure reaches the person of the drill on a channel other than the path, and not on the path.
      const end = at + drill.ackWithin;
      const failed = systemReports(run.lines, snapshot, end).reports.filter((report) => report.kind.code === "system.drill.failed");
      const failure = routeAt(loaded.recipients, incidents(normalize({ reports: failed }), end), end).find((entry) => entry.person === owner);
      expect(failure?.policy.steps.length ?? 0, context).toBeGreaterThan(0);
      expect(failure?.policy.steps.some((step) => step.channel === pushover), context).toBe(false);
    }
  });
});
