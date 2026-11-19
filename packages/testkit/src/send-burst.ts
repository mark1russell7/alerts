/**
 * AL-72, case 15: a burst of new incidents and the send limit of each person. One source gives 100 made-up flood
 * statements and 2 made-up tornado warnings for one place at one time. A flood statement reaches the person at
 * `notice`, and a tornado warning reaches the person at `life-safety`. The send limit holds the notices past the limit
 * of the person, and the next digest tells them. A `life-safety` alert has no limit. The throttle of the channel stops
 * each notice after the first notice in its window (AL-72 part 4), and the next digest tells them too.
 *
 * Each arm has one runtime or two runtimes on one fake wall clock: `home` with rank 0 and `cloud` with rank 1, as two
 * instances. The case does each pass and each read of the exchange itself, in steps of `stepMs`. A read takes the pages
 * of the other copy through JSON, as on the wire. Each copy sends to one fake phone channel that records each send.
 *
 * The arms:
 *
 * - `one-copy`: one runtime.
 * - `two-copies`: two runtimes that read each other at each step.
 * - `split`: two runtimes that cannot read each other for `splitMs`. The burst comes in the split.
 * - `imported`: only `home` has the source. `cloud` gets the incidents and the deliveries of `home` by the exchange.
 * - `flapping`: the arm `two-copies`, and each copy has a second source that fails 2 fetches of each 4 for `flapMs`.
 *   The person watches the health of the sources, thus each flap of the source is a new system incident at `notice`.
 * - `rollback`: an older build with no limit sends each alert in a first life. A newer build then ends each episode of
 *   each `notice` escalation. A second life with the limit opens the log `rollbackMs` after the start, and it opens each
 *   episode again. A second wave of new flood statements comes `waveAtMs` after the start of the second life. Only the
 *   sends of the second life count. The episodes that the second life opens again have their first delivery before the
 *   window. Thus a limit that counts only the first delivery of an incident sends the wave past the limit.
 *
 * The gates of each arm:
 *
 * - `capped`: in each window of the limit, the incidents with a send to the person at a level are not more than the limit.
 * - `held`: each flood statement has a send, a hold or a suppression. No copy sends an incident after its own hold or
 *   suppression of the incident.
 * - `lifeSafety`: each tornado warning has a send.
 * - `settles`: in the last `quietMs` of the arm, no copy writes an escalation, a hold, a suppression or an end, and no
 *   copy sends.
 * - `noThrow`: no pass throws, and each read of the exchange has no problem.
 * - `oneSend`, in the arms where the copies read each other at each step: no incident has a send of each copy.
 * - `throttled`: in each window of the throttle, each copy sends at most one notice of each stream to the person. The
 *   system lines, such as the held notice of the send limit (AL-81), and the alerts are two streams.
 * - `flapped`, in `flapping`: the flaps gave 1 system incident or more, and each one has a send, a hold or a suppression. Before
 *   AL-75, each flap opens a new incident. A flap window of the health line keeps one incident for each episode.
 */
import { fakeWallClock, type WallClock } from "@mark1russell7/algebra/clock";
import {
  type ChannelId,
  type ChannelProcedures,
  type CopyRead,
  DEFAULT_SEND_LIMITS,
  type EscalationPolicy,
  HEALTH_KIND,
  type Level,
  type Observation,
  type ObservationId,
  type PersonId,
  type Recipient,
  type Report,
  reportId,
  type SendLimits,
  type SourceDescriptor,
  DEFAULT_THROTTLE,
  type Throttle,
  throttleStreamOf,
  type SourceId,
  type SourceProcedures,
  SOURCE_SUBJECT,
} from "@mark1russell7/alerts";
import {
  CLOCK_SKEW_LIMIT,
  COPY_MAX_AGE,
  type CopyChecks,
  DELIVERY_TIMES,
  envelope,
  openRuntime,
  openRuntimeLog,
  parsePage,
  RANK_DELAY,
  type Runtime,
  type RuntimeEvent,
  type RuntimeLog,
  type RuntimeOptions,
} from "@mark1russell7/alerts-runtime";
import { errorMessage } from "@mark1russell7/text";
import { FIXTURE_PLACE } from "./delivery-fixture.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The id of the case. */
export const CASE_15_ID = "al-13-case-15";

