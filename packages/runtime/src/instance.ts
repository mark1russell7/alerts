/**
 * This module makes the instance of the owner from the private configuration. The instance has the
 * sources, the Pushover channel, the Twilio call channel, the runtime and its loop. The entry `main.ts` reads the files, and it gives the
 * clocks and the transports. This module reads no file, no environment variable and no clock.
 */
import { delay, frameClock, wallClock, type Clock, type WallClock } from "@mark1russell7/algebra/clock";
import {
  CLOCK_STEP_ABOVE,
  configuredExpectations,
  DEFAULT_LINK_POLICY,
  expectationProblems,
  healthPayload,
  historyPayload,
  linkRule,
  localPlaces,
  mapPayload,
  ONLY_COPY,
  optedIn,
  placeLabels,
  sourceCovers,
  sourcePlaces,
  type ChannelDescriptor,
  type ChannelId,
  type ChannelProcedures,
  type ChannelQuota,
  type CopySettings,
  type Duration,
  type Expectation,
  type HealthPayload,
  type HistoryPayload,
  type Instant,
  type MapPayload,
  type OptInRecord,
  type ParsedConfig,
  type SecretLookup,
  type SourceDescriptor,
  type SourceProcedures,
  type SpendConfig,
} from "@mark1russell7/alerts";
import {
  CHANNEL_ID as TWILIO_CHANNEL,
  createTwilioCallChannel,
  createTwilioTextChannel,
  readTwilioBalance,
  readTwilioReplies,
  readTwilioSpend,
  TEXT_CHANNEL_ID,
  TWILIO_CALL_COST_USD,
  TWILIO_CALL_TIMEOUT_MS,
  TWILIO_TEXT_COST_USD,
  twilioCallDescriptor,
  twilioSetupProblems,
  twilioTextDescriptor,
  type TextOptIn,
  type TwilioCredentials,
  type TwilioFetch,
} from "@mark1russell7/alerts-channel-twilio";
import { CHANNEL_ID, createPushoverChannel, isPushoverKey, pushoverDescriptor, PUSHOVER_REPEAT_MS, PUSHOVER_TIMEOUT_MS, type PushoverChannelOptions } from "@mark1russell7/alerts-channel-pushover";
import { createEmscSource, EMSC_DESCRIPTOR } from "@mark1russell7/alerts-source-emsc";
import { createIpawsSource, IPAWS_DESCRIPTOR, WEA_EXPECTATION } from "@mark1russell7/alerts-source-ipaws";
import { createShapeStore, type ShapeCache, type ShapeStore } from "@mark1russell7/alerts-shapes-nws";
import { createNwsSource, NWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nws-api";
import { createNwwsSource, SOURCE_ID as NWWS_SOURCE, type NwwsAccount, type OpenSession } from "@mark1russell7/alerts-source-nwws";
import { createGfzSource, GFZ_DESCRIPTOR } from "@mark1russell7/alerts-source-gfz";
import { createSwpcSource, SWPC_DESCRIPTOR } from "@mark1russell7/alerts-source-swpc";
import { createTsunamiSource, descriptorOf as tsunamiDescriptor, TSUNAMI_CENTERS, type TsunamiCenter, type TsunamiFetchOptions } from "@mark1russell7/alerts-source-tsunami";
import { createUsgsSource, USGS_DESCRIPTOR } from "@mark1russell7/alerts-source-usgs";
import { err, ok, type Result } from "@mark1russell7/optional";
import type { WorkerLoop } from "@mark1russell7/service";
import type { Pace, QuotaStore, Transport } from "polite-crawler/api";
import { DEFAULT_POLICY, HostScheduler, type PolitenessPolicy } from "polite-crawler/politeness";
import { balanceWatch, SPEND_UNIT, spendEntryOf, spendGates, spendQuota, spendUnits, spendWatch, type BalanceWatch, type SpendGates, type SpendWatch } from "./balance.ts";
import { replyWatch, type ReplyWatch } from "./replies.ts";
import { parseSecrets, requireKey, SECRETS_FILE, type FileText, type InstanceCheck } from "./config.ts";
import { CLOCK_SKEW_LIMIT, COPY_FILE, COPY_TOKEN_KEY, EXCHANGE_EVERY, EXCHANGE_LIMIT } from "./copy.ts";
import { overdueLimit, type DeliveryOptions } from "./delivery.ts";
import { copyDrills } from "./drills.ts";
import type { RuntimeLog } from "./log.ts";
import { createLoop, loopTimes, shortestFetchLimit, type LoopTimes, type RuntimeLoop } from "./loop.ts";
import { outageDeploy, outageDeployWorker, outageSetup, type OutageDeployWorker } from "./outage.ts";
import { exchangeLoop, exchangeWorker, type EntriesSource, type ExchangeCall, type ExchangeRound, type ExchangeWorker } from "./peers.ts";
import { channelQuota } from "./quota.ts";
import { openRuntime, type Pass, type Runtime, type RuntimeOptions } from "./runtime.ts";
import { addZoneCodes, keepShapes, placeCodesKey, type InstanceShapes, type ShapeOutcome, type ZoneCodeCounts } from "./shapes.ts";
import { DELAY_LIMITS, earliest, nextFetch } from "./view.ts";

/** The name of the secret that holds the API token of the Pushover application. */
export const PUSHOVER_TOKEN = "PUSHOVER_APP_TOKEN";

/** The name of the key of `secrets.env` that holds the address of the outside heartbeat. */
export const PING_URL_KEY = "HEALTHCHECKS_PING_URL";

/**
 * The name of the optional key of `secrets.env` that holds the address of a second check: the loud
 * check. Its integration makes a phone call to the person, and it shares no channel with the instance. The
 * heartbeat sends each ping to the two checks. Without the key, nothing changes.
 */
export const LOUD_PING_URL_KEY = "HEALTHCHECKS_LOUD_PING_URL";

/**
 * This function gives the key of `secrets.env` with the address of the first check of a copy. Each copy has its own
 * first check, thus a stop of one copy makes its own alert. The default key is `PING_URL_KEY`.
 */
export const pingKeyOf = (copy: CopySettings): string => copy.pingKey ?? PING_URL_KEY;

/** One check of the outside heartbeat: the key of `secrets.env` and its address. */
export interface PingTarget {
  /** The key of the first check of the copy, or `LOUD_PING_URL_KEY`. */
  readonly key: string;
  readonly url: string;
}

/**
 * This function gives the checks of the outside heartbeat from the secrets: the first check of the copy, then the loud
 * check. The copies share the loud check. A key with an empty value gives no check.
 */
export function pingTargets(secret: (key: string) => string | undefined, copy: CopySettings = ONLY_COPY): readonly PingTarget[] {
  return [pingKeyOf(copy), LOUD_PING_URL_KEY].flatMap((key): PingTarget[] => {
    const url = secret(key) ?? "";
    return url === "" ? [] : [{ key, url }];
  });
}

/**
 * The name of the key of `secrets.env` that holds the key of the management API of Healthchecks.io. Only
 * the status of `install.ts` reads it. The runtime does not use it.
 */
export const CHECKS_KEY = "HEALTHCHECKS_API_KEY";

/** The two keys of the status check of the heartbeat. */
export interface ChecksKeys {
  /** The key of the management API. */
  readonly key: string;
  /** The address of the outside heartbeat. */
  readonly url: string;
  /** The address of the loud check, when `secrets.env` has one. */
  readonly loudUrl?: string;
}

/**
 * This function gives the keys of the status check of the heartbeat from the text of `secrets.env`. The keys are
 * the key of the API, the first check of the copy and the loud check. It parses the text as the start does. A problem holds no value and no path.
 */
export function checksKeys(file: FileText, copy: CopySettings = ONLY_COPY): Result<ChecksKeys, readonly string[]> {
  const keys = parseSecrets(file);
  if (keys.tag === "err") return keys;
  const pingKey = pingKeyOf(copy);
  const key = keys.value[CHECKS_KEY] ?? "";
  const url = keys.value[pingKey] ?? "";
  const loudUrl = keys.value[LOUD_PING_URL_KEY] ?? "";
  if (key === "" || url === "") return err([`The file ${SECRETS_FILE} needs ${CHECKS_KEY} and ${pingKey} for this check.`]);
  return ok(loudUrl === "" ? { key, url } : { key, url, loudUrl });
}

/** The name of the application in the User-Agent of each request. The NWS asks for a name and a contact. */
export const USER_AGENT_NAME = "alerts-runtime";

/**
 * This function gives the User-Agent of each request of the instance: the name, and the contact of the
 * operator when the configuration has one. Without a contact, no request names a person or an account.
 */
export const userAgent = (contact: string | undefined): string => (contact === undefined ? USER_AGENT_NAME : `${USER_AGENT_NAME} (+${contact})`);

// The limits of the delays are in `view.ts`, because the measure of the IEM list reads them too.
export { DELAY_LIMITS };

/**
 * The descriptors of the channels of the instance. The loader of the configuration checks each
 * recipient against this list: the channel of each step, and the fields of each address. Thus the loader
 * and the instance agree on the channels.
 */
export const INSTANCE_CHANNELS: readonly ChannelDescriptor[] = [pushoverDescriptor(), twilioCallDescriptor(), twilioTextDescriptor()];

/**
 * The names of the keys of `secrets.env` for the Twilio call channel. The secret is the secret of an API key
 * of the account, not the auth token of the account.
 */
export const TWILIO_KEYS = { accountSid: "TWILIO_ACCOUNT_SID", keySid: "TWILIO_API_KEY_SID", secret: "TWILIO_API_KEY_SECRET", from: "TWILIO_FROM" } as const;

/**
 * The name of the key of `secrets.env` that holds the Twilio number of the texts. A text to a phone in the United States
 * needs a registered sender: the phone of a 10DLC campaign or a verified toll-free phone. Without the key, the instance sends no text.
 */
export const TWILIO_TEXT_FROM_KEY = "TWILIO_TEXT_FROM";

/** The setup of the Twilio channels: the credentials of the account, the number that calls and the number that texts. */
export interface TwilioSetup {
  readonly credentials: TwilioCredentials;
  readonly from: string;
  /** The number of the text channel and of the texts of the outage call, from the key `TWILIO_TEXT_FROM_KEY`. */
  readonly textFrom?: string;
}

/**
 * This function gives the setup of the Twilio channels from the secrets.
 *
 * - With none of the keys of `TWILIO_KEYS`, it gives `undefined`. The instance then has no call channel and no text channel.
 * - With some keys and not all, or with a value of a bad form, it gives the problems. A problem names keys, and no value.
 * - The key `TWILIO_TEXT_FROM_KEY` is optional. It needs the keys of `TWILIO_KEYS`.
 */
export function twilioSetup(secret: SecretLookup): Result<TwilioSetup | undefined, readonly string[]> {
  const value = (name: string): string => secret(name) ?? "";
  const names = Object.values(TWILIO_KEYS);
  const missing = names.filter((name) => value(name) === "");
  const textFrom = value(TWILIO_TEXT_FROM_KEY);
  if (missing.length === names.length) {
    return textFrom === "" ? ok(undefined) : err([`The secret store has a value for ${TWILIO_TEXT_FROM_KEY}, and no keys of Twilio. Give the keys of Twilio, or remove the value.`]);
  }
  if (missing.length > 0) return err([`The secret store has some keys of Twilio, and it has no value for ${missing.join(", ")}. Give all the keys, or none.`]);
  const setup: TwilioSetup = {
    credentials: { accountSid: value(TWILIO_KEYS.accountSid), keySid: value(TWILIO_KEYS.keySid), secret: value(TWILIO_KEYS.secret) },
    from: value(TWILIO_KEYS.from),
    ...(textFrom === "" ? {} : { textFrom }),
  };
  const problems = twilioSetupProblems(setup.credentials, setup.from, setup.textFrom);
  return problems.length === 0 ? ok(setup) : err(problems.map((problem) => `The keys of Twilio have a problem: ${problem}`));
}

/** The ids of the sources with an account. The field `accounts` of the settings of a copy names only these sources. */
export const ACCOUNT_SOURCES: readonly string[] = [NWWS_SOURCE];

/** This function gives the names of the keys of `secrets.env` for an account of NWWS-OI. The keys of account `n` end in `_n`. */
export function nwwsKeys(account: number): { readonly username: string; readonly password: string } {
  return { username: `NWWS_OI_USER_${String(account)}`, password: `NWWS_OI_PASSWORD_${String(account)}` };
}

/**
 * This function gives the account of the NWWS-OI source of a copy from the secrets. The field `accounts` of the copy gives
 * the number of the account. The default is account 1.
 *
 * - With no key of account 1, and no account in the copy, it gives `undefined`. The instance then has no NWWS-OI source.
 * - With one key of the pair and not the other, it gives a problem. A problem names keys, and no value.
 * - With an account in the copy and no key of that account, it gives a problem.
 */
export function nwwsSetup(secret: SecretLookup, copy: CopySettings = ONLY_COPY): Result<NwwsAccount | undefined, readonly string[]> {
  const account = copy.accounts?.[NWWS_SOURCE];
  const keys = nwwsKeys(account ?? 1);
  const username = secret(keys.username) ?? "";
  const password = secret(keys.password) ?? "";
  if (username !== "" && password !== "") return ok({ username, password });
  const missing = [keys.username, keys.password].filter((name) => (secret(name) ?? "") === "");
  if (missing.length === 1) return err([`The secret store has one key of the NWWS-OI account ${String(account ?? 1)}, and it has no value for ${missing.join(", ")}. Give the two keys, or none.`]);
  if (account === undefined) return ok(undefined);
  return err([`The file ${COPY_FILE} gives the NWWS-OI account ${String(account)} to this copy, and the secret store has no value for ${missing.join(", ")}.`]);
}

/** This function gives the problems of the field `accounts` of a copy: each id of a source with no account. */
function accountProblems(copy: CopySettings): string[] {
  return Object.keys(copy.accounts ?? {})
    .filter((id) => !ACCOUNT_SOURCES.includes(id))
    .map((id) => `The file ${COPY_FILE}: the field accounts names the source ${id}. Only these sources have an account: ${ACCOUNT_SOURCES.join(", ")}.`);
}

/**
 * This function gives the channels that the instance sends on. Pushover is always one. The Twilio call channel needs the keys of
 * `TWILIO_KEYS`, and the text channel also needs `TWILIO_TEXT_FROM_KEY`. A step on another channel of `INSTANCE_CHANNELS` stops the start.
 */
export function instanceSenders(secret: SecretLookup): readonly ChannelId[] {
  const twilio = twilioSetup(secret);
  if (twilio.tag === "err" || twilio.value === undefined) return [CHANNEL_ID];
  return twilio.value.textFrom === undefined ? [CHANNEL_ID, TWILIO_CHANNEL] : [CHANNEL_ID, TWILIO_CHANNEL, TEXT_CHANNEL_ID];
}

/** The tsunami warning centers of the NWS. Each center is a source of its own, with its own health. */
const TSUNAMI = [TSUNAMI_CENTERS.ntwc, TSUNAMI_CENTERS.ptwc] as const;

/** This function gives the factory of the source of one tsunami warning center. */
const tsunamiFactory =
  (center: TsunamiCenter) =>
  (options: Omit<TsunamiFetchOptions, "center">): SourceProcedures =>
    createTsunamiSource({ ...options, center });

/**
 * The descriptors of the sources of the instance. The function `describe` of each source gives the same descriptor.
 * The USGS and EMSC give the earthquakes. Merge rule 3 (`linkRule` of the core) joins their reports of one event.
 * The two tsunami warning centers give the tsunami messages. The SWPC gives the space weather messages.
 *
 * GFZ gives the index Kp, a second origin of the geomagnetic storms. Merge rule 3 joins its storms to the storms of the SWPC.
 */
export const INSTANCE_SOURCES: readonly SourceDescriptor[] = [
  NWS_DESCRIPTOR,
  IPAWS_DESCRIPTOR,
  USGS_DESCRIPTOR,
  EMSC_DESCRIPTOR,
  ...TSUNAMI.map((center) => tsunamiDescriptor(center)),
  SWPC_DESCRIPTOR,
  GFZ_DESCRIPTOR,
];

/** The expectations of the instance. The field `expectations` of the configuration sets their `since`. */
export const INSTANCE_EXPECTATIONS: readonly Expectation[] = [WEA_EXPECTATION];

/**
 * The politeness policy of the sources. After 5 failures in a row, a host stops for the longest step of the backoff, not for
 * the hour of `DEFAULT_POLICY`. A stop of one hour hides each alert of that hour.
 *
 * - Each failure after the stop stops the host again. Thus a failed host gets one request in each 5 minutes, as at the end of the backoff.
 * - After an outage, the health of a source comes up in the stop and two intervals. One interval is the wait for the next pass.
 *   The other interval is the limit of a fetch.
 */
export const SOURCE_POLICY: PolitenessPolicy = { ...DEFAULT_POLICY, failureStopMs: DEFAULT_POLICY.backoffCapMs };

/**
 * This function gives the pace of the sources of an instance: one scheduler for `sources` hosts on the clocks of the
 * instance, and `SOURCE_POLICY`. The pace of the sources reads the clocks of the instance, not the clock of polite-crawler.
 */
export function sourcePace(clock: Clock, wall: WallClock, sources: number): Pace & { readonly scheduler: HostScheduler } {
  const scheduler = new HostScheduler({ now: () => wall.now(), sleep: (ms, signal) => delay(clock, ms, signal).catch(() => undefined) }, sources);
  return { scheduler, now: () => wall.now(), policy: SOURCE_POLICY };
}

/** Each channel stops its own call at its time limit. This limit is the longest of them. */
const CALL_LIMIT = Math.max(PUSHOVER_TIMEOUT_MS, TWILIO_CALL_TIMEOUT_MS);

/**
 * The longest time of one fetch of a source of the instance: its interval, up to the shortest interval of the sources.
 * Thus the fetch of GFZ, with an interval of 10 minutes, does not hold the messages of the NWS for 10 minutes.
 */
export const INSTANCE_FETCH_LIMIT: (source: SourceDescriptor) => Duration = shortestFetchLimit(INSTANCE_SOURCES);

/**
 * The times of the loop of the instance. They come from the fetch limits of the sources and the time
 * limit of the Pushover channel. The host reads them before a start: the stop grace holds one pass.
 *
 * The stream of NWWS-OI has a shorter interval. It makes only the cap of the retry of its instance shorter, thus these
 * times stay a bound of the times of each instance.
 */
export const INSTANCE_TIMES: LoopTimes = loopTimes(INSTANCE_SOURCES, { delivery: { callLimit: CALL_LIMIT, retry: CALL_LIMIT }, fetchLimit: INSTANCE_FETCH_LIMIT });

/** The times of the delivery step of an instance. The fault cases of the channel use these times. */
export const DELIVERY_TIMES: Pick<DeliveryOptions, "pollEvery" | "retry" | "callLimit" | "flightLimit"> & { readonly overdueAfter: Duration } = {
  // A `life-safety` message repeats until the person acknowledges it. A poll at the pace of the repeats sees an acknowledgment in one repeat.
  pollEvery: PUSHOVER_REPEAT_MS,
  // A failed call goes again after the time limit of one call. Pushover asks for a wait of 5 seconds or more after a failure.
  retry: CALL_LIMIT,
  callLimit: CALL_LIMIT,
  // A send ends by the time limit of the channel. A second send of its key goes after its retry.
  flightLimit: CALL_LIMIT + CALL_LIMIT,
  // A send with no delivery two full tries after its due time makes the heartbeat fail: 140 s.
  overdueAfter: overdueLimit({ passLimit: INSTANCE_TIMES.passLimit, flightLimit: CALL_LIMIT + CALL_LIMIT, retry: CALL_LIMIT }),
};

/**
 * The default wait of each rank of a copy: 30 s. The table `rankDelay` of the configuration can give another wait for a level. A copy with rank 1 sends a step 30 s after the copy with rank 0. In that
 * time, the send of rank 0 ends, and its delivery comes to rank 1 by the exchange:
 *
 * - the flight limit of one send, 20 s
 * - one interval of the exchange, 5 s, and the time limit of one read, 3 s
 * - the largest difference of the clocks of the copies with no system line, 2 s.
 */
export const RANK_DELAY: Duration = DELIVERY_TIMES.flightLimit + EXCHANGE_EVERY + EXCHANGE_LIMIT + CLOCK_SKEW_LIMIT;

/**
 * The default least wait of each rank before a step of an exclusive channel, as a call: 31 s. A phone takes one call at
 * a time. Thus a copy with rank 1 calls only after the call of rank 0 is in its ledger. In the worst case:
 *
 * - rank 0 sees the incident one exchange after rank 1: one interval, 5 s, and one read, 3 s
 * - the send of rank 0 ends in the call limit, 10 s
 * - the delivery comes to rank 1 by the exchange: a read in progress misses it, thus two intervals and one read, 13 s.
 *
 * The field `rankFloor` of the configuration replaces it.
 */
export const RANK_FLOOR: Duration = DELIVERY_TIMES.callLimit + 3 * EXCHANGE_EVERY + 2 * EXCHANGE_LIMIT;

/**
 * This function gives the problems of a configuration that stop the start of the instance:
 *
 * - a missing token, or a token with a bad form
 * - some keys of Twilio and not all, or a key of Twilio with a bad form
 * - one key of the NWWS-OI account of the copy and not the other, or an account of the copy with no keys
 * - an id of a source with no account in the field `accounts` of the copy
 * - a step of a policy on a channel with no sender
 * - a step on a channel with a cost, when the configuration has no spend entry for its provider
 * - a place that no regional source covers. A source with the coverage `global` covers each place, with no code.
 * - an outage call with no keys of Twilio, no token `OUTAGE_TOKEN` or a bad list
 * - a setting of an unknown expectation, or a `since` after the time `at`.
 *
 * The message names ids, fields and the names of secrets, and no value.
 *
 * The function `parseConfig` checks the fields of each address with the descriptors of `INSTANCE_CHANNELS`.
 */
export function instanceProblems(parsed: ParsedConfig, secret: SecretLookup, descriptors: readonly SourceDescriptor[], at: Instant, copy: CopySettings = ONLY_COPY): string[] {
  const token = secret(PUSHOVER_TOKEN) ?? "";
  // A bad key fails each send. Thus it stops the start, before the first alert.
  const tokenProblems =
    token === ""
      ? [`The secret store has no value for ${PUSHOVER_TOKEN}, the API token of the Pushover application.`]
      : isPushoverKey(token)
        ? []
        : [`The value of ${PUSHOVER_TOKEN} is not a key of Pushover: 30 letters and digits.`];
  // Bad keys of Twilio fail each call. Thus they stop the start, before the first alert.
  const twilio = twilioSetup(secret);
  const twilioProblems = twilio.tag === "err" ? twilio.error : [];
  // A half of a key pair of NWWS-OI is a fault of the secret store, not a choice of no stream. Thus it stops the start.
  const nwws = nwwsSetup(secret, copy);
  const nwwsProblems = nwws.tag === "err" ? nwws.error : [];
  // A step on a channel with no sender fails each send of the step. Thus it stops the start.
  const senders = instanceSenders(secret);
  const senderProblems = parsed.recipients.flatMap((recipient) =>
    recipient.policies.flatMap((policy) =>
      policy.steps.flatMap((step, index) =>
        senders.includes(step.channel)
          ? []
          : [`Step ${index} of ${policy.level} of ${recipient.watch.person} uses the channel ${step.channel}, and the instance has no sender on it.`],
      ),
    ),
  );
  // A send on a channel with a cost needs a cap. Without it, a fault of a loop can spend all the money of the account.
  const used = new Set(parsed.recipients.flatMap((recipient) => recipient.policies.flatMap((policy) => policy.steps.map((step) => step.channel))));
  const spendProblems = INSTANCE_CHANNELS.flatMap((descriptor) =>
    senders.includes(descriptor.id) && used.has(descriptor.id) && (descriptor.costUsd ?? 0) > 0 && spendEntryOf(descriptor, parsed.config.spend) === undefined
      ? [`The channel ${descriptor.id} costs money, and the configuration has no spend entry for its provider. Give an entry with a monthly cap.`]
      : [],
  );
  // A place that no regional source covers gets no alert of its area. The usual cause is a missing code of a level.
  // A global source covers each place with no code, so it tells nothing about the codes of a place.
  const regional = descriptors.filter((descriptor) => descriptor.coverage !== "global");
  const kinds = [...new Set(regional.flatMap((descriptor) => descriptor.kinds))];
  const placeProblems = localPlaces(parsed.config).flatMap((place) =>
    regional.some((descriptor) => kinds.some((kind) => sourceCovers(descriptor, place, kind)))
      ? []
      : [`No regional source covers the place ${place.id}. Give the place its codes at each level: the NWS zone and county, SAME, the state and the country (iso3166).`],
  );
  // The outage call deploys at the start. A bad list or a missing key fails the deploy, so it stops the start.
  const outage = outageSetup(parsed, secret, twilio.tag === "ok" ? twilio.value : undefined);
  const outageProblems = outage.tag === "err" ? outage.error : [];
  return [
    ...tokenProblems,
    ...twilioProblems,
    ...nwwsProblems,
    ...accountProblems(copy),
    ...senderProblems,
    ...spendProblems,
    ...placeProblems,
    ...outageProblems,
    ...expectationProblems(parsed.config.expectations, INSTANCE_EXPECTATIONS, at),
  ];
}

/** This function gives the check of a configuration file for the instance of a copy: its channels and the problems that stop its start. */
export function instanceCheck(copy: CopySettings = ONLY_COPY): InstanceCheck {
  return { channels: INSTANCE_CHANNELS, problems: (parsed, secret) => instanceProblems(parsed, secret, INSTANCE_SOURCES, wallClock().now(), copy) };
}

/** The check of a configuration file for the instance of the only copy: `instanceCheck(ONLY_COPY)`. */
export const INSTANCE_CHECK: InstanceCheck = instanceCheck(ONLY_COPY);

/**
 * This function gives the check of the live instance of a copy, the profile `daemon`. It adds the key of the first
 * check of the copy to `instanceCheck(copy)`, because the live instance does not start without its heartbeat. A copy with
 * other copies also needs the token of the exchange.
 */
export function daemonCheck(copy: CopySettings): InstanceCheck {
  const pingKey = pingKeyOf(copy);
  const ping = requireKey(instanceCheck(copy), pingKey, "The live instance needs its outside heartbeat.");
  const check = (copy.peers ?? []).length === 0 ? ping : requireKey(ping, COPY_TOKEN_KEY, "A copy with other copies needs the token of the exchange.");
  // The copies share the loud check. A copy that pings it as its first check hides the stop of the other copies.
  if (pingKey !== LOUD_PING_URL_KEY) return check;
  const shared = `The file ${COPY_FILE}: pingKey is ${LOUD_PING_URL_KEY}, the key of the shared loud check. Each copy has its own first check.`;
  return { channels: check.channels, problems: (parsed, secret) => [...check.problems(parsed, secret), shared] };
}

/** The check of the live instance of the only copy: `daemonCheck(ONLY_COPY)`. */
export const DAEMON_CHECK: InstanceCheck = daemonCheck(ONLY_COPY);

/** The options of `openInstance`. */
export interface InstanceOptions {
  /** The private configuration and its recipients. The function `parseConfig` gives them with the channels `INSTANCE_CHANNELS`. */
  readonly config: ParsedConfig;
  /** The secret store of the instance. It gives the keys of the file `secrets.env`. */
  readonly secret: SecretLookup;
  readonly log: RuntimeLog;
  /** The monotonic clock of the service. The loop and the pace of the sources use it. */
  readonly clock: Clock;
  /**
   * The wall clock. It gives each instant. The instance makes a frame clock on it and `clock`, and each part of the
   * instance reads that frame clock. Thus the runtime follows each step of the wall clock.
   */
  readonly wall: WallClock;
  /** The transport of the requests of the sources. A test gives a transport with faults. */
  readonly transport: Transport;
  /**
   * The function that opens a session of the NWWS-OI source. The default is the XMPP session of the source. A test
   * gives a fake session. The instance has the source only when the secrets have the keys of the account of the copy.
   */
  readonly nwwsOpen?: OpenSession;
  /** The fetch of the Pushover channel. */
  readonly pushover: PushoverChannelOptions["fetch"];
  /**
   * The gate of the monthly messages of the Pushover application. The entry gives it a store in a file,
   * thus the count holds across a restart. With no gate, the channel counts nothing.
   */
  readonly pushoverQuota?: PushoverChannelOptions["quota"];
  /** The gate of the Pushover messages that tell of the entry into the reserve: one in each window. */
  readonly pushoverReserveNotices?: PushoverChannelOptions["reserveNotices"];
  /**
   * The fetch of the Twilio call channel and of the read of the balance of the account. The instance needs it when the
   * secrets have the keys of Twilio.
   */
  readonly twilio?: TwilioFetch;
  /**
   * The store of the counts of the caps of the spend. The entry gives the file `quotas.sqlite`, thus a count holds
   * across a restart. The instance needs it when a channel with a sender has a spend entry.
   */
  readonly spendStore?: QuotaStore;
  /** The id of this run. Each start of the process has a new id. */
  readonly run: string;
  /** The settings of this copy of the system. The default is `ONLY_COPY`, with rank 0. A copy waits its rank times `RANK_DELAY` before each send. */
  readonly copy?: CopySettings;
  /**
   * The exchange with the other copies: the call over HTTP (`exchangeCall`) and the hash of the configuration (`configHash`
   * of the core). Without it, the instance has no worker of the exchange. The entry refuses a copy with other copies and no token.
   */
  readonly exchange?: InstanceExchange;
  /** The instance gives each round of the worker of the exchange to this function. */
  readonly onExchange?: (round: ExchangeRound) => void;
  /** The runtime starts this hook at the end of each pass with no error. */
  readonly onPass?: (pass: Pass) => void | Promise<void>;
  /** The loop gives each failed pass to this function. */
  readonly onError?: (error: unknown, failures: number) => void;
  /**
   * This function gives the longest time of one fetch of a source. The default is `INSTANCE_FETCH_LIMIT`. A test with a
   * fake clock gives a long limit, because a slow runner moves the fake clock during a fetch.
   */
  readonly fetchLimit?: RuntimeOptions["fetchLimit"];
  /**
   * The cache of the store of shapes: the outlines of the NWS zones for the map. Without it, the instance gets no outline, and the
   * map has no region. The entry gives the file `shapes.sqlite` of the private folder. The instance closes it at `shapes.close()`.
   */
  readonly shapes?: ShapeCache;
  /** The instance gives each refresh of the outlines to this function. */
  readonly onShapes?: (outcome: ShapeOutcome) => void;
  /**
   * The store of the indicator readings. The entry gives the file `readings.sqlite` of the private folder, and the service
   * closes it. Without it, the instance keeps no reading.
   */
  readonly readings?: RuntimeOptions["readings"];
  /** The instance gives each fault of the store of the readings to this function. */
  readonly onReadingsFault?: RuntimeOptions["onReadingsFault"];
  /**
   * The instance starts this function one time, when new outlines change the codes of a place. The check is after a refresh
   * with requests, when no task is due. The entry of the profile `daemon` stops the runtime, and the supervisor starts it again.
   */
  readonly onPlaceCodes?: () => void;
  /** The worker of the deploy of the outage call gives each failed deploy to this function. */
  readonly onOutageError?: (error: unknown, failures: number) => void;
  /** The worker of the deploy of the outage call gives a line to this function for each deploy that changed the Functions. */
  readonly onOutageLog?: (line: string) => void;
}

/** The parts of the exchange that the entry gives to the instance. */
export interface InstanceExchange {
  /** The call of the procedure `alerts.log.entries` of another copy. */
  readonly call: ExchangeCall;
  /** The hash of the configuration of this copy. */
  readonly configHash: string;
}

/** The exchange of an instance with the other copies. */
export interface InstanceCopies {
  /** The parts of the runtime that serve the procedure `alerts.log.entries` to the other copies. */
  readonly source: EntriesSource;
  /** The worker that reads each other copy. A copy with no other copies has none. */
  readonly worker?: ExchangeWorker;
  /** The loop of the worker. The service operates it as the worker `EXCHANGE_WORKER` of `index.ts`. */
  readonly loop?: WorkerLoop;
}

/** The instance: the runtime, its loop and the outlines of the regions. */
export interface Instance {
  readonly runtime: Runtime;
  readonly loop: RuntimeLoop;
  /** The outlines of the regions. The match by shape and the map route read them here. */
  readonly shapes: InstanceShapes;
  /** The counts of the zone codes of the places at the start, from the outlines of the store. An instance with no store has none. */
  readonly zones?: ZoneCodeCounts;
  /** This function gives the state of each quota of the channels. Each call reads the stores of the gates. */
  readonly quotas: () => readonly ChannelQuota[];
  /** The watches of the balances of the paid provider accounts. */
  readonly balances: readonly BalanceWatch[];
  /** The watch of the STOP and START replies of the texts, when the instance has the text channel and an opt-in list. */
  readonly replies?: ReplyWatch;
  /** The watch of the spend that Twilio reports for the month of the cap, when the configuration has a spend entry for Twilio. */
  readonly spend?: SpendWatch;
  /**
   * This function gives the map payload of the last pass: the live incidents with the level of each person, the places and
   * the basemap. The first read after a change of the store simplifies the basemap of the watched states.
   */
  readonly map: () => MapPayload;
  /**
   * This function gives the health payload. The sources, the lateness and the coverage come from the last pass. The copies,
   * the quotas and the balances are at the time of the read.
   */
  readonly health: () => HealthPayload;
  /**
   * This function gives the history payload of the merge state: the changes of each incident at each time of entry on this
   * copy. The value `since` keeps only the incidents with a change at that time or later.
   */
  readonly history: (since: Instant | null) => HistoryPayload;
  /** The worker of the deploy of the outage call, when the configuration has an outage call. The service declares it. */
  readonly outage?: OutageDeployWorker;
  /** The exchange with the other copies, when the options give it. */
  readonly copies?: InstanceCopies;
}

/**
 * This function makes the instance. It throws when the configuration or the secret store has a
 * problem. A problem is a missing token, a key with a bad form, or a place that no regional source covers.
 * The message names ids, fields and the names of secrets, and no value.
 *
 * - The sources are the NWS API, IPAWS, the USGS, EMSC, the two tsunami warning centers, the SWPC and GFZ. The stream of
 *   NWWS-OI is a source when the secrets have the keys of the account of the copy (`nwwsSetup`). Each source gets the
 *   codes of the places. It gets the position of a place only when the place shares it with that source. The USGS,
 *   EMSC, the centers, the SWPC and GFZ ask for no place.
 * - The channels are Pushover, and the Twilio call channel when the secrets have its keys. Each time of the delivery comes
 *   from a fact of the channels.
 * - A spend entry of a channel gives its cap and the watch of the balance of its account.
 * - The times of the loop come from the limits of the runtime.
 */
export function openInstance(options: InstanceOptions): Instance {
  const { clock } = options;
  // A change of the wall clock of CLOCK_STEP_ABOVE or less is a drift. A larger change is a step of the clock.
  const wall = frameClock(options.wall, clock, { driftLimit: CLOCK_STEP_ABOVE });
  const factories = [createNwsSource, createIpawsSource, createUsgsSource, createEmscSource, ...TSUNAMI.map((center) => tsunamiFactory(center)), createSwpcSource, createGfzSource] as const;
  const pace = sourcePace(clock, wall, factories.length);
  // One User-Agent for each request of the instance: the sources and the store of shapes.
  const agent = userAgent(options.config.config.contact);
  const polled = factories.map((make) => make({ pace, transport: options.transport, userAgent: agent }));
  // The stream of NWWS-OI sends no request over HTTP, thus it has no pace. Its first fetch opens its session.
  const copy = options.copy ?? ONLY_COPY;
  const account = nwwsSetup(options.secret, copy);
  const stream =
    account.tag === "ok" && account.value !== undefined
      ? createNwwsSource({ account: account.value, clock: wall, ...(options.nwwsOpen === undefined ? {} : { open: options.nwwsOpen }) })
      : undefined;
  const sources: readonly SourceProcedures[] = stream === undefined ? polled : [...polled, stream];

  const descriptors = sources.map((source) => source.describe());
  const kinds = [...new Set(descriptors.flatMap((descriptor) => descriptor.kinds))];

  const { config, recipients } = options.config;
  const problems = instanceProblems(options.config, options.secret, descriptors, wall.now(), copy);
  if (problems.length > 0) throw new Error(`The instance does not start. The configuration has these problems:\n- ${problems.join("\n- ")}`);
  const token = options.secret(PUSHOVER_TOKEN) ?? "";

  // The store of shapes shares the pace of the sources. Thus its requests to the NWS API keep the rests of that host.
  const store = options.shapes === undefined ? undefined : createShapeStore({ pace, transport: options.transport, userAgent: agent, cache: options.shapes });
  const cache = options.shapes;
  // The places get the codes of the zones near their positions, from the outlines of the store at the start.
  const zoned = (from: ShapeStore) => addZoneCodes(config, (state) => from.basemap(state));
  const start = store === undefined ? undefined : zoned(store);
  const placed = start?.config ?? config;
  const places = localPlaces(placed);
  // New outlines can change the codes of a place. The check is after a refresh with requests, when no task is due.
  const opened = placeCodesKey(placed);
  let fresh = false;
  let told = false;
  const checkCodes = (outcome: ShapeOutcome): void => {
    if (store === undefined || told || !outcome.ok) return;
    if (outcome.refreshed.requests > 0) fresh = true;
    if (!fresh || outcome.refreshed.stop !== "done") return;
    fresh = false;
    if (placeCodesKey(zoned(store).config) === opened) return;
    told = true;
    options.onPlaceCodes?.();
  };
  const onShapes = (outcome: ShapeOutcome): void => {
    try {
      checkCodes(outcome);
    } finally {
      options.onShapes?.(outcome);
    }
  };
  const shapes = keepShapes({ store, places, onShapes, close: () => cache?.close() });

  const pushover = createPushoverChannel({
    token,
    fetch: options.pushover,
    now: () => wall.now(),
    ...(options.pushoverQuota === undefined ? {} : { quota: options.pushoverQuota }),
    ...(options.pushoverReserveNotices === undefined ? {} : { reserveNotices: options.pushoverReserveNotices }),
  });
  const twilio = twilioChannel(options, config.spend, options.config.optIn);
  // The worker of the exchange reads the runtime only in its rounds, after the start of the service. Thus it gets the runtime through a function.
  const peers = copy.peers ?? [];
  const worker =
    peers.length === 0 || options.exchange === undefined
      ? undefined
      : exchangeWorker({
          runtime: { position: (id) => runtime.position(id), take: (page) => runtime.take(page) },
          peers,
          call: options.exchange.call,
          clock: wall,
          configHash: options.exchange.configHash,
        });
  const quotas = (): readonly ChannelQuota[] => [
    ...(options.pushoverQuota === undefined ? [] : [channelQuota(CHANNEL_ID, options.pushoverQuota)]),
    ...(twilio?.gates === undefined ? [] : [channelQuota(TWILIO_CHANNEL, twilio.gates.gate, SPEND_UNIT)]),
  ];
  const balances = twilio?.watch === undefined ? [] : [twilio.watch];
  const replies = twilio?.replies;
  const spent = twilio?.spend;
  const reads = [...(replies === undefined ? [] : [replies]), ...(spent === undefined ? [] : [spent])];
  // The text channel takes its units from the gates of the call channel. Thus the quota of the call channel counts the texts too.
  const channels = twilio === undefined ? [pushover] : [pushover, twilio.channel, ...(twilio.text === undefined ? [] : [twilio.text])];
  // The labels of the places go only into the why line of each message. The policy of the configuration replaces the default policy of the core.
  const delivery: DeliveryOptions = {
    recipients,
    channels,
    labels: placeLabels(placed),
    ...(config.assess === undefined ? {} : { assess: config.assess }),
    ...DELIVERY_TIMES,
    rank: copy.rank,
    rankDelay: RANK_DELAY,
    ...(config.rankDelay === undefined ? {} : { rankDelays: config.rankDelay }),
    rankFloor: config.rankFloor ?? RANK_FLOOR,
  };

  // The last pass of the runtime, from the loop or from a direct call of `pass`. The map reads it.
  let latest: Pass | undefined;
  const runtime: Runtime = openRuntime({
    log: options.log,
    clock: wall,
    sources,
    watch: (source) => ({ places: sourcePlaces(placed, source.id) }),
    view: {
      places,
      kinds,
      expectations: configuredExpectations(INSTANCE_EXPECTATIONS, config.expectations),
      delay: DELAY_LIMITS,
      ...(config.link === undefined ? {} : { link: config.link }),
    },
    run: options.run,
    copy: copy.id,
    delivery,
    // The drills of the live paths that this copy starts (AL-43). Each person keeps the quiet window of the configuration.
    drills: copyDrills(config.drills ?? [], recipients, copy.id, copy.rank),
    // The loop exists before the first pass, and only a pass starts a wake.
    wake: () => loop.wake(),
    // Each stage of a quota is a line of system reports, and so is each stage of a balance.
    quotas,
    balances,
    // Each pass reads the replies of the texts and the spend of Twilio when each read is due.
    ...(reads.length === 0 ? {} : { reads }),
    // Each pass waits for the first round of the exchange, and its view has a line for each fault of another copy.
    ...(worker === undefined ? {} : { copies: worker }),
    // The readings of each fetch go to their store, not to the log.
    ...(options.readings === undefined ? {} : { readings: options.readings }),
    ...(options.onReadingsFault === undefined ? {} : { onReadingsFault: options.onReadingsFault }),
    // After each pass, the store of shapes gets the outlines that are due, and it ends before the next fetch of a source.
    onPass: async (pass) => {
      latest = pass;
      shapes.afterPass(pass.view.incidents, earliest(runtime.config.sources.map((descriptor) => nextFetch(runtime.state(), descriptor))));
      await options.onPass?.(pass);
    },
    fetchLimit: options.fetchLimit ?? INSTANCE_FETCH_LIMIT,
  });
  const loop = createLoop({
    pass: (stop) => runtime.pass(stop),
    clock,
    wall,
    times: loopTimes(runtime.config.sources, { delivery, fetchLimit: INSTANCE_FETCH_LIMIT }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  // The map assesses each live incident with the policy of the delivery. Thus the level on the map is the level of the person.
  const people = recipients.map((recipient) => recipient.watch);
  const map = (): MapPayload => {
    return mapPayload({
      at: latest?.at ?? null,
      incidents: latest?.view.incidents ?? [],
      coverage: latest?.view.coverage ?? [],
      people,
      places: placed.places,
      ...(delivery.assess === undefined ? {} : { policy: delivery.assess }),
      shape: shapes.lookup,
      basemap: shapes.basemap(),
    });
  };
  // The health reads the view of the last pass. The watches of the copies and of the balances are at the time of the read.
  const health = (): HealthPayload =>
    healthPayload({
      at: latest?.at ?? null,
      now: wall.now(),
      sources: latest?.view.health ?? [],
      lateness: latest?.view.lateness ?? [],
      coverage: latest?.view.coverage ?? [],
      copies: worker?.watches() ?? [],
      quotas: quotas(),
      balances: balances.flatMap((watch) => watch.balance() ?? []),
      reads: reads.map((watch) => watch.health()),
    });
  // The history reads the merge state at the time of the read, with the link rule of the view and the delivery.
  const link = linkRule(runtime.config.link ?? DEFAULT_LINK_POLICY);
  const history = (since: Instant | null): HistoryPayload =>
    historyPayload({
      at: latest?.at ?? null,
      since,
      merge: runtime.state().merge,
      entered: runtime.entered(),
      people,
      places: placed.places,
      ...(delivery.assess === undefined ? {} : { policy: delivery.assess }),
      shape: shapes.lookup,
      link,
    });
  // A round that imports an event or changes the stage of a copy starts a pass soon.
  const rounds =
    worker === undefined
      ? undefined
      : exchangeLoop({
          worker,
          clock,
          onRound: (round) => {
            if (round.changed) loop.wake();
            options.onExchange?.(round);
          },
        });
  const copies: InstanceCopies | undefined =
    options.exchange === undefined
      ? undefined
      : { source: { runtime, clock: wall, configHash: options.exchange.configHash }, ...(worker === undefined || rounds === undefined ? {} : { worker, loop: rounds }) };
  const outage = outageWorker(options, loop.times.passLimit);
  return {
    runtime,
    loop,
    shapes,
    ...(start === undefined ? {} : { zones: start.counts }),
    quotas,
    balances,
    ...(replies === undefined ? {} : { replies }),
    ...(spent === undefined ? {} : { spend: spent }),
    map,
    health,
    history,
    ...(outage === undefined ? {} : { outage }),
    ...(copies === undefined ? {} : { copies }),
  };
}

/**
 * This function makes the worker of the deploy of the outage call when the configuration has an outage call. The function
 * `instanceProblems` checked the setup before. The bound of one deploy is the pass limit, because the drain holds it.
 */
function outageWorker(options: InstanceOptions, limit: Duration): OutageDeployWorker | undefined {
  const twilio = twilioSetup(options.secret);
  const setup = outageSetup(options.config, options.secret, twilio.tag === "ok" ? twilio.value : undefined);
  if (setup.tag === "err" || setup.value === undefined) return undefined;
  const fetch = options.twilio;
  if (fetch === undefined) throw new Error("The configuration has an outage call, and the instance has no fetch for the requests of Twilio.");
  const log = options.onOutageLog;
  return outageDeployWorker({
    deploy: outageDeploy(setup.value, { fetch, clock: options.clock, ...(log === undefined ? {} : { log }) }),
    clock: options.clock,
    wall: options.wall,
    limit,
    ...(log === undefined ? {} : { log }),
    ...(options.onOutageError === undefined ? {} : { onError: options.onOutageError }),
  });
}

/** The Twilio channels of an instance: the call channel and the text channel. Also the gates of the spend, the watch of the balance, the watch of the spend and the watch of the replies. */
interface TwilioParts {
  readonly channel: ChannelProcedures;
  /** The text channel, when the secrets have the number of the texts. */
  readonly text?: ChannelProcedures;
  readonly gates?: SpendGates;
  readonly watch?: BalanceWatch;
  readonly replies?: ReplyWatch;
  readonly spend?: SpendWatch;
}

/**
 * This function makes the Twilio channels when the secrets have their keys. The function `instanceProblems` checked the keys before.
 * A spend entry gives one cap of the two channels and the watch of the balance. Its floor is in the currency of the account.
 */
function twilioChannel(options: InstanceOptions, spend: readonly SpendConfig[] | undefined, records: readonly OptInRecord[]): TwilioParts | undefined {
  const setup = twilioSetup(options.secret);
  if (setup.tag === "err" || setup.value === undefined) return undefined;
  const { credentials, from, textFrom } = setup.value;
  const fetch = options.twilio;
  if (fetch === undefined) throw new Error("The secret store has the keys of Twilio, and the instance has no fetch for the call channel.");
  const now = (): number => options.wall.now();
  const entry = spendEntryOf(twilioCallDescriptor(), spend);
  // The text channel sends only to a number of the opt-in list. The watch of the replies gives the STOP and START replies,
  // and the STOP blocks of Twilio until its next read. With no opt-in list, the channel sends no text.
  const replies =
    textFrom === undefined || records.length === 0
      ? undefined
      : replyWatch({ records, read: (since, signal) => readTwilioReplies({ credentials, fetch, to: textFrom, since }, signal) });
  const optIn: TextOptIn = replies?.optIn ?? { has: (number, at) => optedIn(records, [], number, at), stopped: () => undefined };
  const watched = replies === undefined ? {} : { replies };
  // The text channel takes the gates of the call channel, with the units of one text.
  const text = (gates?: SpendGates): { readonly text?: ChannelProcedures } =>
    textFrom === undefined
      ? {}
      : { text: createTwilioTextChannel({ credentials, from: textFrom, fetch, now, optIn, ...(gates === undefined ? {} : { spend: { ...gates, units: spendUnits(TWILIO_TEXT_COST_USD) } }) }) };
  if (entry === undefined) return { channel: createTwilioCallChannel({ credentials, from, fetch, now }), ...text(), ...watched };
  const store = options.spendStore;
  if (store === undefined) throw new Error(`The configuration has a spend entry for ${entry.provider}, and the instance has no store for its count.`);
  // The key names the provider, not the account SID.
  const gates = spendGates(spendQuota({ name: "Twilio spend", ...entry }), { key: `${entry.provider}:spend`, store, now });
  const watch = balanceWatch({
    provider: entry.provider,
    title: "Twilio",
    channels: textFrom === undefined ? [TWILIO_CHANNEL] : [TWILIO_CHANNEL, TEXT_CHANNEL_ID],
    floor: entry.floor,
    read: (signal) => readTwilioBalance({ credentials, fetch }, signal),
  });
  // The watch of the spend adds the other usage of the account to the count of the gates (AL-57).
  const spent = spendWatch({ provider: entry.provider, gates, timeZone: entry.timeZone, read: (start, signal) => readTwilioSpend({ credentials, fetch, from: start, to: now() }, signal) });
  const channel = createTwilioCallChannel({ credentials, from, fetch, now, spend: { ...gates, units: spendUnits(TWILIO_CALL_COST_USD) } });
  return { channel, gates, watch, spend: spent, ...text(gates), ...watched };
}
