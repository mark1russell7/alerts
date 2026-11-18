/**
 * This module holds the send limit of each person (AL-72). It is pure. The limit keeps a burst of new incidents away
 * from the phone of a person. Each level below `life-safety` admits a count of new escalations in each window, over all
 * the copies of the system. The digest tells each incident that the limit held.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { CopyWatch, Delivery, Duration, Instant, Level, PersonId } from "./contracts.ts";
import type { EscalationHold, Route } from "./delivery.ts";
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
 *   limit times the share, less the incidents whose first delivery of the level is in the window. The deliveries of the
 *   other copies count, thus the limit applies over all the copies. The places of the share are at least 1, thus each
 *   copy that runs alone still sends.
 * - The new routes get places in the order of their first due time, then of the anchor, then of the episode. A new
 *   route with no place gets a hold at `now`.
 * - A send in flight or a refused send has no delivery yet. Its route stays new, and it keeps its place, because its
 *   first due time is early. Thus the count of the admitted escalations does not pass the limit over many passes.
 * - A held route has no send in its plan. Its cancels stay.
 */
export function limitRoutes(input: LimitInput): LimitResult {
  const limits = input.limits ?? DEFAULT_SEND_LIMITS;
  const share = input.share !== undefined && input.share > 0 && input.share <= 1 ? input.share : 1;
  const logged = new Map(input.holds.map((hold) => [holdKey(hold), hold]));
  const groupOf = (person: PersonId, level: Level): string => `${level} ${person}`;
  // The first delivery of each incident to each person at each level with a limit. Two reports of one merged incident
  // can count two times, thus the limit can hold an escalation early, never late.
  const firsts = new Map<string, { readonly group: string; readonly at: Instant }>();
  for (const delivery of input.deliveries) {
    if (!isLimitedLevel(delivery.level) || !Number.isFinite(delivery.at)) continue;
    const group = groupOf(delivery.person, delivery.level);
    const key = `${group} ${delivery.incident}`;
    const known = firsts.get(key);
    if (known === undefined || delivery.at < known.at) firsts.set(key, { group, at: delivery.at });
  }
  const used = new Map<string, number>();
  for (const { group, at } of firsts.values()) if (at > input.now - limits.window && at <= input.now) used.set(group, (used.get(group) ?? 0) + 1);

  // The new routes of each person and level.
  const fresh = new Map<string, { readonly index: number; readonly due: Instant }[]>();
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
    const group = groupOf(entry.person, level);
    const due = Math.min(...entry.plan.sends.map((send) => send.due));
    fresh.set(group, [...(fresh.get(group) ?? []), { index, due }]);
  });
  const added: { readonly index: number; readonly hold: EscalationHold }[] = [];
  for (const [group, entries] of fresh) {
    const level = group.slice(0, group.indexOf(" ")) as LimitedLevel;
    const places = Math.max(0, Math.max(1, Math.floor(limits[level] * share)) - (used.get(group) ?? 0));
    const ordered = [...entries].sort((a, b) => {
      const left = input.routes[a.index]!;
      const right = input.routes[b.index]!;
      return a.due - b.due || compareCodeUnits(left.start.incident, right.start.incident) || left.episode - right.episode;
    });
    for (const { index } of ordered.slice(places)) {
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
