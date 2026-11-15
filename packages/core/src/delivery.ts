/**
 * This module routes each incident to the escalations of each person. It also makes the message of a
 * send and the acknowledgment of a status. It is pure. The runtime gives the time, and
 * the runtime does each call of a channel.
 */
import { assess, COVERAGE_KIND, DEFAULT_ASSESS_POLICY, hasKind, LIFE_SAFETY_KINDS, QUOTA_KIND } from "./assess.ts";
import {
  LEVELS,
  type Acknowledgment,
  type Address,
  type AssessPolicy,
  type ChannelDescriptor,
  type Delivery,
  type DeliveryStatus,
  type Duration,
  type EscalationPolicy,
  type Incident,
  type Instant,
  type Level,
  type MergeState,
  type Message,
  type PersonId,
  type PersonWatch,
  type Report,
  type ReportId,
  type WatchedPlace,
} from "./contracts.ts";
import { escalate, escalationProblems, quietWindowProblems, type EscalationPlan, type EscalationSend } from "./escalation.ts";
import { messageKey } from "./ids.ts";
import { unknownKinds } from "./taxonomy.ts";

/** A person of the delivery. The private configuration gives each one. */
export interface Recipient {
  /** The places, the subjects, the rules and the quiet window of the person. */
  readonly watch: PersonWatch;
  /** The escalation policy of each level. A level with no policy starts no escalation for this person. */
  readonly policies: readonly EscalationPolicy[];
  /** The address of the person on each channel, by the channel id. */
  readonly addresses: Readonly<Record<string, Address>>;
}

/**
 * The start of an escalation: the time at which the level of an incident first called for it. The
 * runtime keeps each start in its log, thus the start does not move after a restart.
 */
export interface EscalationStart {
  /** A report of the incident: its anchor at the start. */
  readonly incident: ReportId;
  readonly level: Level;
  readonly person: PersonId;
  readonly at: Instant;
}

/** The input of `route`. */
export interface RouteInput {
  /** The merge state. Its deliveries and its acknowledgments go to each escalation. */
  readonly state: MergeState;
  /** The incidents of the merge state at `now`. */
  readonly incidents: readonly Incident[];
  readonly recipients: readonly Recipient[];
  readonly places: readonly WatchedPlace[];
  /** The policy of the assessment. The default is `DEFAULT_ASSESS_POLICY`. */
  readonly assess?: AssessPolicy | undefined;
  /** The starts that the log has. */
  readonly starts: readonly EscalationStart[];
  /** The delivery keys with no more repeats. */
  readonly cancelled: ReadonlySet<string>;
  /** The descriptor of each channel. A delivery of a channel with the acknowledgment `poll` gets a poll. */
  readonly channels: readonly ChannelDescriptor[];
  /** The rank of this copy of the system, and the wait of each rank. `escalate` tells how they apply. */
  readonly rank?: number | undefined;
  readonly rankDelay?: Duration | undefined;
  readonly now: Instant;
}

/** One escalation: one incident, one level and one person. */
export interface Route {
  readonly incident: Incident;
  readonly person: PersonId;
  readonly policy: EscalationPolicy;
  /** The start of the escalation. When `fresh` is true, the log does not have it, and the runtime writes it. */
  readonly start: EscalationStart;
  readonly fresh: boolean;
  /** The deliveries of this escalation in the ledger. */
  readonly deliveries: readonly Delivery[];
  /** The deliveries that need a poll for an acknowledgment: each one with a receipt, no cancel and a channel that polls. */
  readonly polls: readonly Delivery[];
  readonly plan: EscalationPlan;
}

/**
 * This function gives the escalations at `now`, in the order of the anchor, the person and the level.
 *
 * - The levels of an incident and a person are each level of a start or a delivery, and the assessed level.
 *   The assessed level counts only when it is higher than those levels and the person has a policy for it.
 *   An incident that is not live has no assessed level.
 * - Only the highest level continues. A lower level ends at the start of a higher level, thus its repeats stop.
 *   An acknowledgment of the higher level also covers each lower level.
 * - Thus the level does not go down. An escalation continues until an acknowledgment or the end of the incident.
 * - An incident that is not live gets an escalation only when one of its deliveries has no cancel. Its end is its expiry, or `now`.
 * - The start of an escalation is the start in the log. A new escalation starts at `now`, or earlier when the ledger shows an earlier start.
 */
