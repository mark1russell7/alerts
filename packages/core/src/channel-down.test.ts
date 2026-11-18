import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { CHANNEL_KIND } from "./assess.ts";
import { channelDownPolicy, channelRuns, COUNTED_FAILURES, DEFAULT_CHANNEL_DOWN, runOpens, type ChannelRun, type ChannelRunStep, type ChannelSnapshot } from "./channel-down.ts";
import { channelDownRules, CONFIG_FORMAT } from "./config.ts";
import type { ChannelDescriptor, ChannelFailureKind, ChannelId, EscalationPolicy, Instant, PersonId, Report } from "./contracts.ts";
import { route, ruleSteps, type Recipient } from "./delivery.ts";
import { composeInterests, deliveryLayer } from "./interest-defaults.ts";
import { incidents, normalize } from "./merge.ts";
import { alertConfigSchema, channelDescriptorSchema, channelDownConfigSchema } from "./schemas.ts";
import { addSystemReports, CHANNEL_SUBJECT, NO_SYSTEM_LINES, systemReports, type SystemLines, type SystemSnapshot } from "./system-reports.ts";

// A run of failed calls tells of a down channel, and the first good call ends its line (AL-65). Each name and endpoint is made up.

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.UTC(2026, 4, 2, 18, 0);
const push = "push" as ChannelId;
const text = "text" as ChannelId;
const COPY = "copy-a";
const PUSH_API = "domain:api.example.com";
const TEXT_API = "domain:text.example.net";

function descriptor(id: ChannelId, api: string): ChannelDescriptor {
  return { id, title: id === push ? "Push" : "Text", dependsOn: [], services: [api], api: [api], uses: ["internet", "dns"], breaksThrough: true, repeats: false, ack: "none", maxTitle: 250, maxBody: 1024 };
}
const CHANNELS = [descriptor(push, PUSH_API), descriptor(text, TEXT_API)];

const empty: SystemSnapshot = { sources: [], health: [], coverage: [], threats: [] };

function entry(fields: Partial<ChannelSnapshot> = {}): ChannelSnapshot {
  return { copy: COPY, channel: push, title: "Push", api: [PUSH_API], ...fields };
}

function run(fields: Partial<ChannelRun> = {}): ChannelRun {
  return { channel: push, failures: 3, first: T0, last: T0 + MINUTE, kind: "server", reached: true, ...fields };
}

function step(at: Instant, failures: readonly { channel?: ChannelId; call?: string; kind: string }[], good: readonly ChannelId[] = [], lastSuccess?: Instant): ChannelRunStep {
  return { at, failures: failures.map((failure) => ({ channel: failure.channel ?? push, call: failure.call ?? "send", kind: failure.kind })), good, ...(lastSuccess === undefined ? {} : { lastSuccess }) };
}

const ops = (reports: readonly Report[]) => reports.map((report) => report.op);

