/**
 * This module holds the rise-only throttle of each person and channel (AL-72 part 4). It is pure. In one window, a
 * channel sends a second message to a person only when the level is above each level that the channel already sent to
 * the person in the window. A send of the same level or of a lower level does not go. The log keeps it as a suppression
 * with its reason, and the digest tells its incident.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import { LEVELS, type ChannelId, type Delivery, type Duration, type Instant, type Level, type PersonId, type ReportId } from "./contracts.ts";
import type { Route } from "./delivery.ts";
import type { EscalationSend } from "./escalation.ts";
import { messageKey } from "./ids.ts";

/**
 * The key of the window of the throttle.
 *
 * - `channel`: one window for each person and channel. A new incident of the same level does not go.
 * - `incident`: one window for each person, channel and incident. Only the repeats of one incident do not go.
 */
export type ThrottleKey = "channel" | "incident";

/** The keys of the window of the throttle. */
export const THROTTLE_KEYS: readonly ThrottleKey[] = ["channel", "incident"];

/** The rise-only throttle of each person and channel. */
export interface Throttle {
  /** The length of the window. */
  readonly window: Duration;
  /** The key of the window. */
  readonly key: ThrottleKey;
  /** The levels that the throttle does not stop. Their sends always go, and they count in the window of the other levels. */
  readonly exempt: readonly Level[];
}

/** The part of the configuration that changes the throttle. Each field that is absent keeps its default. */
export type ThrottleConfig = Partial<Throttle>;

/**
 * The default throttle: a window of 30 minutes for each person and channel. A `life-safety` send always goes.
 *
 * The window comes from a replay of the burst of 2026-11-18 (`fixtures/burst-2026-11-18.json`, with made-up ids). The
 * burst gave 171 messages to one person on one channel in 22 minutes, in two waves 9 minutes apart. With a window of 15
 * minutes or more, the replay gives 2 messages: the first notice, and the first urgent message. On 2026-11-16 and 2026-11-17, the shortest time
 * between two messages that did not come at the same time was 32 minutes. A window of 32 minutes or less stops none of
 * them. The default is 30 minutes, in this range.
 */
export const DEFAULT_THROTTLE: Throttle = { window: 1_800_000, key: "channel", exempt: ["life-safety"] };

/** The shortest window of the throttle: one minute. */
export const THROTTLE_MIN_WINDOW: Duration = 60_000;

/** The longest window of the throttle: one day. */
export const THROTTLE_MAX_WINDOW: Duration = 86_400_000;

/** This function gives the throttle of a configuration. Each field that is absent has its default. */
export function throttleOf(config: ThrottleConfig | undefined): Throttle {
  return { ...DEFAULT_THROTTLE, ...config };
}

/** This function gives the problems of the throttle of a configuration. The window is one minute to one day. */
export function throttleProblems(config: ThrottleConfig): string[] {
  const problems: string[] = [];
  const { window } = config;
  if (window !== undefined && !(Number.isInteger(window) && window >= THROTTLE_MIN_WINDOW && window <= THROTTLE_MAX_WINDOW)) {
    problems.push(`The window of the throttle is ${String(window)} ms. It must be an integer from ${THROTTLE_MIN_WINDOW} to ${THROTTLE_MAX_WINDOW} ms.`);
  }
  if (config.key !== undefined && !THROTTLE_KEYS.includes(config.key)) problems.push(`The key of the throttle is ${String(config.key)}. It must be one of: ${THROTTLE_KEYS.join(", ")}.`);
  for (const level of config.exempt ?? []) {
    if (!LEVELS.includes(level) || level === "digest") problems.push(`The throttle cannot exempt the level ${String(level)}. A level with an exemption is notice, urgent or life-safety.`);
  }
  return problems;
}

/**
 * The reason of a suppression.
 *
 * - `same-level`: the channel already sent a message of the same level to the person in the window.
 * - `lower-level`: the channel already sent a message of a higher level to the person in the window.
 */
export type SuppressionReason = "same-level" | "lower-level";

/** A send that the throttle stopped. The send does not go, and the next digest tells its incident. */
export interface Suppression {
  /** The delivery key of the send (`messageKey`). */
  readonly key: string;
  readonly incident: ReportId;
  readonly level: Level;
  readonly person: PersonId;
  readonly channel: ChannelId;
  readonly step: number;
  /** The episode of the escalation. */
  readonly episode: number;
  readonly at: Instant;
  readonly reason: SuppressionReason;
  /** The highest level that the channel sent to the person in the window, or that it sends in the same pass. */
  readonly over: Level;
}

/** The input of `throttleRoutes`. */
export interface ThrottleInput {
  /** The routes at `now`, after the send limit (`limitRoutes`). */
  readonly routes: readonly Route[];
  /** The deliveries of the ledger: the deliveries of this copy and the deliveries of the other copies. */
  readonly deliveries: readonly Delivery[];
  /** The suppressions of the log. A send with a suppression does not go, also after its window. */
  readonly suppressions: readonly Suppression[];
  /** The throttle. The default is `DEFAULT_THROTTLE`. */
  readonly throttle?: Throttle | undefined;
  /**
   * The delivery keys of the sends that this copy started and that have no end yet: a send in flight, or an open copy.
   * Such a send goes, and its level counts in the window. The default is no key.
   */
  readonly started?: ReadonlySet<string> | undefined;
  readonly now: Instant;
}

/** The result of `throttleRoutes`. */
export interface ThrottleResult {
  /**
   * The routes in the same order. A route has no send that the throttle stopped. A route with a suppression and no
   * delivery has its first suppression (`Route.suppressed`).
   */
  readonly routes: readonly Route[];
  /** The new suppressions at `now`, in the order of their sends. The runtime writes them to its log. */
  readonly suppressions: readonly Suppression[];
}