export function route(input: RouteInput): Route[] {
  const { state, now } = input;
  const policy = input.assess ?? DEFAULT_ASSESS_POLICY;
  const polling = new Set(input.channels.filter((channel) => channel.ack === "poll").map((channel) => channel.id as string));
  const routes: Route[] = [];
  for (const incident of input.incidents) {
    const reports = new Set<string>([incident.anchor, ...incident.reports]);
    const ofIncident = (item: { readonly incident: ReportId }): boolean => reports.has(item.incident);
    const deliveries = state.deliveries.filter(ofIncident);
    const open = deliveries.some((delivery) => !input.cancelled.has(delivery.key));
    if (!incident.live && !open) continue;
    const starts = input.starts.filter(ofIncident);
    const end = endOf(incident, now);
    for (const recipient of input.recipients) {
      const person = recipient.watch.person;
      const policyOf = (level: Level): EscalationPolicy | undefined => recipient.policies.find((entry) => entry.level === level);
      const levels = new Set<Level>();
      for (const item of [...starts, ...deliveries]) if (item.person === person) levels.add(item.level);
      // The level does not go down: an assessed level below a level of the log starts nothing.
      const top = Math.max(-1, ...[...levels].map((level) => LEVELS.indexOf(level)));
      if (incident.live) {
        const assessed = assess(incident, recipient.watch, input.places, policy).level;
        if (assessed !== "none" && LEVELS.indexOf(assessed) > top && policyOf(assessed) !== undefined) levels.add(assessed);
      }
      const ordered = LEVELS.filter((level) => levels.has(level));
      // The start in the log of each level, or `undefined`.
      const logged = ordered.map((level) => earliestStart(starts, person, level));
      // A higher level that has no start starts at `now`.
      const startAt = ordered.map((_, index) => logged[index]?.at ?? now);
      ordered.forEach((level, index) => {
        const endsAt = earliest([end, ...startAt.slice(index + 1)]);
        // A level of the log with no policy now gets a policy with no step: it sends nothing, and its end still stops its repeats.
        const chosen = policyOf(level) ?? { level, steps: [], exhaustedAfter: 0 };
        const plan = escalate({
          policy: chosen,
          person,
          incident,
          since: startAt[index]!,
          ...(endsAt === undefined ? {} : { endsAt }),
          deliveries: state.deliveries,
          acknowledgments: state.acks,
          cancelled: input.cancelled,
          rank: input.rank,
          rankDelay: input.rankDelay,
          quiet: recipient.watch.quiet,
          now,
        });
        const ours = deliveries.filter((delivery) => delivery.person === person && delivery.level === level);
        const active = plan.state === "sent" || plan.state === "last" || plan.state === "exhausted";
        const polls = active ? ours.filter((delivery) => delivery.receipt !== undefined && !input.cancelled.has(delivery.key) && polling.has(delivery.channel)) : [];
        const found = logged[index];
        const fresh = found === undefined;
        const start: EscalationStart = { incident: found?.incident ?? incident.anchor, level, person, at: plan.start };
        routes.push({ incident, person, policy: chosen, start, fresh, deliveries: ours, polls, plan });
      });
    }
  }
  return routes.sort((a, b) => compare(a.incident.anchor, b.incident.anchor) || compare(a.person, b.person) || LEVELS.indexOf(a.policy.level) - LEVELS.indexOf(b.policy.level));
}

/** The codes that can reach `life-safety`: the life-safety kinds, and the coverage of each of them. */
const LIFE_SAFETY_CODES: readonly string[] = [...LIFE_SAFETY_KINDS, ...LIFE_SAFETY_KINDS.map((kind) => `${COVERAGE_KIND}.${kind}`)];

/** This function tells if two prefixes of the taxonomy share a kind: one of them has the other. */
const overlap = (a: string, b: string): boolean => hasKind([a], b) || hasKind([b], a);

/**
 * This function gives the problems of a recipient. `route` accepts each recipient, but a recipient with
 * a problem does not get what its author meant. A kind with a typo matches no alert, so it can stop a wake.
 *
 * A life-safety alert always gets its escalation. Thus a person who watches a place or a subject has a
 * `life-safety` policy, and no rule keeps a life-safety kind below `life-safety`.
 */
