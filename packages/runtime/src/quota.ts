/**
 * The quotas of the channels in the runtime. The state of a gate of `polite-crawler/api` becomes data of
 * the core. The lines of the system reports and the body of each ping use this data.
 */
import { quotaStages, type ChannelId, type ChannelQuota, type Instant } from "@mark1russell7/alerts";
import type { QuotaGate } from "polite-crawler/api";

/** The parts of a quota gate of `polite-crawler/api` that `channelQuota` reads. */
export type QuotaView = Pick<QuotaGate, "quota" | "state">;

/**
 * This function gives the state of the gate of a channel as data of the core. Each call reads the store of the gate.
 * The `unit` names the units in the texts, for example `cents` for a cap of the spend.
 */
export function channelQuota(channel: ChannelId, gate: QuotaView, unit?: string): ChannelQuota {
  const state = gate.state();
  return {
    channel,
    limit: gate.quota.limit,
    reserve: gate.quota.reserve ?? 0,
    used: state.used,
    ...(unit === undefined ? {} : { unit }),
    ...(state.resetAt === undefined ? {} : { resetAt: state.resetAt }),
    ...(state.blockedUntil === undefined ? {} : { blockedUntil: state.blockedUntil }),
  };
}

/**
 * This function gives the line of the state of a quota for the body of a ping. In the reserve, the
 * channel sends only the highest level until the reset. Thus the check shows the reserve, and the
 * ping stays `success`.
 */
export function quotaNote(quota: ChannelQuota): string {
  const { channel, limit, reserve, used } = quota;
  const unit = quota.unit ?? "units";
  const until = (time: Instant | undefined): string => (time === undefined ? "" : ` until ${new Date(time).toISOString()}`);
  const stages = quotaStages(quota);
  if (quota.blockedUntil !== undefined) return `${channel}: the provider refuses each message${until(quota.blockedUntil)}.`;
  if (stages.includes("spent")) return `${channel}: all ${limit} ${unit} of the window are used${until(quota.resetAt)}.`;
  if (stages.includes("reserve")) return `${channel}: ${used} of ${limit} ${unit} are used. The channel keeps the last ${reserve} ${unit} for life-safety${until(quota.resetAt)}.`;
  return `${channel}: ${used} of ${limit} ${unit} are used, and ${limit - reserve - used} are left before the reserve of ${reserve}.`;
}
