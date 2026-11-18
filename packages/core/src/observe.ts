/**
 * The observe mode of a new source (AL-73). A new source can make a burst of alerts at its start, for example from an
 * area that is too large. Thus a new source starts in the observe mode. Its incidents stay in the merge, the map and the
 * log, but they start no escalation and no digest entry below `life-safety` (`observeCut`).
 *
 * The verdict (`observeVerdict`) replays the last day of a source. For each person, it counts the incidents of the
 * source that reach the person at each level. The source goes live when the observed time is long enough, and no person
 * passes a cap in that day. Thus a source with a burst goes live one day after the burst, when no new burst comes. The caps are the send limit of each person (`send-limit.ts`) times the share of this copy.
 * Thus a split of the copies does not let a new source pass on a double count.
 *
 * The functions are pure folds over the merge state and the time. They read no clock.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import { assess, reachedAssessment } from "./assess.ts";
import type { AssessedLevel, AssessPolicy, Duration, Incident, Instant, MergeState, PersonId, PersonWatch, ReportId, SourceId, WatchedPlace } from "./contracts.ts";
import { DEFAULT_SEND_LIMITS, LIMITED_LEVELS, type LimitedLevel, type SendLimits } from "./send-limit.ts";

const HOUR = 3_600_000;

/**
 * The shortest observed time of a new source: one day. A day holds the daily cycle of most feeds, for example the peaks
 * of a transit network and the daily products of a forecast office.
 */
export const OBSERVE_WINDOW: Duration = 24 * HOUR;

/**
 * The most digest entries of one new source for one person in one day: 20. The digest tells each entry in one message.
 * More entries from one new source fill the digest, and they tell of a wrong map more often than of a real event.
 */
export const OBSERVE_DIGEST_PER_DAY = 20;

/** The input of `observeCut`. */
export interface ObserveCutInput {
  /** The incidents of the merge state at `at`. */
  readonly incidents: readonly Incident[];
  readonly state: MergeState;
  /** The sources in the observe mode. A source that this copy does not operate is not in the set, thus it counts as live. */
  readonly observing: ReadonlySet<SourceId>;
  /**
   * The reports of the incidents with an escalation start or a hold of the send limit. A send in flight has a start and no
   * delivery. The cut does not hold these incidents, because the phone can have the message.
   */
  readonly started?: ReadonlySet<ReportId>;
  readonly people: readonly PersonWatch[];
  readonly places: readonly WatchedPlace[];
  readonly assess?: AssessPolicy;
  readonly at: Instant;
}

/** The result of `observeCut`. */
export interface ObserveCut {
  /** The incidents that go to the route and to the digest, in their order. */
  readonly sent: readonly Incident[];
  /** The incidents that the observe mode holds. */
  readonly held: readonly Incident[];
  /**
   * The incidents of observing sources only that go on, because they reach a person at `life-safety`. Each one needs a note to
   * the operator. An incident stays in the list after its send, while it reaches a person at `life-safety`.
   */
  readonly lifeSafety: readonly Incident[];
}

/** This function gives the reports of an incident: its anchor and each other report. */
const reportsOf = (incident: Incident): readonly ReportId[] => [incident.anchor, ...incident.reports];

/**
 * This function divides the incidents for the route and the digest. The observe mode holds an incident when each of its
 * reports comes from a source in the observe mode. These incidents go on:
 *
 * - An incident with a report of a live source, of a source that this copy does not operate, or that the state does not have.
 * - An incident that reaches a person at `life-safety`. A missed real warning is worse than a wrong one. The incident goes to
 *   the route for each person, and the send limit holds the lower levels. The operator gets a note of it (`lifeSafety`).
 * - An incident with a delivery, an escalation start or a hold, for example a `life-safety` incident that went to a lower
 *   level. The route continues or ends its escalation.
 */
export function observeCut(input: ObserveCutInput): ObserveCut {
  if (input.observing.size === 0) return { sent: input.incidents, held: [], lifeSafety: [] };
  const sourceOf = new Map(input.state.reports.map((report) => [report.id as string, report.source]));
  const delivered = new Set<string>(input.state.deliveries.map((delivery) => delivery.incident));
  const sent: Incident[] = [];
  const held: Incident[] = [];
  const lifeSafety: Incident[] = [];
  for (const incident of input.incidents) {
    const ids = reportsOf(incident);
    const observed = ids.every((id) => {
      const source = sourceOf.get(id);
      return source !== undefined && input.observing.has(source);
    });
    if (!observed) {
      sent.push(incident);
      continue;
    }
    const levels = incident.live ? input.people.map((person) => levelOf(incident, person, input.places, input.assess, input.at)) : [];
    if (levels.includes("life-safety")) {
      sent.push(incident);
      lifeSafety.push(incident);
    } else if (ids.some((id) => delivered.has(id) || input.started?.has(id) === true)) {
      sent.push(incident);
    } else {
      held.push(incident);
    }
  }
  return { sent, held, lifeSafety };
}