/** The start of each arm. */
export const CASE_15_START: number = Date.UTC(2026, 3, 2, 18);

/** The id of the source of the burst. */
export const BURST_SOURCE = "case-15" as SourceId;

/** The id of the source that flaps in the arm `flapping`. */
export const FLAP_SOURCE = "case-15-flap" as SourceId;

/** The fake phone channel of the case. */
const PHONE = "phone" as ChannelId;

/** The person of the case. */
const PERSON = "person-1" as PersonId;

/** The arms of the case. */
export const BURST_ARMS = ["one-copy", "two-copies", "split", "imported", "flapping", "rollback"] as const;
/** One arm of the case. */
export type BurstArm = (typeof BURST_ARMS)[number];

/** The gates of the case. */
export const BURST_GATES = ["capped", "held", "throttled", "lifeSafety", "settles", "noThrow", "oneSend", "flapped"] as const;
/** One gate of the case. */
export type BurstGate = (typeof BURST_GATES)[number];

const BASE_GATES: readonly BurstGate[] = ["capped", "held", "throttled", "lifeSafety", "settles", "noThrow"];

/** The gates of each arm. */
export const ARM_BURST_GATES: Readonly<Record<BurstArm, readonly BurstGate[]>> = {
  "one-copy": BASE_GATES,
  "two-copies": [...BASE_GATES, "oneSend"],
  split: BASE_GATES,
  imported: [...BASE_GATES, "oneSend"],
  flapping: [...BASE_GATES, "oneSend", "flapped"],
  rollback: BASE_GATES,
};

/** The two copies of the case. */
export type BurstCopy = "home" | "cloud";

/** The settings of the case. Each time is in milliseconds. */
export interface BurstSettings {
  /** The count of the flood statements of the burst. */
  readonly floods: number;
  /** The count of the tornado warnings of the burst. */
  readonly tornadoes: number;
  /** The time of the burst after the start of the arm. The copies read each other before it. */
  readonly burstAtMs: number;
  /** The fake time of each step. */
  readonly stepMs: number;
  /** The fake time of one arm, or of the second life in `rollback`. */
  readonly armMs: number;
  /** The quiet tail of each arm for the gate `settles`. */
  readonly quietMs: number;
  /** The time of the split in `split`, from the start. */
  readonly splitMs: number;
  /** The time of the flaps in `flapping`, from the start. */
  readonly flapMs: number;
  /** The fake time of the first life in `rollback`. */
  readonly firstLifeMs: number;
  /** The start of the second life in `rollback`, from the start of the first life. */
  readonly rollbackMs: number;
  /** The count of the flood statements of the second wave in `rollback`. */
  readonly waveFloods: number;
  /** The time of the second wave in `rollback`, from the start of the second life. */
  readonly waveAtMs: number;
  /** The send limits of the person. */
  readonly limits: SendLimits;
  /** The throttle of each person and channel. The first life of `rollback` has no throttle. */
  readonly throttle: Throttle;
}

/** The settings of the case in CI, as the prediction states. */
export const CASE_15_SETTINGS: BurstSettings = {
  floods: 100,
  tornadoes: 2,
  burstAtMs: 2 * MINUTE,
  stepMs: 15_000,
  armMs: 80 * MINUTE,
  quietMs: 20 * MINUTE,
  splitMs: 20 * MINUTE,
  flapMs: 20 * MINUTE,
  firstLifeMs: 5 * MINUTE,
  rollbackMs: 65 * MINUTE,
  waveFloods: 10,
  waveAtMs: 10 * MINUTE,
  limits: DEFAULT_SEND_LIMITS,
  throttle: DEFAULT_THROTTLE,
};