describe("the runs of failed calls of the channels", () => {
  it("counts the failed sends, status calls and probes of the counted kinds, and a good call ends the run", () => {
    let runs = channelRuns([], step(T0, [{ kind: "server" }, { kind: "consent" }, { kind: "quiet" }, { call: "cancel", kind: "server" }]));
    expect(runs).toEqual([{ channel: push, failures: 1, first: T0, last: T0, kind: "server", reached: true }]);
    runs = channelRuns(runs, step(T0 + 30 * SECOND, [{ call: "status", kind: "timeout" }, { kind: "rate-limited" }, { kind: "refused" }, { kind: "expired" }, { kind: "reserved" }]));
    expect(runs).toEqual([{ channel: push, failures: 2, first: T0, last: T0 + 30 * SECOND, kind: "timeout", reached: true }]);
    // A good call in a step ends the run, and the failed calls of that step start no run.
    expect(channelRuns(runs, step(T0 + MINUTE, [{ kind: "server" }], [push]))).toEqual([]);
    expect(COUNTED_FAILURES).toEqual(["network", "timeout", "server", "auth"]);
    // A failed probe of a quiet channel counts. Three probes over 60 s open a line with no message.
    let quiet = channelRuns([], step(T0, [{ call: "probe", kind: "server" }]));
    quiet = channelRuns(quiet, step(T0 + MINUTE, [{ call: "probe", kind: "server" }, { call: "probe", kind: "rate-limited" }]));
    quiet = channelRuns(quiet, step(T0 + 3 * MINUTE, [{ call: "probe", kind: "server" }]));
    expect(quiet).toEqual([{ channel: push, failures: 3, first: T0, last: T0 + 3 * MINUTE, kind: "server", reached: true }]);
    expect(runOpens(quiet[0]!, DEFAULT_CHANNEL_DOWN)).toBe(true);
  });

  it("marks a run as reached only by an answer of the provider or a source success during the run", () => {
    // Network failures with no source success after the first failure: the copy can be offline.
    let runs = channelRuns([], step(T0, [{ kind: "network" }], [], T0 - MINUTE));
    runs = channelRuns(runs, step(T0 + MINUTE, [{ kind: "network" }], [], T0 - MINUTE));
    runs = channelRuns(runs, step(T0 + 2 * MINUTE, [{ kind: "timeout" }], [], T0 - MINUTE));
    expect(runs[0]?.reached).toBe(false);
    expect(runOpens(runs[0]!, DEFAULT_CHANNEL_DOWN)).toBe(false);
    // A source fetched with success after the first failure, and the calls still fail: the network of the copy works.
    const online = channelRuns(runs, step(T0 + 3 * MINUTE, [{ kind: "network" }], [], T0 + 2 * MINUTE + 30 * SECOND));
    expect(online[0]?.reached).toBe(true);
    // An auth failure is an answer of the provider.
    expect(channelRuns([], step(T0, [{ kind: "auth" }]))[0]?.reached).toBe(true);
  });

  it("opens only at the count and the time of the policy, and the configuration gives the policy", () => {
    expect(runOpens(run(), DEFAULT_CHANNEL_DOWN)).toBe(true);
    expect(runOpens(run({ failures: 2 }), DEFAULT_CHANNEL_DOWN)).toBe(false);
    // A burst of failures under 60 s opens no line: one pass with three people fails three sends at once.
    expect(runOpens(run({ failures: 9, last: T0 + 59 * SECOND }), DEFAULT_CHANNEL_DOWN)).toBe(false);
    expect(channelDownPolicy()).toEqual({ failures: 3, span: MINUTE });
    expect(channelDownPolicy({ failures: 5 })).toEqual({ failures: 5, span: MINUTE });
    expect(runOpens(run({ failures: 4 }), channelDownPolicy({ failures: 5 }))).toBe(false);
    expect(runOpens(run({ failures: 3, last: T0 + 10 * SECOND }), channelDownPolicy({ span: 0 }))).toBe(true);
  });
});