/** This function gives the level of an incident that reaches a person at a time. */
function levelOf(incident: Incident, person: PersonWatch, places: readonly WatchedPlace[], policy: AssessPolicy | undefined, at: Instant): AssessedLevel {
  return reachedAssessment(assess(incident, person, places, policy, at)).level;
}

/** One condition of the observe mode, for the system reports. */
export interface ObserveCondition {
  readonly source: SourceId;
  /**
   * The state of the condition:
   *
   * - `held`: the source has its full observed time, and its verdict fails. The source stays in the observe mode.
   * - `life-safety`: incidents of observing sources only reached a person at `life-safety`, and they went on.
   */
  readonly state: "held" | "life-safety";
  /** The start of the observe mode of the source. */
  readonly since: Instant;
  /** The reason of the verdict, or the empty text. */
  readonly reason: string;
  /** The anchors of the incidents at `life-safety`, sorted. A `held` condition has none. */
  readonly incidents: readonly ReportId[];
}

/**
 * This function gives the conditions of the observe mode, in the order of the sources and then of the states.
 *
 * - Each verdict that does not pass with its full observed time gives a `held` condition.
 * - Each source of an incident in `lifeSafety` (`observeCut`) gives a `life-safety` condition. Thus the operator sees
 *   a wrong map in its first hour, and not after one day.
 *
 * @param since - The start of the observe mode of each source.
 */
export function observeConditions(verdicts: readonly ObserveVerdict[], lifeSafety: readonly Incident[], state: MergeState, since: ReadonlyMap<SourceId, Instant>): ObserveCondition[] {
  const conditions: ObserveCondition[] = [];
  for (const verdict of verdicts) {
    if (!verdict.pass && verdict.at - verdict.since >= verdict.window) conditions.push({ source: verdict.source, state: "held", since: verdict.since, reason: verdict.reason, incidents: [] });
  }
  const sourceOf = new Map(state.reports.map((report) => [report.id as string, report.source]));
  const anchors = new Map<SourceId, Set<ReportId>>();
  for (const incident of lifeSafety) {
    for (const id of reportsOf(incident)) {
      const source = sourceOf.get(id);
      if (source === undefined) continue;
      const set = anchors.get(source) ?? new Set<ReportId>();
      set.add(incident.anchor);
      anchors.set(source, set);
    }
  }
  for (const [source, set] of anchors) {
    conditions.push({ source, state: "life-safety", since: since.get(source) ?? Number.NEGATIVE_INFINITY, reason: "", incidents: [...set].sort(compareCodeUnits) });
  }
  return conditions.sort((a, b) => compareCodeUnits(a.source, b.source) || compareCodeUnits(a.state, b.state));
}

/** The input of `observeVerdict`. */
export interface ObserveVerdictInput {
  readonly source: SourceId;
  /** The start of the observe mode of the source. */
  readonly since: Instant;
  readonly at: Instant;
  readonly state: MergeState;
  /** The incidents of the merge state at `at`, for example the incidents of the view. */
  readonly incidents: readonly Incident[];
  readonly people: readonly PersonWatch[];
  readonly places: readonly WatchedPlace[];
  readonly assess?: AssessPolicy;
  /** The send limit of each person (`sendLimitsOf` of the configuration). The default is `DEFAULT_SEND_LIMITS`. */
  readonly limits?: SendLimits;
  /** The share of the send limit for this copy (`limitShare`), above 0 and at most 1. The default is 1. */
  readonly share?: number;
  /** The shortest observed time, and the time that the verdict counts. The default is `OBSERVE_WINDOW`. */
  readonly window?: Duration;
}

/** The counts of one person in the verdict of a source. */
export interface ObservedPerson {
  readonly person: PersonId;
  /** The incidents of the source that reach the person at a level. */
  readonly matched: number;
  /** The matched incidents over each incident of the source, from 0 to 1. It is 0 when the source has no incident. */
  readonly share: number;
  /** The most new incidents of each limited level in one window of the send limit. */
  readonly worst: Readonly<Record<LimitedLevel, number>>;
  /** The incidents at `life-safety`. They have no cap. */
  readonly lifeSafety: number;
  /** The most digest entries in one day. */
  readonly digestDay: number;
  /** One text for each cap that the person passes, in plain words with the numbers: "9 notices in 1 hour, limit 6". */
  readonly over: readonly string[];
}

/** The verdict of the observe mode of one source. */
export interface ObserveVerdict {
  readonly source: SourceId;
  readonly since: Instant;
  readonly at: Instant;
  /** The observed time in hours, from `since`. */
  readonly hours: number;
  /** The start of the counted time: the start of the last window, or `since` when it is later. */
  readonly from: Instant;
  /** The incidents with a report of the source in the counted time. */
  readonly incidents: number;
  /** The incidents in each hour of the counted time, over one hour at least. */
  readonly perHour: number;
  /** The cap of each limited level in one window: the send limit times the share, and 1 at least. */
  readonly caps: Readonly<Record<LimitedLevel, number>>;
  /** The window of the caps: the window of the send limit. */
  readonly capWindow: Duration;
  /** The shortest observed time of the verdict. */
  readonly window: Duration;
  readonly people: readonly ObservedPerson[];
  /** True when the observed time is long enough and no person passes a cap. */
  readonly pass: boolean;
  /**
   * The reason of the verdict in plain words with the numbers. A person has the number of its place in `people`, and no
   * id: "person 1: 9 notices in 1 hour, limit 6".
   */
  readonly reason: string;
}