export function recipientProblems(recipient: Recipient, channels: readonly ChannelDescriptor[]): string[] {
  const problems: string[] = [];
  const known = new Set(channels.map((channel) => channel.id as string));
  const seen = new Set<Level>();
  for (const policy of recipient.policies) {
    if (seen.has(policy.level)) problems.push(`Two policies have the level ${policy.level}. Only the first one applies.`);
    seen.add(policy.level);
    for (const problem of escalationProblems(policy)) problems.push(`The policy of ${policy.level}: ${problem}`);
    policy.steps.forEach((step, index) => {
      if (!known.has(step.channel)) problems.push(`Step ${index} of ${policy.level} uses the channel ${step.channel}, and the system has no such channel.`);
      if (recipient.addresses[step.channel] === undefined) problems.push(`Step ${index} of ${policy.level} uses the channel ${step.channel}, and the person has no address on it.`);
    });
  }
  const watches = recipient.watch.places.length > 0 || (recipient.watch.subjects ?? []).length > 0;
  if (watches && !seen.has("life-safety")) problems.push("The person watches a place or a subject, and has no policy of the level life-safety. A life-safety alert sends nothing to the person.");
  recipient.watch.rules.forEach((rule, index) => {
    for (const code of unknownKinds(rule.kinds ?? [])) problems.push(`Rule ${index} names the kind ${code}, and the taxonomy has no such code. The rule matches no alert of it.`);
    // A rule only at places that the person does not watch matches no alert. A rule with an empty list of kinds also matches none.
    if (rule.max === "life-safety" || (rule.places !== undefined && !rule.places.some((place) => recipient.watch.places.includes(place)))) return;
    const capped = rule.kinds === undefined ? ["each kind"] : rule.kinds.filter((kind) => LIFE_SAFETY_CODES.some((code) => overlap(kind, code)));
    if (capped.length > 0) problems.push(`Rule ${index} keeps ${capped.join(", ")} at ${rule.max} or lower. A life-safety kind is in it, and a rule does not keep a life-safety kind below life-safety.`);
  });
  if (recipient.watch.quiet !== undefined) for (const problem of quietWindowProblems(recipient.watch.quiet)) problems.push(`The quiet window: ${problem}`);
  return problems;
}

/**
 * This function makes the message of a send. The text comes from one report of the incident. That
 * report has the severity and the urgency of the incident, and it is the latest one by its time of
 * sending. The channel cuts the text to its limits.
 *
 * A message of the line `system.quota.reserve` can use the reserve of the quota. Else the reserve
 * stops the message that tells of it.
 */
export function messageOf(incident: Incident, reports: readonly Report[], send: EscalationSend): Message {
  const report = textReport(incident, reports);
  const title = report?.headline.trim() || incident.kind.label;
  const body = [report?.instruction, report?.areaText, report?.description].flatMap((part) => (part === undefined || part.trim() === "" ? [] : [part.trim()])).join("\n\n");
  return {
    key: messageKey(send),
    person: send.person,
    level: send.level,
    title,
    body,
    ...(report?.web === undefined ? {} : { url: report.web }),
    incident: send.incident,
    ...(incident.expires === undefined ? {} : { expires: incident.expires }),
    quiet: send.quiet,
    ...(incident.kind.code === `${QUOTA_KIND}.reserve` ? { useReserve: true } : {}),
  };
}

/** This function gives the acknowledgment that a status of a delivery tells, or `undefined`. */
export function acknowledgmentOf(delivery: Delivery, status: DeliveryStatus): Acknowledgment | undefined {
  if (status.state !== "acknowledged") return undefined;
  return { incident: delivery.incident, level: delivery.level, person: delivery.person, at: status.at, via: delivery.channel };
}

// The end of an incident: its expiry, or `now` when it is not live and its expiry is not earlier.
function endOf(incident: Incident, now: Instant): Instant | undefined {
  const expires = incident.expires !== undefined && Number.isFinite(incident.expires) ? incident.expires : undefined;
  if (incident.live) return expires;
  return expires !== undefined && expires <= now ? expires : now;
}

function earliest(times: readonly (Instant | undefined)[]): Instant | undefined {
  let found: Instant | undefined;
  for (const time of times) if (time !== undefined && Number.isFinite(time) && (found === undefined || time < found)) found = time;
  return found;
}

// The earliest start in the log of a person and a level. A tie goes to the smallest report id.
function earliestStart(starts: readonly EscalationStart[], person: PersonId, level: Level): EscalationStart | undefined {
  let found: EscalationStart | undefined;
  for (const start of starts) {
    if (start.person !== person || start.level !== level || !Number.isFinite(start.at)) continue;
    if (found === undefined || start.at < found.at || (start.at === found.at && compare(start.incident, found.incident) < 0)) found = start;
  }
  return found;
}

// The report of the text of a message. The reports come from the merge state, in the order of their ids.
function textReport(incident: Incident, reports: readonly Report[]): Report | undefined {
  const members = new Set<string>(incident.reports);
  let found: Report | undefined;
  for (const report of reports) {
    if (!members.has(report.id)) continue;
    const matches = report.severity === incident.severity && report.urgency === incident.urgency;
    const foundMatches = found !== undefined && found.severity === incident.severity && found.urgency === incident.urgency;
    if (found === undefined || (matches && !foundMatches) || (matches === foundMatches && report.sent > found.sent)) found = report;
  }
  return found;
}

// The order of the code units, the same in each copy and each locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