const rankOf = (level: Level): number => LEVELS.indexOf(level);

/**
 * This function applies the throttle to the sends of the routes.
 *
 * - A send of a level with an exemption goes. Thus a `life-safety` alert of a new incident goes, and each step of an
 *   escalation of `life-safety` goes until the acknowledgment.
 * - A send with a suppression in the log does not go. The suppression does not end, thus the send does not go late.
 * - A started send (`started`) goes. The phone can already have its message.
 * - Each other send goes only when its level is above the bar of its window. The bar is the highest level of the
 *   deliveries of the ledger to the person on the channel in the window, and of the sends that go before it in this pass.
 *   With the key `incident`, only the deliveries and the sends of the same incident count. The deliveries of the other
 *   copies count, thus the throttle applies over all the copies.
 * - A send at or below the bar gets a suppression at `now`, with its reason.
 * - The sends go in the order of their due times, then of the anchor, the episode, the step and the channel. The
 *   started sends come first. The sends of a level with an exemption count in the bar too.
 * - A digest has no throttle, and it does not count in the bar.
 * - A route with a suppression and no delivery gets `suppressed`. Thus such an escalation gives no exhaustion: the
 *   person did not get its message.
 */
export function throttleRoutes(input: ThrottleInput): ThrottleResult {
  const throttle = input.throttle ?? DEFAULT_THROTTLE;
  const exempt = new Set(throttle.exempt);
  const logged = new Set(input.suppressions.map((suppression) => suppression.key));
  const started = input.started ?? new Set<string>();
  const from = input.now - throttle.window;

  interface Item {
    readonly route: number;
    readonly send: EscalationSend;
    readonly key: string;
    readonly started: boolean;
  }
  const items: Item[] = [];
  const dropped = new Set<string>();
  input.routes.forEach((entry, route) => {
    for (const send of entry.plan.sends) {
      if (send.level === "digest") continue;
      const key = messageKey(send);
      if (logged.has(key) && !started.has(key)) {
        dropped.add(key);
        continue;
      }
      items.push({ route, send, key, started: started.has(key) });
    }
  });
  items.sort((a, b) => {
    const left = input.routes[a.route]!;
    const right = input.routes[b.route]!;
    return (
      Number(b.started) - Number(a.started) ||
      a.send.due - b.send.due ||
      compareCodeUnits(left.incident.anchor, right.incident.anchor) ||
      left.episode - right.episode ||
      a.send.step - b.send.step ||
      compareCodeUnits(a.send.channel, b.send.channel)
    );
  });

  // The reports of the incident of each route. With the key `incident`, a delivery counts for each route that holds its report.
  const reportsOf = input.routes.map((entry) => new Set<string>([entry.incident.anchor, ...entry.incident.reports]));
  // The window of a send: its person and channel, and with the key `incident` the anchor of the incident of its route.
  const groupOf = (person: PersonId, channel: ChannelId, route: number): string => (throttle.key === "incident" ? `${person} ${channel} ${input.routes[route]!.incident.anchor}` : `${person} ${channel}`);
  // The bar of each window: the highest level of the deliveries in the window, then of the sends of this pass.
  const bars = new Map<string, number>();
  const raise = (group: string, level: Level): void => {
    bars.set(group, Math.max(bars.get(group) ?? -1, rankOf(level)));
  };
  for (const delivery of input.deliveries) {
    if (delivery.level === "digest" || !(delivery.at > from && delivery.at <= input.now)) continue;
    if (throttle.key === "channel") raise(`${delivery.person} ${delivery.channel}`, delivery.level);
    else reportsOf.forEach((reports, route) => {
      if (reports.has(delivery.incident)) raise(groupOf(delivery.person, delivery.channel, route), delivery.level);
    });
  }

  const added: Suppression[] = [];
  for (const item of items) {
    const { send } = item;
    const group = groupOf(send.person, send.channel, item.route);
    const bar = bars.get(group) ?? -1;
    if (item.started || exempt.has(send.level) || rankOf(send.level) > bar) {
      raise(group, send.level);
      continue;
    }
    dropped.add(item.key);
    const over = LEVELS[bar]!;
    added.push({
      key: item.key,
      incident: send.incident,
      level: send.level,
      person: send.person,
      channel: send.channel,
      step: send.step,
      episode: send.episode ?? 0,
      at: input.now,
      reason: over === send.level ? "same-level" : "lower-level",
      over,
    });
  }
  // The suppressions of each report. A route with no delivery gets the first suppression of its person, episode and level.
  const byReport = new Map<string, Suppression[]>();
  for (const suppression of [...input.suppressions, ...added]) {
    const list = byReport.get(suppression.incident);
    if (list === undefined) byReport.set(suppression.incident, [suppression]);
    else list.push(suppression);
  }
  const suppressedOf = (entry: Route, route: number): Suppression | undefined => {
    if (entry.deliveries.length > 0 || byReport.size === 0) return undefined;
    for (const report of reportsOf[route]!) {
      const found = byReport.get(report)?.find((suppression) => suppression.person === entry.person && suppression.episode === entry.episode && suppression.level === entry.policy.level);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  if (dropped.size === 0 && byReport.size === 0) return { routes: input.routes, suppressions: [] };
  return {
    routes: input.routes.map((entry, route) => {
      const sends = entry.plan.sends.filter((send) => !dropped.has(messageKey(send)));
      const suppressed = suppressedOf(entry, route);
      if (sends.length === entry.plan.sends.length && suppressed === undefined) return entry;
      return { ...entry, ...(suppressed === undefined ? {} : { suppressed }), plan: { ...entry.plan, sends } };
    }),
    suppressions: added,
  };
}
