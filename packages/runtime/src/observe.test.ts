import { fakeWallClock } from "@mark1russell7/algebra/clock";
import {
  reportId,
  type AssessPolicy,
  type ChannelId,
  type ChannelProcedures,
  type EscalationPolicy,
  type Message,
  type Observation,
  type ObservationId,
  type PersonId,
  type PlaceId,
  type Recipient,
  type Report,
  type Severity,
  type SourceDescriptor,
  type SourceId,
  type SourceProcedures,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { modeEvent, modeEvents, observingSources, SEED_REASON } from "./observe.ts";
import { openRuntime, type Pass, type RuntimeOptions } from "./runtime.ts";
import { rebuild } from "./state.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const OLD = "nws-api" as SourceId;
const NEW = "gtfs-new" as SourceId;
const PUSH = "push" as ChannelId;
const PERSON = "person-1" as PersonId;

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

/** A policy where the severity alone gives the level: extreme is life-safety, severe urgent, moderate notice and minor digest. */
const BY_SEVERITY: AssessPolicy = {
  statuses: ["actual"],
  classes: [],
  otherwise: {
    severity: { extreme: "life-safety", severe: "urgent", moderate: "notice", minor: "digest", unknown: "none" },
    urgency: { immediate: "life-safety", expected: "life-safety", future: "life-safety", past: "life-safety", unknown: "life-safety" },
  },
};

const POLICIES: readonly EscalationPolicy[] = (["life-safety", "urgent", "notice"] as const).map((level) => ({ level, steps: [{ channel: PUSH, at: 0 }], exhaustedAfter: 10 * MINUTE }));
const RECIPIENT: Recipient = { watch: { person: PERSON, places: [KANSAS.id], rules: [] }, policies: POLICIES, addresses: { push: { user: "fake-user" } } };

function descriptor(id: SourceId, kinds: readonly string[] = ["met"]): SourceDescriptor {
  return {
    id,
    title: `The source ${id}`,
    origins: ["nws"],
    dependsOn: [`provider:${id}`],
    uses: ["internet", "dns", "power"],
    kinds,
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval: MINUTE,
    slowAfter: 10_000,
    auth: "none",
  };
}

/** One report that a fake source gives, with its key, its time and its severity. */
interface Planned {
  readonly key: string;
  readonly issued: number;
  readonly severity: Severity;
}

function report(seen: Observation, planned: Planned): Report {
  return {
    id: reportId({ source: seen.source, key: planned.key, sent: planned.issued }),
    source: seen.source,
    origin: "nws",
    key: planned.key,
    references: [],
    correlation: [{ system: "test", id: planned.key }],
    status: "actual",
    op: "alert",
    kind: { code: "met.flood", label: "Flood Warning" },
    categories: ["met"],
    severity: planned.severity,
    urgency: "immediate",
    certainty: "observed",
    response: ["monitor"],
    sent: planned.issued,
    received: seen.fetched,
    expires: planned.issued + 3 * DAY,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "test",
    headline: `Flood ${planned.key}`,
    observation: seen.id,
    parameters: {},
  };
}

/** This helper gives a fake source that gives the planned reports of the test at each fetch. */
function source(id: SourceId, now: () => number, planned: () => readonly Planned[]): SourceProcedures {
  return {
    describe: () => descriptor(id),
    fetch: async () => {
      const fetched = now();
      const seen: Observation = { id: `${id}:${String(fetched)}` as ObservationId, source: id, fetched, contentType: "application/json", body: JSON.stringify(planned()), transport: { latency: 0 } };
      return { ok: true, observations: [seen], complete: true };
    },
    map: ({ observation: seen }: { readonly observation: Observation }) => ({ reports: (JSON.parse(seen.body) as Planned[]).map((entry) => report(seen, entry)), problems: [] }),
  };
}

/** This helper gives a fake push channel that records each message. */
function channel(now: () => number): { readonly procedures: ChannelProcedures; readonly sent: Message[] } {
  const sent: Message[] = [];
  const procedures: ChannelProcedures = {
    describe: () => ({ id: PUSH, title: "Push", dependsOn: [], uses: ["internet", "dns"], breaksThrough: true, repeats: false, ack: "none", maxTitle: 250, maxBody: 1024 }),
    send: async ({ message }) => {
      sent.push(message);
      return { ok: true, receipt: { receipt: `push-${String(sent.length)}` }, accepted: now() };
    },
    status: async () => ({ state: "delivered", at: now() }),
    cancel: async () => {},
  };
  return { procedures, sent };
}

/** One world of a test: a log, a clock, a channel and the planned reports of each source. A runtime opens on them. */
function world() {
  const clock = fakeWallClock(T0);
  const log = openRuntimeLog(":memory:");
  const push = channel(() => clock.now());
  const plans = new Map<SourceId, Planned[]>([
    [OLD, []],
    [NEW, []],
  ]);
  const open = (ids: readonly SourceId[]) =>
    openRuntime({
      log,
      clock,
      sources: ids.map((id) => source(id, () => clock.now(), () => plans.get(id) ?? [])),
      watch: () => ({ places: [KANSAS], kinds: ["met"] }),
      view: VIEW,
      run: `run-${String(clock.now())}`,
      delivery: { recipients: [RECIPIENT], channels: [push.procedures], assess: BY_SEVERITY, pollEvery: 30_000, retry: 15_000, callLimit: 10_000, flightLimit: 40_000 },
    });
  const plan = (id: SourceId, ...entries: Planned[]) => plans.get(id)!.push(...entries);
  return { clock, log, push, open, plan };
}

const modeIds = (log: RuntimeLog) => [...log.read()].filter((event) => event.type === "mode").map((event) => event.id);
const titles = (sent: readonly Message[]) => sent.map((message) => message.title).filter((title) => title.includes("Flood"));
const kindsOf = (pass: Pass, prefix: string) => pass.view.step.reports.filter((entry) => entry.kind.code.startsWith(prefix)).map((entry) => [entry.op, entry.kind.code]);

describe("modeEvents", () => {
  const context = descriptor("gtfs-context" as SourceId, ["transport.transit"]);

  it("seeds each source of the first start as live, except a source of context only, which observes", () => {
    const events = modeEvents({ modes: {} }, [descriptor(OLD), context], T0);
    expect(events.map((event) => [event.id, event.mode, event.reason, event.time])).toEqual([
      [`mode:${OLD}:live`, "live", SEED_REASON, T0],
      ["mode:gtfs-context:observe", "observe", SEED_REASON, T0],
    ]);
  });

  it("starts each later source with no mode in the observe mode, and gives no event for a source with a mode", () => {
    const events = modeEvents({ modes: { [OLD]: { live: T0 } } }, [descriptor(OLD), descriptor(NEW)], T0 + HOUR);
    expect(events.map((event) => [event.id, event.mode, event.reason])).toEqual([[`mode:${NEW}:observe`, "observe", "new source"]]);
  });
});

describe("the fold of the mode events", () => {
  it("keeps the first time of each mode, and a source that went live does not observe again", () => {
    const state = rebuild(
      [modeEvent(NEW, "observe", "new source", T0), modeEvent(NEW, "observe", "new source", T0 + HOUR), modeEvent(NEW, "live", "passed", T0 + DAY), modeEvent(NEW, "live", "passed", T0 + 2 * DAY), modeEvent(NEW, "observe", "new source", T0 + 3 * DAY)],
      { sources: [] },
    );
    expect(state.modes[NEW]).toEqual({ since: T0, live: T0 + DAY });
    expect(observingSources(state)).toEqual(new Map());
    expect(observingSources(rebuild([modeEvent(NEW, "observe", "new source", T0)], { sources: [] }))).toEqual(new Map([[NEW, T0]]));
  });
});

describe("the observe mode in the passes of the runtime (AL-73)", () => {
  it("holds each report of a new source, reads its start from the log after a restart, and sends after one day with no limit passed", async () => {
    const { clock, log, push, open, plan } = world();
    plan(OLD, { key: "a1", issued: T0, severity: "moderate" });
    // The first start with modes seeds the source of the configuration as live. Its report goes out.
    await open([OLD]).pass();
    expect(titles(push.sent)).toHaveLength(1);
    // A restart with a new source. The new source observes from the time of its first pass.
    await clock.advance(MINUTE);
    const start = clock.now();
    plan(NEW, { key: "b1", issued: start, severity: "moderate" });
    const first = await open([OLD, NEW]).pass();
    expect(titles(push.sent)).toHaveLength(1);
    expect(first.modes?.find((entry) => entry.source === NEW)).toMatchObject({ mode: "observe", since: start, hours: 0, perHour: 1, share: 1 });
    // A restart in the middle reads the start from the log, thus the observed time does not start again.
    await clock.advance(12 * HOUR);
    const middle = await open([OLD, NEW]).pass();
    expect(middle.modes?.find((entry) => entry.source === NEW)).toMatchObject({ mode: "observe", since: start, hours: 12, reason: "12.0 of 24 hours observed" });
    expect(titles(push.sent)).toHaveLength(1);
    // One day after the start, no person passes a limit. The source goes live in that pass, and the cut sends its incident.
    await clock.advance(start + DAY - clock.now());
    const runtime = open([OLD, NEW]);
    const live = await runtime.pass();
    expect(live.modes?.find((entry) => entry.source === NEW)).toEqual({ source: NEW, mode: "live", since: start, live: start + DAY });
    expect(titles(push.sent)).toHaveLength(2);
    expect(modeIds(log)).toEqual([`mode:${OLD}:live`, `mode:${NEW}:observe`, `mode:${NEW}:live`]);
    // A later restart writes no mode event.
    await clock.advance(MINUTE);
    await open([OLD, NEW]).pass();
    expect(modeIds(log)).toHaveLength(3);
    log.close();
  });

  it("holds a source with a burst past its day, with a held line and the reason in plain words in the status", async () => {
    const { clock, log, push, open, plan } = world();
    await open([OLD]).pass();
    await clock.advance(MINUTE);
    const start = clock.now();
    const runtime = open([OLD, NEW]);
    await runtime.pass();
    // Twelve hours later, the source gives seven notices in one hour. The limit of the notices is 6 in each hour.
    await clock.advance(12 * HOUR);
    const burst = clock.now();
    plan(NEW, ...Array.from({ length: 7 }, (_, index): Planned => ({ key: `b${String(index)}`, issued: burst - index * MINUTE, severity: "moderate" })));
    await runtime.pass();
    await clock.advance(start + DAY - clock.now());
    const judged = await runtime.pass();
    const reason = "person 1: 7 notices in 1 hour, limit 6";
    expect(judged.modes?.find((entry) => entry.source === NEW)).toMatchObject({ mode: "observe", hours: 24, reason });
    expect(judged.wakeAt).toBe(judged.at + 1);
    // The held line goes into the view of the next pass, with the reason as its text.
    await clock.advance(1);
    const next = await runtime.pass();
    expect(kindsOf(next, "system.health.observe")).toEqual([["alert", "system.health.observe"]]);
    expect(next.view.step.reports.find((entry) => entry.kind.code === "system.health.observe")?.description).toBe(reason);
    expect(titles(push.sent)).toEqual([]);
    expect(modeIds(log)).toEqual([`mode:${OLD}:live`, `mode:${NEW}:observe`]);
    // The burst leaves the window 24 hours after it. The source goes live, and the held line ends in the next pass.
    await clock.advance(burst + DAY - clock.now() + MINUTE);
    const passed = await runtime.pass();
    expect(passed.modes?.find((entry) => entry.source === NEW)?.mode).toBe("live");
    await clock.advance(1);
    expect(kindsOf(await runtime.pass(), "system.health.observe")).toEqual([["cancel", "system.health.observe"]]);
    log.close();
  });

  it("sends a life-safety incident of a new source, and gives a system note for it in the next pass", async () => {
    const { clock, log, push, open, plan } = world();
    await open([OLD]).pass();
    await clock.advance(MINUTE);
    plan(NEW, { key: "b1", issued: clock.now(), severity: "extreme" }, { key: "b2", issued: clock.now(), severity: "moderate" });
    const runtime = open([OLD, NEW]);
    const first = await runtime.pass();
    expect(titles(push.sent)).toEqual(["Flood b1"]);
    expect(first.wakeAt).toBe(first.at + 1);
    await clock.advance(1);
    const next = await runtime.pass();
    expect(kindsOf(next, "system.health.observe")).toEqual([["alert", "system.health.observe-life-safety"]]);
    expect(titles(push.sent)).toEqual(["Flood b1"]);
    log.close();
  });
});
