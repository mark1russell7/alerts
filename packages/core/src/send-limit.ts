/**
 * This module holds the send limit of each person (AL-72). It is pure. The limit keeps a burst of new incidents away
 * from the phone of a person. Each level below `life-safety` admits a count of new escalations in each window, over all
 * the copies of the system. The digest tells each incident that the limit held. The private incidents (AL-92) have their own
 * places, thus the messages of the operator and the alerts do not take places from each other.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import { isPrivate } from "./audience.ts";
import type { CopyWatch, Delivery, Duration, Instant, Level, PersonId, Report } from "./contracts.ts";
import type { EscalationHold, Route } from "./delivery.ts";
import { messageKey } from "./ids.ts";
import { copyStages } from "./system-reports.ts";

/** The levels with a send limit. A `life-safety` escalation has no limit, and the level `digest` has no escalation. */
export type LimitedLevel = "notice" | "urgent";

/** The levels with a send limit, from the lowest level up. */
export const LIMITED_LEVELS: readonly LimitedLevel[] = ["notice", "urgent"];

/** The send limit of each person: the most new escalations of each level in one window, over all the copies. */
export interface SendLimits {
  /** The length of the window. */
  readonly window: Duration;
  /** The most new escalations of the level `notice` of one person in one window. */
  readonly notice: number;
  /** The most new escalations of the level `urgent` of one person in one window. */
  readonly urgent: number;
}

/** The part of the configuration that changes the send limit. Each field that is absent keeps its default. */
export type SendLimitConfig = Partial<SendLimits>;

/**
 * The default send limit: 6 notices and 12 urgent escalations in one hour. From 2026-11-16 to 2026-11-18, before the
 * burst of AL-72, the busiest hour of one person had 4 notices and 8 urgent messages. The limit adds 50 percent.
 */
export const DEFAULT_SEND_LIMITS: SendLimits = { window: 3_600_000, notice: 6, urgent: 12 };

/** The shortest window of a send limit: one minute. */
export const SEND_LIMIT_MIN_WINDOW: Duration = 60_000;

/** The longest window of a send limit: one day. */
export const SEND_LIMIT_MAX_WINDOW: Duration = 86_400_000;

/** This function gives the send limit of a configuration. Each field that is absent has its default. */
export function sendLimitsOf(config: SendLimitConfig | undefined): SendLimits {
  return { ...DEFAULT_SEND_LIMITS, ...config };
}

/**
 * This function gives the problems of the send limit of a configuration. The window is one minute to one day. Each
 * count is an integer of 1 or more.
 */
export function sendLimitProblems(config: SendLimitConfig): string[] {
  const problems: string[] = [];
  const { window } = config;
  if (window !== undefined && !(Number.isInteger(window) && window >= SEND_LIMIT_MIN_WINDOW && window <= SEND_LIMIT_MAX_WINDOW)) {
    problems.push(`The window of the send limit is ${String(window)} ms. It must be an integer from ${SEND_LIMIT_MIN_WINDOW} to ${SEND_LIMIT_MAX_WINDOW} ms.`);
  }
  for (const level of LIMITED_LEVELS) {
    const count = config[level];
    if (count !== undefined && !(Number.isInteger(count) && count >= 1)) problems.push(`The send limit of the level ${level} is ${String(count)}. It must be an integer of 1 or more.`);
  }
  return problems;
}

/** This function tells if a level has a send limit. */
export function isLimitedLevel(level: Level): level is LimitedLevel {
  return (LIMITED_LEVELS as readonly Level[]).includes(level);
}

/**
 * This function gives the share of the send limit for this copy at `at`. This copy does not see the sends of a copy
 * that it cannot read. That copy does not see the sends of this copy. Thus each of them takes one share: 1 divided by
 * 1 plus the count of these copies. With each other copy read, the share is 1.
 *
 * - A copy in the stage `unread` counts.
 * - A copy with no read from the start of its watch also counts. Thus two copies that start in a split send one limit together.
 */
export function limitShare(watches: readonly CopyWatch[], at: Instant): number {
  return 1 / (1 + watches.filter((watch) => watch.read === undefined || copyStages(watch, at).includes("unread")).length);
}

/** This function gives the key of a hold: one hold for each escalation and episode. */
export function holdKey(hold: Pick<EscalationHold, "incident" | "level" | "person" | "episode">): string {
  return `${hold.incident}:${hold.level}:${hold.person}:${String(hold.episode)}`;
}

/** The input of `limitRoutes`. */
export interface LimitInput {
  /** The routes at `now` (`route`). */
  readonly routes: readonly Route[];
  /** The deliveries of the ledger: the deliveries of this copy and the deliveries of the other copies. */
  readonly deliveries: readonly Delivery[];
  /** The holds of the log. */
  readonly holds: readonly EscalationHold[];
  /** The send limit. The default is `DEFAULT_SEND_LIMITS`. */
  readonly limits?: SendLimits | undefined;
  /** The share of the limit for this copy (`limitShare`), above 0 and at most 1. The default is 1. */
  readonly share?: number | undefined;
  /**
   * The delivery keys of the sends that this copy started and that have no end yet: a send in flight, or an open copy.
   * A route with one of these sends keeps its place. The default is no key.
   */
  readonly started?: ReadonlySet<string> | undefined;
  /**
   * The reports of the merge state (`MergeState.reports`). A delivery of a private report counts only in the private
   * places of its person and level. The default is no report: then only the routes tell the private incidents.
   */
  readonly reports?: readonly Pick<Report, "id" | "addresses">[] | undefined;
  readonly now: Instant;
}

/** The result of `limitRoutes`. */
export interface LimitResult {
  /** The routes in the same order. A held route has no send in its plan, and it has the hold (`Route.held`). */
  readonly routes: readonly Route[];
  /** The new holds at `now`, in the order of the routes. The runtime writes them to its log. */
  readonly holds: readonly EscalationHold[];
}