/** This function gives a duration in plain words: "1 hour", "2 hours" or "30 minutes". */
export function durationText(length: Duration): string {
  const hours = length / HOUR;
  if (Number.isInteger(hours)) return `${String(hours)} ${hours === 1 ? "hour" : "hours"}`;
  const minutes = Math.round(length / 60_000);
  return `${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** The plain word of the incidents of each limited level. */
const LEVEL_WORDS: Readonly<Record<LimitedLevel, readonly [string, string]>> = { notice: ["notice", "notices"], urgent: ["urgent alert", "urgent alerts"] };

/** This function gives the most times in one window of a length. The window holds its start and not its end. */
export function mostInWindow(times: readonly Instant[], length: Duration): number {
  const sorted = [...times].sort((a, b) => a - b);
  let most = 0;
  let first = 0;
  for (let last = 0; last < sorted.length; last += 1) {
    while (sorted[last]! - sorted[first]! >= length) first += 1;
    most = Math.max(most, last - first + 1);
  }
  return most;
}

/**
 * This function gives the verdict of the observe mode of a source at `at`. It replays each incident with a report of the
 * source from the counted time. The counted time is the last window before `at`, and it starts at `since` or later.
 *
 * - The time of an incident is the earliest receipt of a report of the source in it. The level of a person is the
 *   assessment of the incident at that time.
 * - For each limited level, the most incidents of a person in one window of the send limit is at most the cap of the level.
 * - The most digest entries of a person in one day is at most `OBSERVE_DIGEST_PER_DAY`.
 * - The source passes when the observed time is `window` or more, and no person passes a cap.
 */
export function observeVerdict(input: ObserveVerdictInput): ObserveVerdict {
  const limits = input.limits ?? DEFAULT_SEND_LIMITS;
  const share = input.share ?? 1;
  const window = input.window ?? OBSERVE_WINDOW;
  const caps = { notice: Math.max(1, Math.floor(limits.notice * share)), urgent: Math.max(1, Math.floor(limits.urgent * share)) };
  const from = Math.max(input.since, input.at - window);
  const received = new Map<string, Instant>();
  for (const report of input.state.reports) {
    if (report.source === input.source && report.received >= from && report.received <= input.at) received.set(report.id, report.received);
  }
  const timed: { readonly incident: Incident; readonly at: Instant }[] = [];
  for (const incident of input.incidents) {
    const times = reportsOf(incident).flatMap((id) => {
      const at = received.get(id);
      return at === undefined ? [] : [at];
    });
    if (times.length > 0) timed.push({ incident, at: Math.min(...times) });
  }
  const people = input.people.map((person): ObservedPerson => {
    const at: Record<AssessedLevel, Instant[]> = { none: [], digest: [], notice: [], urgent: [], "life-safety": [] };
    for (const item of timed) at[levelOf(item.incident, person, input.places, input.assess, item.at)].push(item.at);
    const worst = { notice: mostInWindow(at.notice, limits.window), urgent: mostInWindow(at.urgent, limits.window) };
    const digestDay = mostInWindow(at.digest, 24 * HOUR);
    const over = [
      ...LIMITED_LEVELS.filter((level) => worst[level] > caps[level]).map(
        (level) => `${String(worst[level])} ${LEVEL_WORDS[level][worst[level] === 1 ? 0 : 1]} in ${durationText(limits.window)}, limit ${String(caps[level])}`,
      ),
      ...(digestDay > OBSERVE_DIGEST_PER_DAY ? [`${String(digestDay)} digest entries in 1 day, limit ${String(OBSERVE_DIGEST_PER_DAY)}`] : []),
    ];
    const matched = timed.length - at.none.length;
    return { person: person.person, matched, share: timed.length === 0 ? 0 : matched / timed.length, worst, lifeSafety: at["life-safety"].length, digestDay, over };
  });
  const hours = (input.at - input.since) / HOUR;
  const long = input.at - input.since >= window;
  const counted = (input.at - from) / HOUR;
  const over = people.flatMap((person, index) => person.over.map((text) => `person ${String(index + 1)}: ${text}`));
  const observed = `${hours.toFixed(1)} of ${durationText(window)} observed`;
  const reason = over.length > 0 ? [...over, ...(long ? [] : [observed])].join("; ") : long ? `${hours.toFixed(1)} hours observed, no person over a limit` : observed;
  return {
    source: input.source,
    since: input.since,
    at: input.at,
    hours,
    from,
    incidents: timed.length,
    perHour: timed.length / Math.max(counted, 1),
    caps,
    capWindow: limits.window,
    window,
    people,
    pass: long && over.length === 0,
    reason,
  };
}