describe("the line of a down channel", () => {
  it("opens one line for a seeded run, and the first good send ends it", () => {
    for (const seed of SEEDS) {
      const r = random(`channel-down:${seed}`);
      const context = `seed ${seed}`;
      let lines: SystemLines = NO_SYSTEM_LINES;
      let runs: ChannelRun[] = [];
      let at = T0;
      const opened: Report[] = [];
      const count = r.int(3, 9);
      for (let index = 0; index < count; index += 1) {
        at += r.int(10, 45) * SECOND;
        const kind = r.pick(["network", "timeout", "server"] as const satisfies readonly ChannelFailureKind[]);
        // The sources fetch with success between the failed calls: the network of the copy works.
        runs = channelRuns(runs, step(at, [{ kind }], [], at - SECOND));
        const result = systemReports(lines, { ...empty, channels: [entry({ ...(runs[0] === undefined ? {} : { run: runs[0] }) })] }, at);
        lines = result.lines;
        opened.push(...result.reports);
        const expected = runs[0]!.failures >= 3 && runs[0]!.last - runs[0]!.first >= MINUTE && runs[0]!.reached;
        expect(Object.keys(lines.open).length, context).toBe(expected ? 1 : 0);
      }
      const open = runOpens(runs[0]!, DEFAULT_CHANNEL_DOWN);
      expect(ops(opened), context).toEqual(open ? ["alert"] : []);
      if (!open) continue;
      expect(opened[0]?.kind.code, context).toBe(`${CHANNEL_KIND}.down`);
      expect(opened[0]?.onset, context).toBe(T0 + (runs[0]!.first - T0));
      // The first good send ends the run and the line.
      at += 30 * SECOND;
      runs = channelRuns(runs, step(at, [], [push]));
      expect(runs, context).toEqual([]);
      const ended = systemReports(lines, { ...empty, channels: [entry({ good: at })] }, at);
      expect(ops(ended.reports), context).toEqual(["cancel"]);
      expect(ended.lines.open, context).toEqual({});
    }
  });

  it("names the channel, the copy and the endpoints, and holds no address", () => {
    const { reports } = systemReports(NO_SYSTEM_LINES, { ...empty, channels: [entry({ run: run({ failures: 4, last: T0 + 90 * SECOND }) })] }, T0 + 90 * SECOND);
    const [report] = reports;
    expect(report?.status).toBe("system");
    expect(report?.about).toEqual([
      { system: CHANNEL_SUBJECT, id: push, label: "Push" },
      { system: "domain", id: "api.example.com" },
    ]);
    expect(report?.areas).toEqual([]);
    // An endpoint key with no system or no id gives no subject. The schema refuses it, and a descriptor in code has no parse.
    const odd = systemReports(NO_SYSTEM_LINES, { ...empty, channels: [entry({ api: ["api.example.com", ":id", "domain:", PUSH_API], run: run() })] }, T0 + MINUTE);
    expect(odd.reports[0]?.about).toEqual(report?.about);
    expect(report?.headline).toBe("Push is down for the copy copy-a.");
    expect(report?.description).toBe("The calls of the copy copy-a to the provider of Push fail. 4 calls failed in 90 s, and the provider gave a server error at the last call.");
  });

  it("tells that a refused key is not an outage", () => {
    const { reports, lines } = systemReports(NO_SYSTEM_LINES, { ...empty, channels: [entry({ run: run({ kind: "auth" }) })] }, T0 + MINUTE);
    expect(reports[0]?.headline).toBe("The provider of Push refuses the key of the channel. This is not an outage.");
    expect(reports[0]?.description).toContain("The fault does not end by itself.");
    expect(reports[0]?.instruction).toContain("Replace the key");
    // A new count is not a fact: no update. A new cause is a fact: an update.
    expect(systemReports(lines, { ...empty, channels: [entry({ run: run({ kind: "auth", failures: 7, last: T0 + 5 * MINUTE }) })] }, T0 + 5 * MINUTE).reports).toEqual([]);
    const changed = systemReports(lines, { ...empty, channels: [entry({ run: run({ kind: "timeout", failures: 8, last: T0 + 6 * MINUTE }) })] }, T0 + 6 * MINUTE);
    expect(ops(changed.reports)).toEqual(["update"]);
    expect(changed.reports[0]?.headline).toBe("Push is down for the copy copy-a.");
  });

  it("opens no line when the copy is offline: no source success during the run", () => {
    expect(systemReports(NO_SYSTEM_LINES, { ...empty, channels: [entry({ run: run({ kind: "network", reached: false, failures: 9, last: T0 + 9 * MINUTE }) })] }, T0 + 9 * MINUTE).reports).toEqual([]);
  });

  it("keeps an open line after a restart empties the run, and a good call at or after the onset ends it", () => {
    const opened = systemReports(NO_SYSTEM_LINES, { ...empty, channels: [entry({ run: run() })] }, T0 + MINUTE);
    // The runtime rebuilds the lines from its log. The run is in memory, so the restart empties it.
    const rebuilt = addSystemReports(NO_SYSTEM_LINES, opened.reports, opened.observations);
    expect(rebuilt).toEqual(opened.lines);
    // The last good send before the onset ends nothing.
    expect(systemReports(rebuilt, { ...empty, channels: [entry({ good: T0 - MINUTE })] }, T0 + 10 * MINUTE).reports).toEqual([]);
    expect(ops(systemReports(rebuilt, { ...empty, channels: [entry({ good: T0 + 10 * MINUTE })] }, T0 + 10 * MINUTE).reports)).toEqual(["cancel"]);
    // With no list of channels, each open line stays. A channel that left the configuration ends its line.
    expect(systemReports(rebuilt, empty, T0 + 10 * MINUTE).reports).toEqual([]);
    expect(ops(systemReports(rebuilt, { ...empty, channels: [] }, T0 + 10 * MINUTE).reports)).toEqual(["cancel"]);
  });

  it("gives each copy its own line", () => {
    const both = systemReports(NO_SYSTEM_LINES, { ...empty, channels: [entry({ run: run() }), entry({ copy: "copy-b", run: run() })] }, T0 + MINUTE);
    expect(Object.keys(both.lines.open)).toEqual(["channel/copy-a/push", "channel/copy-b/push"]);
    // The good send of one copy ends only its own line.
    const one = systemReports(both.lines, { ...empty, channels: [entry({ good: T0 + 2 * MINUTE }), entry({ copy: "copy-b", run: run() })] }, T0 + 2 * MINUTE);
    expect(Object.keys(one.lines.open)).toEqual(["channel/copy-b/push"]);
  });

  it("uses the policy of the snapshot", () => {
    const strict = systemReports(NO_SYSTEM_LINES, { ...empty, channels: [entry({ run: run({ failures: 4 }) })], channelDown: { failures: 5 } }, T0 + MINUTE);
    expect(strict.reports).toEqual([]);
  });
});