/** This function gives the problems of the settings. A setting with a problem cannot read. */
export function burstSettingsProblems(settings: BurstSettings): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(settings.floods) || settings.floods <= settings.limits.notice) problems.push(`The burst has ${String(settings.floods)} floods, not more than the limit of notice.`);
  if (!Number.isInteger(settings.tornadoes) || settings.tornadoes < 1) problems.push("The burst has no tornado warning.");
  if (!(settings.stepMs > 0 && settings.stepMs < RANK_DELAY)) problems.push("Each step is not shorter than the rank delay, thus the copies cannot read each other before a send of rank 1.");
  if (!(settings.burstAtMs > settings.stepMs)) problems.push("The burst comes before the first read of the copies.");
  if (!(settings.quietMs > 0 && settings.armMs - settings.quietMs > Math.max(settings.splitMs, settings.flapMs, settings.burstAtMs))) problems.push("The quiet tail starts before the end of the faults.");
  if (!(settings.rollbackMs >= settings.firstLifeMs + Math.max(settings.limits.window, settings.throttle.window))) problems.push("The second life starts in the window of the sends of the first life, thus it does not test a full count.");
  if (!(Number.isInteger(settings.waveFloods) && settings.waveFloods >= 1)) problems.push("The rollback arm has no second wave.");
  if (!(settings.waveAtMs > settings.stepMs && settings.waveAtMs < settings.armMs - settings.quietMs)) problems.push("The second wave does not come between the first step and the quiet tail.");
  return problems;
}

/** One send of the fake phone. */
export interface BurstSend {
  readonly copy: BurstCopy;
  readonly at: number;
  readonly incident: string;
  readonly level: Level;
  readonly person: string;
}

/** One hold of the send limit or one suppression of the throttle of a copy. */
export interface BurstHold {
  readonly copy: BurstCopy;
  readonly at: number;
  readonly incident: string;
  readonly level: Level;
  readonly episode: number;
}

/** The record of one arm. */
export interface BurstRecord {
  readonly arm: BurstArm;
  /** The error that stopped the arm. */
  readonly error?: string;
  /** Each send, in time order. */
  readonly sends: readonly BurstSend[];
  /** The sends from this time count for the gates `capped`, `held` and `oneSend`: the start of the second life in `rollback`. */
  readonly countFrom: number;
  readonly holds: readonly BurstHold[];
  /** The ids of the flood statements of the burst, and of the second wave in `rollback`. */
  readonly floods: readonly string[];
  readonly tornadoes: readonly string[];
  /** The system incidents of the flaps of the source, on each copy. */
  readonly flaps: readonly string[];
  /** The stream of the throttle of each report of the copies, by its id. An incident with no stream is in the stream `alerts`. */
  readonly streams: Readonly<Record<string, string>>;
  /** The start of the quiet tail, and the escalations, holds and ends of each copy in it. */
  readonly quietFrom: number;
  readonly quietEvents: number;
  readonly passErrors: readonly string[];
  readonly exchangeProblems: readonly string[];
}

/** The result of one arm. */
export interface BurstResult {
  readonly gates: Partial<Record<BurstGate, boolean>>;
  /** The most incidents with a send in one window of the limit, at each level with a limit. */
  readonly peak: Readonly<Record<"notice" | "urgent", number>>;
  readonly problems: readonly string[];
}

/** The verdict of the case. */
export interface BurstVerdict {
  /** True when the settings are valid, each arm completed with no error, and `one-copy` passed each gate. */
  readonly read: boolean;
  readonly results: Readonly<Record<BurstArm, BurstResult>>;
  readonly pass: boolean;
  readonly problems: readonly string[];
}

/** The records of one start of the case. */
export interface BurstRun {
  readonly id: string;
  readonly settings: BurstSettings;
  readonly records: readonly BurstRecord[];
  readonly verdict: BurstVerdict;
}

/** This function gives the incidents of a level with a send in each window of the limit, at their peak. */
export function peakOf(sends: readonly BurstSend[], level: Level, window: number): number {
  const of = sends.filter((send) => send.level === level).sort((a, b) => a.at - b.at);
  let peak = 0;
  for (const last of of) {
    const people = new Map<string, Set<string>>();
    for (const send of of) {
      if (!(send.at > last.at - window && send.at <= last.at)) continue;
      const set = people.get(send.person) ?? new Set<string>();
      set.add(send.incident);
      people.set(send.person, set);
    }
    for (const set of people.values()) peak = Math.max(peak, set.size);
  }
  return peak;
}