/**
 * This function applies the send limit of each person to the routes.
 *
 * - A route of `life-safety` has no limit. It does not change.
 * - A route with a hold in the log is held. The hold does not end in its episode.
 * - A route with a delivery in its episode is admitted. Its later steps go with no limit, thus the repeats of an
 *   alert are not cut.
 * - A route with a send and no delivery is new. Each person and each level has a count of places. The count is the
 *   limit times the share, less the incidents with a delivery of the level in the window. The deliveries of the
 *   other copies count, thus the limit applies over all the copies. The places of the share are at least 1, thus each
 *   copy that runs alone still sends.
 * - Each delivery in the window counts, not only the first delivery of the incident. Thus a new episode of an old
 *   incident counts after its send, and the window cannot hold more than the limit.
 * - The new routes get places in the order of their first due time, then of the anchor, then of the episode. A new
 *   route with no place gets a hold at `now`.
 * - A send in flight or a refused send has no delivery yet. Its route stays new, and it keeps its place, because its
 *   first due time is early. Thus the count of the admitted escalations does not pass the limit over many passes.
 * - A route with a started send (`started`) gets a place before each other new route, and it does not get a hold. The
 *   phone can already have its message. Thus a new route with an earlier due time cannot take its place.
 * - A held route has no send in its plan. Its cancels stay.
 * - A private incident (`addresses`, AL-92) has its own places for each person and level, with the same counts. Only the
 *   deliveries of the private reports count in them. Thus a burst of messages of the operator does not hold an alert.
 *   Also, a busy hour of alerts does not hold a message of the operator.
 */
export function limitRoutes(input: LimitInput): LimitResult {
  const limits = input.limits ?? DEFAULT_SEND_LIMITS;
  const share = input.share !== undefined && input.share > 0 && input.share <= 1 ? input.share : 1;
  const logged = new Map(input.holds.map((hold) => [holdKey(hold), hold]));
  // The ids of the private reports: of the reports of the merge state, and of the incidents of the routes. A delivery holds
  // the anchor of its incident at the time of its send. The anchor is one of the reports, thus the set finds it also after
  // a change of the anchor.
  const secret = new Set<string>();
  for (const report of input.reports ?? []) if (isPrivate(report)) secret.add(report.id);
  for (const entry of input.routes) if (isPrivate(entry.incident)) for (const id of [entry.incident.anchor, ...entry.incident.reports]) secret.add(id);
  const groupOf = (person: PersonId, level: Level, only: boolean): string => `${level} ${person}${only ? " private" : ""}`;
  // The incidents of each person at each level with a limit that have a delivery in the window. An incident counts one
  // time, also with many steps or episodes. A time that is not a number is in no window. Two reports of one merged
  // incident can count two times, thus the limit can hold an escalation early, never late.
  const counted = new Set<string>();
  const used = new Map<string, number>();
  for (const delivery of input.deliveries) {
    if (!isLimitedLevel(delivery.level) || !(delivery.at > input.now - limits.window && delivery.at <= input.now)) continue;
    const group = groupOf(delivery.person, delivery.level, secret.has(delivery.incident));
    const key = `${group} ${delivery.incident}`;
    if (counted.has(key)) continue;
    counted.add(key);
    used.set(group, (used.get(group) ?? 0) + 1);
  }

  // The new routes of each person and level.
  const fresh = new Map<string, { readonly index: number; readonly due: Instant; readonly started: boolean }[]>();
  const held = new Map<number, EscalationHold>();
  input.routes.forEach((entry, index) => {
    const level = entry.policy.level;
    if (!isLimitedLevel(level)) return;
    const hold = logged.get(holdKey({ incident: entry.start.incident, level, person: entry.person, episode: entry.episode }));
    if (hold !== undefined) {
      held.set(index, hold);
      return;
    }
    if (entry.deliveries.length > 0 || entry.plan.sends.length === 0) return;
    const group = groupOf(entry.person, level, isPrivate(entry.incident));
    const due = Math.min(...entry.plan.sends.map((send) => send.due));
    const started = input.started !== undefined && entry.plan.sends.some((send) => input.started?.has(messageKey(send)) === true);
    fresh.set(group, [...(fresh.get(group) ?? []), { index, due, started }]);
  });
  const added: { readonly index: number; readonly hold: EscalationHold }[] = [];
  for (const [group, entries] of fresh) {
    const level = group.slice(0, group.indexOf(" ")) as LimitedLevel;
    const places = Math.max(0, Math.max(1, Math.floor(limits[level] * share)) - (used.get(group) ?? 0));
    // The routes with a started send take their places first. They do not get a hold, also past the limit.
    const begun = entries.filter((item) => item.started).length;
    const ordered = entries
      .filter((item) => !item.started)
      .sort((a, b) => {
        const left = input.routes[a.index]!;
        const right = input.routes[b.index]!;
        return a.due - b.due || compareCodeUnits(left.start.incident, right.start.incident) || left.episode - right.episode;
      });
    for (const { index } of ordered.slice(Math.max(0, places - begun))) {
      const entry = input.routes[index]!;
      const hold: EscalationHold = { incident: entry.start.incident, level, person: entry.person, episode: entry.episode, at: input.now };
      held.set(index, hold);
      added.push({ index, hold });
    }
  }
  if (held.size === 0) return { routes: input.routes, holds: [] };
  return {
    routes: input.routes.map((entry, index) => {
      const hold = held.get(index);
      return hold === undefined ? entry : { ...entry, plan: { ...entry.plan, sends: [] }, held: hold };
    }),
    holds: added.sort((a, b) => a.index - b.index).map(({ hold }) => hold),
  };
}
