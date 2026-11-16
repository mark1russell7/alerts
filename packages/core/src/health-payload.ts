/**
 * The payload of the health route of the runtime. It tells the state of each part of the system. The parts are the
 * sources, the lateness, the coverage, the other copies, the quotas and the balances.
 */

import type {
  BalanceStage,
  ChannelQuota,
  CopyRead,
  CopyStage,
  CopyWatch,
  Coverage,
  FetchFailure,
  Instant,
  ProviderBalance,
  QuotaStage,
  SourceHealth,
} from "./contracts.ts";
import type { Lateness } from "./lateness.ts";
import { balanceStages, copyStages, quotaStages } from "./system-reports.ts";

/** The name of the format of the health payload. A change that breaks a reader gets a new name. */
export const HEALTH_FORMAT = "alerts-health/1";

/**
 * The health of one source in the payload. It keeps the kind of the last failure, and not its message. A message can hold
 * the address of a fetch, and an address can hold a key.
 */
export interface SourceHealthView extends Omit<SourceHealth, "lastFailure"> {
  readonly lastFailure?: { readonly at: Instant; readonly kind: FetchFailure["kind"] };
}

/** The health of another copy of the system: its stages at the time of the read, and its last read that passed. */
export interface CopyHealth {
  readonly copy: string;
  readonly stages: readonly CopyStage[];
  readonly read?: CopyRead;
}

/** The health of the quota of one channel: the quota, and the stages that it reached. */
export interface QuotaHealth {
  readonly quota: ChannelQuota;
  readonly stages: readonly QuotaStage[];
}

/** The health of the balance of one provider account: the balance, and its stages at the time of the read. */
export interface BalanceHealth {
  readonly balance: ProviderBalance;
  readonly stages: readonly BalanceStage[];
}

/**
 * The answer of the health route of the runtime. The route is on the loopback address only, because the coverage holds
 * the ids of the places. The payload holds no secret and no message of a failure.
 */
export interface HealthPayload {
  /** The format of the payload. A page of another format tells the reader to start the runtime of its own version. */
  readonly format: typeof HEALTH_FORMAT;
  /** The time of the last pass, or `null` before the first pass. The sources, the lateness and the coverage are from it. */
  readonly at: Instant | null;
  /** The time of the read. The stages of the copies and of the balances are at this time. */
  readonly now: Instant;
  readonly sources: readonly SourceHealthView[];
  readonly lateness: readonly Lateness[];
  readonly coverage: readonly Coverage[];
  readonly copies: readonly CopyHealth[];
  readonly quotas: readonly QuotaHealth[];
  readonly balances: readonly BalanceHealth[];
}

/** These are the inputs of the payload of the health route. */
export interface HealthPayloadInput {
  /** The time of the last pass, or `null` before the first pass. */
  readonly at: Instant | null;
  /** The time of the read. */
  readonly now: Instant;
  /** The health of each source at the last pass. */
  readonly sources: readonly SourceHealth[];
  /** The lateness of each expectation at the last pass. */
  readonly lateness: readonly Lateness[];
  /** The coverage of each kind at each place at the last pass. */
  readonly coverage: readonly Coverage[];
  /** The watch of each other copy at the time of the read. */
  readonly copies: readonly CopyWatch[];
  /** The quota of each channel at the time of the read. */
  readonly quotas: readonly ChannelQuota[];
  /** The balance of each provider account that has a read. */
  readonly balances: readonly ProviderBalance[];
}

/** This function gives the health of a source without the message of its last failure. */
export function sourceHealthView(health: SourceHealth): SourceHealthView {
  const { lastFailure, ...rest } = health;
  return lastFailure === undefined ? rest : { ...rest, lastFailure: { at: lastFailure.at, kind: lastFailure.failure.kind } };
}

/**
 * This function gives the payload of the health route. It keeps the order of each list of its input. The core gives the
 * stages, thus the page and the system reports agree on each stage.
 */
export function healthPayload(input: HealthPayloadInput): HealthPayload {
  const { at, now } = input;
  return {
    format: HEALTH_FORMAT,
    at,
    now,
    sources: input.sources.map(sourceHealthView),
    lateness: input.lateness,
    coverage: input.coverage,
    copies: input.copies.map((watch) => ({ copy: watch.copy, stages: copyStages(watch, now), ...(watch.read === undefined ? {} : { read: watch.read }) })),
    quotas: input.quotas.map((quota) => ({ quota, stages: quotaStages(quota) })),
    balances: input.balances.map((balance) => ({ balance, stages: balanceStages(balance, now) })),
  };
}