/** This function gives the gates of one record. */
export function burstResultOf(record: BurstRecord, settings: BurstSettings = CASE_15_SETTINGS): BurstResult {
  const problems: string[] = [];
  const counted = record.sends.filter((send) => send.at >= record.countFrom);
  const peak = { notice: peakOf(counted, "notice", settings.limits.window), urgent: peakOf(counted, "urgent", settings.limits.window) };
  const sentIds = new Set(counted.map((send) => send.incident));
  const heldIds = new Set(record.holds.map((hold) => hold.incident));
  const gates: Partial<Record<BurstGate, boolean>> = {};
  for (const gate of ARM_BURST_GATES[record.arm]) {
    switch (gate) {
      case "capped":
        gates.capped = peak.notice <= settings.limits.notice && peak.urgent <= settings.limits.urgent;
        if (!gates.capped) problems.push(`${record.arm}: ${String(peak.notice)} notices and ${String(peak.urgent)} urgent alerts in one window.`);
        break;
      case "held": {
        const lost = record.floods.filter((id) => !sentIds.has(id) && !heldIds.has(id));
        const late = record.holds.filter((hold) => counted.some((send) => send.copy === hold.copy && send.incident === hold.incident && send.level === hold.level && send.at > hold.at));
        gates.held = lost.length === 0 && late.length === 0;
        if (lost.length > 0) problems.push(`${record.arm}: ${String(lost.length)} floods have no send, no hold and no suppression.`);
        if (late.length > 0) problems.push(`${record.arm}: ${String(late.length)} sends came after a hold or a suppression of their copy.`);
        break;
      }
      case "throttled": {
        // The throttle counts each stream on its own (D16). Thus the gate counts the sends of each copy and stream.
        const keyOf = (send: BurstSend): string => `${send.copy} ${record.streams[send.incident] ?? "alerts"}`;
        const keys = [...new Set(counted.map(keyOf))];
        const peaks = keys.map((key) => peakOf(counted.filter((send) => keyOf(send) === key), "notice", settings.throttle.window));
        gates.throttled = peaks.every((peak) => peak <= 1);
        if (!gates.throttled) problems.push(`${record.arm}: a copy sent ${String(Math.max(...peaks))} notices of one stream in one window of the throttle.`);
        break;
      }
      case "lifeSafety": {
        const sent = new Set(record.sends.filter((send) => send.level === "life-safety").map((send) => send.incident));
        gates.lifeSafety = record.tornadoes.every((id) => sent.has(id));
        if (!gates.lifeSafety) problems.push(`${record.arm}: a tornado warning has no send.`);
        break;
      }
      case "settles": {
        const late = record.sends.filter((send) => send.at >= record.quietFrom).length;
        gates.settles = late === 0 && record.quietEvents === 0;
        if (!gates.settles) problems.push(`${record.arm}: ${String(late)} sends and ${String(record.quietEvents)} escalations, holds, suppressions or ends in the quiet tail.`);
        break;
      }
      case "noThrow":
        gates.noThrow = record.passErrors.length === 0 && record.exchangeProblems.length === 0;
        if (!gates.noThrow) problems.push(`${record.arm}: ${[...record.passErrors, ...record.exchangeProblems].slice(0, 3).join(" ")}`);
        break;
      case "oneSend": {
        const copies = new Map<string, Set<BurstCopy>>();
        for (const send of counted) copies.set(send.incident, (copies.get(send.incident) ?? new Set<BurstCopy>()).add(send.copy));
        const both = [...copies.values()].filter((set) => set.size > 1).length;
        gates.oneSend = both === 0;
        if (!gates.oneSend) problems.push(`${record.arm}: ${String(both)} incidents have a send of each copy.`);
        break;
      }
      case "flapped": {
        const lost = record.flaps.filter((id) => !sentIds.has(id) && !heldIds.has(id));
        gates.flapped = record.flaps.length >= 1 && lost.length === 0;
        if (!gates.flapped) problems.push(`${record.arm}: ${String(record.flaps.length)} flap incidents, ${String(lost.length)} with no send, no hold and no suppression.`);
        break;
      }
    }
  }
  return { gates, peak, problems };
}