describe("the route of the report of a down channel", () => {
  const PERSON = "person-1" as PersonId;
  const OTHER = "person-2" as PersonId;
  const NOTICE: EscalationPolicy = {
    level: "notice",
    steps: [
      { channel: push, at: 0 },
      { channel: text, at: 0 },
    ],
    exhaustedAfter: 0,
  };
  function recipient(person: PersonId, channels: readonly ChannelDescriptor[]): Recipient {
    const { graph } = composeInterests(person, [deliveryLayer(channels)]);
    const addresses = Object.fromEntries(channels.map((channel) => [channel.id, { to: "fake-address" }]));
    return { watch: { person, places: [], rules: [], interests: graph }, policies: [NOTICE], addresses, channelRules: channelDownRules(channels.map((channel) => channel.id)) };
  }

  it("reaches each person with a contact on the channel through its endpoint, on the other channels only", () => {
    const { reports } = systemReports(NO_SYSTEM_LINES, { ...empty, channels: [entry({ run: run() })] }, T0 + MINUTE);
    const list = incidents(normalize({ reports }), T0 + MINUTE);
    const routes = route({ incidents: list, recipients: [recipient(PERSON, CHANNELS), recipient(OTHER, [CHANNELS[1]!])], places: [], cancelled: new Set<string>(), channels: CHANNELS, state: { reports: [], deliveries: [], acks: [], ends: [], retired: [] }, starts: [], now: T0 + MINUTE });
    // The other person has no contact on the push channel, so the endpoint of the push is not in the graph of that person.
    expect(routes.map((entry) => entry.person)).toEqual([PERSON]);
    expect(routes[0]?.policy.steps.map((entry) => entry.channel)).toEqual([text]);
    expect(routes[0]?.ruled?.dropped).toEqual([0]);
  });

  it("drops only the steps on the down channel", () => {
    const rules = channelDownRules([push, text]);
    const incident = { status: "system", kind: { code: `${CHANNEL_KIND}.down`, label: "Down channel" }, about: [{ system: CHANNEL_SUBJECT, id: text }] } as const;
    expect(ruleSteps(NOTICE, rules, incident).policy.steps.map((entry) => entry.channel)).toEqual([push]);
    // A real warning keeps each step.
    expect(ruleSteps(NOTICE, rules, { ...incident, status: "actual" }).policy).toBe(NOTICE);
  });
});

describe("the schemas of a down channel", () => {
  it("checks that each endpoint is a service, and that a list of endpoints is not empty", () => {
    expect(channelDescriptorSchema.safeParse(CHANNELS[0]).success).toBe(true);
    expect(channelDescriptorSchema.safeParse({ ...CHANNELS[0], api: [TEXT_API] }).success).toBe(false);
    expect(channelDescriptorSchema.safeParse({ ...CHANNELS[0], api: [] }).success).toBe(false);
  });

  it("checks the policy in the configuration", () => {
    expect(channelDownConfigSchema.safeParse({ failures: 3, span: MINUTE }).success).toBe(true);
    expect(channelDownConfigSchema.safeParse({}).success).toBe(true);
    expect(channelDownConfigSchema.safeParse({ failures: 0 }).success).toBe(false);
    expect(channelDownConfigSchema.safeParse({ span: -1 }).success).toBe(false);
    expect(channelDownConfigSchema.safeParse({ failures: 3, other: 1 }).success).toBe(false);
    expect(alertConfigSchema.safeParse({ format: CONFIG_FORMAT, places: [], people: [], contacts: [], policies: [], channelDown: { failures: 4 } }).error?.issues).toBeUndefined();
  });
});