/** This function gives the verdict of the records of one start. */
export function burstVerdictOf(records: readonly BurstRecord[], settings: BurstSettings = CASE_15_SETTINGS): BurstVerdict {
  const problems = burstSettingsProblems(settings);
  const results = {} as Record<BurstArm, BurstResult>;
  let complete = true;
  for (const arm of BURST_ARMS) {
    const of = records.filter((record) => record.arm === arm);
    const record = of[0];
    if (of.length !== 1 || record === undefined || record.error !== undefined) {
      complete = false;
      problems.push(record?.error === undefined ? `${arm}: ${String(of.length)} records, not 1.` : `${arm}: ${record.error}`);
      const gates: Partial<Record<BurstGate, boolean>> = {};
      for (const gate of ARM_BURST_GATES[arm]) gates[gate] = false;
      results[arm] = { gates, peak: { notice: 0, urgent: 0 }, problems: [] };
      continue;
    }
    results[arm] = burstResultOf(record, settings);
    problems.push(...results[arm].problems);
  }
  const control = Object.values(results["one-copy"].gates).every(Boolean);
  const read = complete && control && burstSettingsProblems(settings).length === 0;
  const pass = read && BURST_ARMS.every((arm) => Object.values(results[arm].gates).every(Boolean));
  return { read, results, pass, problems };
}

/** The id of a flood statement or a tornado warning of the burst. */
export function burstIdOf(key: string, settings: BurstSettings = CASE_15_SETTINGS, start: number = CASE_15_START): string {
  return reportId({ source: BURST_SOURCE, key, sent: start + settings.burstAtMs });
}

/** The time of the second wave of the rollback arm. */
export function waveAtOf(settings: BurstSettings = CASE_15_SETTINGS, start: number = CASE_15_START): number {
  return start + settings.rollbackMs + settings.waveAtMs;
}

/** The id of a flood statement of the second wave of the rollback arm. */
export function waveIdOf(index: number, settings: BurstSettings = CASE_15_SETTINGS, start: number = CASE_15_START): string {
  return reportId({ source: BURST_SOURCE, key: `w${String(index)}`, sent: waveAtOf(settings, start) });
}

function descriptorOf(id: SourceId): SourceDescriptor {
  return {
    id,
    title: `The source ${id}`,
    origins: ["nws"],
    dependsOn: [`provider:${id}`],
    uses: ["internet", "dns", "power"],
    kinds: ["met"],
    coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
    transport: "poll",
    interval: MINUTE,
    slowAfter: 10_000,
    auth: "none",
  };
}

// The made-up reports of the burst for the public place of the fixture. Each report is one incident. The second wave
// has only flood statements.
function burstReportsOf(seen: Observation, sent: number, settings: BurstSettings, wave: boolean): Report[] {
  const report = (key: string): Report => ({
    id: reportId({ source: BURST_SOURCE, key, sent }),
    source: BURST_SOURCE,
    origin: "nws",
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.flood", label: "Flood Statement" },
    categories: ["met"],
    severity: "moderate",
    urgency: "expected",
    certainty: "observed",
    response: ["monitor"],
    sent,
    received: seen.fetched,
    expires: sent + 6 * HOUR,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: BURST_SOURCE,
    headline: `Flood Statement ${key}`,
    observation: seen.id,
    parameters: {},
  });
  const tornadoes = Array.from({ length: settings.tornadoes }, (_, index): Report => ({
    ...report(`t${String(index)}`),
    kind: { code: "met.tornado", label: "Tornado Warning" },
    severity: "extreme",
    urgency: "immediate",
    response: ["shelter"],
    headline: `Tornado Warning t${String(index)}`,
    instruction: "TAKE COVER NOW!",
  }));
  if (wave) return Array.from({ length: settings.waveFloods }, (_, index) => report(`w${String(index)}`));
  return [...tornadoes, ...Array.from({ length: settings.floods }, (_, index) => report(`f${String(index)}`))];
}

// The source of the burst: no observation before the burst, then one observation with each report of the burst. With
// `waveAt`, a second observation from that time has the reports of the second wave.
function burstSourceOf(clock: WallClock, settings: BurstSettings, start: number, waveAt?: number): SourceProcedures {
  const sent = start + settings.burstAtMs;
  const observationOf = (name: string, fetched: number): Observation => ({ id: `${BURST_SOURCE}:${name}` as ObservationId, source: BURST_SOURCE, fetched, contentType: "application/json", body: "{}", transport: { latency: 0 } });
  return {
    describe: () => descriptorOf(BURST_SOURCE),
    fetch: async () => ({
      ok: true,
      observations: [
        ...(clock.now() < sent ? [] : [observationOf("burst", sent)]),
        ...(waveAt === undefined || clock.now() < waveAt ? [] : [observationOf("wave", waveAt)]),
      ],
      complete: true,
    }),
    map: ({ observation }) => {
      const wave = observation.id === `${BURST_SOURCE}:wave`;
      return { reports: burstReportsOf(observation, wave ? observation.fetched : sent, settings, wave), problems: [] };
    },
  };
}

// The source that flaps: fetches 1 and 2 of each 4 fail before the end of the flaps. Two failed fetches make it failing,
// and the next passed fetch makes it healthy again.
function flapSourceOf(clock: WallClock, settings: BurstSettings, start: number): SourceProcedures {
  let fetches = 0;
  return {
    describe: () => descriptorOf(FLAP_SOURCE),
    fetch: async () => {
      const count = fetches;
      fetches += 1;
      if (clock.now() < start + settings.flapMs && (count % 4 === 1 || count % 4 === 2)) return { ok: false, failure: { kind: "server", message: "The case fails this fetch." } };
      return { ok: true, observations: [], complete: true };
    },
    map: () => ({ reports: [], problems: [] }),
  };
}

function phoneOf(copy: BurstCopy, clock: WallClock, sends: BurstSend[]): ChannelProcedures {
  return {
    describe: () => ({ id: PHONE, title: "Phone", dependsOn: [], uses: ["internet", "dns"], breaksThrough: true, repeats: false, ack: "none", maxTitle: 250, maxBody: 1024 }),
    send: async ({ message }) => {
      sends.push({ copy, at: clock.now(), incident: message.incident, level: message.level, person: message.person });
      return { ok: true, receipt: { receipt: `${copy}-${String(sends.length)}` }, accepted: clock.now() };
    },
    status: async () => ({ state: "delivered", at: clock.now() }),
    cancel: async () => {},
  };
}

function recipientOf(subjects: boolean): Recipient {
  const policy = (level: Level): EscalationPolicy => ({ level, steps: [{ channel: PHONE, at: 0 }], exhaustedAfter: 3 * HOUR });
  return {
    watch: { person: PERSON, places: [FIXTURE_PLACE.id], rules: [], ...(subjects ? { subjects: [{ system: SOURCE_SUBJECT }] } : {}) },
    policies: [policy("life-safety"), policy("urgent"), policy("notice")],
    addresses: { phone: { to: "fake-number" } },
  };
}

const VIEW: RuntimeOptions["view"] = { places: [FIXTURE_PLACE], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

interface Checks extends CopyChecks {
  mark(at: number): void;
}

// The watch of the other copy. A read that passed marks it.
function checksOf(other: BurstCopy, since: number): Checks {
  let read: CopyRead | undefined;
  return {
    watches: () => [{ copy: other, skewLimit: CLOCK_SKEW_LIMIT, maxAge: COPY_MAX_AGE, since, ...(read === undefined ? {} : { read }) }],
    shift: () => {},
    ready: async () => {},
    mark: (at) => {
      read = { at, skew: 0, sameConfig: true };
    },
  };
}

interface Copy {
  readonly id: BurstCopy;
  readonly runtime: Runtime;
  readonly log: RuntimeLog;
  readonly checks?: Checks;
}

interface OpenInput {
  readonly id: BurstCopy;
  readonly arm: BurstArm;
  readonly clock: WallClock;
  readonly settings: BurstSettings;
  readonly start: number;
  readonly sends: BurstSend[];
  readonly two: boolean;
  readonly limits: SendLimits;
  readonly throttle?: Throttle | undefined;
  readonly life: number;
  readonly log?: RuntimeLog;
  /** The time of the second wave of the source. */
  readonly waveAt?: number;
}

function openCopy(input: OpenInput): Copy {
  const log = input.log ?? openRuntimeLog(":memory:");
  const own = input.id === "cloud" && input.arm === "imported" ? [] : [burstSourceOf(input.clock, input.settings, input.start, input.waveAt)];
  const sources = input.arm === "flapping" ? [...own, flapSourceOf(input.clock, input.settings, input.start)] : own;
  const checks = input.two ? checksOf(input.id === "home" ? "cloud" : "home", input.clock.now()) : undefined;
  const runtime = openRuntime({
    log,
    clock: input.clock,
    sources,
    watch: () => ({ places: [FIXTURE_PLACE], kinds: ["met"] }),
    view: VIEW,
    run: `run-${input.id}-${String(input.life)}`,
    ...(checks === undefined ? {} : { copy: input.id, copies: checks }),
    delivery: {
      ...DELIVERY_TIMES,
      recipients: [recipientOf(input.arm === "flapping")],
      channels: [phoneOf(input.id, input.clock, input.sends)],
      rank: input.id === "home" ? 0 : 1,
      rankDelay: RANK_DELAY,
      sendLimits: input.limits,
      ...(input.throttle === undefined ? {} : { throttle: input.throttle }),
    },
  });
  return { id: input.id, runtime, log, ...(checks === undefined ? {} : { checks }) };
}

// The read of the pages of `writer` by `reader` until the reader has the head, through JSON as on the wire.
function readAll(reader: Copy, writer: Copy, at: number): string[] {
  const problems: string[] = [];
  for (let page = 0; page < 1000; page += 1) {
    const parsed = parsePage(JSON.parse(JSON.stringify(writer.runtime.share(reader.runtime.position(writer.id)))));
    if (parsed.tag !== "ok") return [...problems, ...parsed.error];
    problems.push(...reader.runtime.take(parsed.value).problems);
    if (parsed.value.items.length === 0 || parsed.value.next >= parsed.value.head) break;
  }
  reader.checks?.mark(at);
  return problems;
}

const QUIET_TYPES: ReadonlySet<RuntimeEvent["type"]> = new Set(["escalation", "hold", "suppressed", "escalation-end"]);

// The holds of the send limit and the suppressions of the throttle of a copy. Each one keeps its incident from a send.
function holdsOf(copy: Copy): BurstHold[] {
  return [...copy.log.read()].flatMap((event) => {
    const hold = event.type === "hold" ? event.hold : event.type === "suppressed" ? event.suppression : undefined;
    return hold === undefined ? [] : [{ copy: copy.id, at: hold.at, incident: hold.incident, level: hold.level, episode: hold.episode }];
  });
}

// The incidents of the flaps: each new report of the failing health of the flap source.
function flapsOf(copy: Copy): string[] {
  return copy.runtime
    .state()
    .merge.reports.filter((report) => report.op === "alert" && report.kind.code === `${HEALTH_KIND}.failing` && report.about.some((about) => about.id === FLAP_SOURCE))
    .map((report) => report.id);
}

// The stream of the throttle of each report of a copy.
function streamsOf(copy: Copy, throttle: Throttle): [string, string][] {
  return copy.runtime.state().merge.reports.map((report) => [report.id, throttleStreamOf(report.kind.code, throttle.streams)]);
}

/** This function runs one arm of the case and gives its record. */
export async function runBurstArm(arm: BurstArm, settings: BurstSettings = CASE_15_SETTINGS): Promise<BurstRecord> {
  const start = CASE_15_START;
  const clock = fakeWallClock(start);
  const sends: BurstSend[] = [];
  const passErrors: string[] = [];
  const exchangeProblems: string[] = [];
  const two = arm !== "one-copy" && arm !== "rollback";
  const waves = arm === "rollback" ? Array.from({ length: settings.waveFloods }, (_, index) => waveIdOf(index, settings, start)) : [];
  const floods = [...Array.from({ length: settings.floods }, (_, index) => burstIdOf(`f${String(index)}`, settings, start)), ...waves];
  const tornadoes = Array.from({ length: settings.tornadoes }, (_, index) => burstIdOf(`t${String(index)}`, settings, start));
  const base = { arm, clock, settings, start, sends, two };
  let copies: Copy[] = [];

  async function steps(until: number, first: number): Promise<void> {
    while (clock.now() <= until) {
      for (const copy of copies) {
        try {
          await copy.runtime.pass();
        } catch (error) {
          passErrors.push(`${copy.id} at ${String(clock.now() - start)} ms: ${errorMessage(error)}`);
        }
      }
      const [home, cloud] = copies;
      const up = arm !== "split" || clock.now() - first >= settings.splitMs;
      if (home !== undefined && cloud !== undefined && up) {
        exchangeProblems.push(...readAll(home, cloud, clock.now()), ...readAll(cloud, home, clock.now()));
      }
      await clock.advance(settings.stepMs);
    }
  }

  try {
    let countFrom = start;
    let end = start + settings.armMs;
    if (arm === "rollback") {
      // The first life: an older build with no limit.
      const log = openRuntimeLog(":memory:");
      const unlimited: SendLimits = { window: settings.limits.window, notice: 10_000, urgent: 10_000 };
      copies = [openCopy({ ...base, id: "home", limits: unlimited, life: 1, log })];
      await steps(start + settings.firstLifeMs, start);
      await copies[0]?.runtime.close();
      // A newer build ended episode 0 of each notice escalation. The older build that opens the log next opens episode 1.
      const endAt = clock.now();
      const ended = [...new Set(sends.filter((send) => send.level === "notice").map((send) => send.incident))];
      log.appendAll(
        ended.map((incident) => ({ ...envelope("escalation-end", `escalation-end:${incident}:${PERSON}:0`, endAt), end: { incident: incident as Report["id"], person: PERSON, at: endAt } })),
        () => {},
      );
      // The second life with the limit.
      await clock.advance(start + settings.rollbackMs - clock.now());
      countFrom = clock.now();
      end = countFrom + settings.armMs;
      copies = [openCopy({ ...base, id: "home", limits: settings.limits, throttle: settings.throttle, life: 2, log, waveAt: waveAtOf(settings, start) })];
      await steps(end, countFrom);
    } else {
      copies = two
        ? [openCopy({ ...base, id: "home", limits: settings.limits, throttle: settings.throttle, life: 1 }), openCopy({ ...base, id: "cloud", limits: settings.limits, throttle: settings.throttle, life: 1 })]
        : [openCopy({ ...base, id: "home", limits: settings.limits, throttle: settings.throttle, life: 1 })];
      await steps(end, start);
    }
    const quietFrom = end - settings.quietMs;
    const quietEvents = copies.reduce((sum, copy) => sum + [...copy.log.read()].filter((event) => QUIET_TYPES.has(event.type) && event.time >= quietFrom).length, 0);
    const record: BurstRecord = {
      arm,
      sends: [...sends],
      countFrom,
      holds: copies.flatMap(holdsOf),
      floods,
      tornadoes,
      flaps: copies.flatMap(flapsOf),
      streams: Object.fromEntries(copies.flatMap((copy) => streamsOf(copy, settings.throttle))),
      quietFrom,
      quietEvents,
      passErrors,
      exchangeProblems,
    };
    for (const copy of copies) await copy.runtime.close();
    for (const copy of copies) copy.log.close();
    return record;
  } catch (error) {
    return { arm, error: errorMessage(error), sends, countFrom: start, holds: [], floods, tornadoes, flaps: [], streams: {}, quietFrom: start, quietEvents: 0, passErrors, exchangeProblems };
  }
}

/** This function runs each arm of the case, one after the other, and gives the records and the verdict. */
export async function runSendBurst(settings: BurstSettings = CASE_15_SETTINGS): Promise<BurstRun> {
  const records: BurstRecord[] = [];
  for (const arm of BURST_ARMS) records.push(await runBurstArm(arm, settings));
  return { id: CASE_15_ID, settings, records, verdict: burstVerdictOf(records, settings) };
}
