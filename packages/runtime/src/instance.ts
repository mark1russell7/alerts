/**
 * This module makes the instance of the owner from the private configuration. The instance has the
 * sources, the Pushover channel, the Twilio call channel, the runtime and its loop. The entry `main.ts` reads the files, and it gives the
 * clocks and the transports. This module reads no file, no environment variable and no clock.
 */
import { delay, wallClock, type Clock, type WallClock } from "@mark1russell7/algebra/clock";
import {
  configuredExpectations,
  expectationProblems,
  localPlaces,
  ONLY_COPY,
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
  type Instant,
  type ParsedConfig,
  type SecretLookup,
  type SourceDescriptor,
  type SourceProcedures,
  type SpendConfig,
} from "@mark1russell7/alerts";
import {
  CHANNEL_ID as TWILIO_CHANNEL,
  createTwilioCallChannel,
  readTwilioBalance,
  TWILIO_CALL_COST_USD,
  TWILIO_CALL_TIMEOUT_MS,
  twilioCallDescriptor,
  twilioSetupProblems,
  type TwilioCredentials,
  type TwilioFetch,
} from "@mark1russell7/alerts-channel-twilio";
import { CHANNEL_ID, createPushoverChannel, isPushoverKey, pushoverDescriptor, PUSHOVER_REPEAT_MS, PUSHOVER_TIMEOUT_MS, type PushoverChannelOptions } from "@mark1russell7/alerts-channel-pushover";
import { createEmscSource, EMSC_DESCRIPTOR } from "@mark1russell7/alerts-source-emsc";
import { createIpawsSource, IPAWS_DESCRIPTOR, WEA_EXPECTATION } from "@mark1russell7/alerts-source-ipaws";
import { createShapeStore, type ShapeCache, type ShapeStore } from "@mark1russell7/alerts-shapes-nws";
import { createNwsSource, NWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nws-api";
import { createTsunamiSource, descriptorOf as tsunamiDescriptor, TSUNAMI_CENTERS, type TsunamiCenter, type TsunamiFetchOptions } from "@mark1russell7/alerts-source-tsunami";
import { createUsgsSource, USGS_DESCRIPTOR } from "@mark1russell7/alerts-source-usgs";
import { err, ok, type Result } from "@mark1russell7/optional";
import type { Pace, QuotaStore, Transport } from "polite-crawler/api";
import { DEFAULT_POLICY, HostScheduler, type PolitenessPolicy } from "polite-crawler/politeness";
import { balanceWatch, SPEND_UNIT, spendGates, spendQuota, spendUnits, type BalanceWatch, type SpendGates } from "./balance.ts";
import { parseSecrets, requireKey, SECRETS_FILE, type FileText, type InstanceCheck } from "./config.ts";
import { CLOCK_SKEW_LIMIT, COPY_FILE, COPY_TOKEN_KEY, EXCHANGE_EVERY, EXCHANGE_LIMIT } from "./copy.ts";
import { overdueLimit, type DeliveryOptions } from "./delivery.ts";
import { frameClock } from "./frame.ts";
import type { RuntimeLog } from "./log.ts";
import { createLoop, loopTimes, type LoopTimes, type RuntimeLoop } from "./loop.ts";
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
export const INSTANCE_CHANNELS: readonly ChannelDescriptor[] = [pushoverDescriptor(), twilioCallDescriptor()];

/**
 * The names of the keys of `secrets.env` for the Twilio call channel. The secret is the secret of an API key
 * of the account, not the auth token of the account.
 */
export const TWILIO_KEYS = { accountSid: "TWILIO_ACCOUNT_SID", keySid: "TWILIO_API_KEY_SID", secret: "TWILIO_API_KEY_SECRET", from: "TWILIO_FROM" } as const;

/** The setup of the Twilio call channel: the credentials of the account and the number that calls. */
export interface TwilioSetup {
  readonly credentials: TwilioCredentials;
  readonly from: string;
}

/**
 * This function gives the setup of the Twilio call channel from the secrets.
 *
 * - With none of the keys of `TWILIO_KEYS`, it gives `undefined`. The instance then has no call channel.
 * - With some keys and not all, or with a value of a bad form, it gives the problems. A problem names keys, and no value.
 */
export function twilioSetup(secret: SecretLookup): Result<TwilioSetup | undefined, readonly string[]> {
  const value = (name: string): string => secret(name) ?? "";
  const names = Object.values(TWILIO_KEYS);
  const missing = names.filter((name) => value(name) === "");
  if (missing.length === names.length) return ok(undefined);
  if (missing.length > 0) return err([`The secret store has some keys of Twilio, and it has no value for ${missing.join(", ")}. Give all the keys, or none.`]);
  const setup: TwilioSetup = {
    credentials: { accountSid: value(TWILIO_KEYS.accountSid), keySid: value(TWILIO_KEYS.keySid), secret: value(TWILIO_KEYS.secret) },
    from: value(TWILIO_KEYS.from),
  };
  const problems = twilioSetupProblems(setup.credentials, setup.from);
  return problems.length === 0 ? ok(setup) : err(problems.map((problem) => `The keys of Twilio have a problem: ${problem}`));
}

/**
 * This function gives the channels that the instance sends on: Pushover, and the Twilio call channel when the secrets have
 * its keys. A step on another channel of `INSTANCE_CHANNELS` stops the start.
 */
export function instanceSenders(secret: SecretLookup): readonly ChannelId[] {
  const twilio = twilioSetup(secret);
  return twilio.tag === "ok" && twilio.value !== undefined ? [CHANNEL_ID, TWILIO_CHANNEL] : [CHANNEL_ID];
}

/**
 * This function gives the spend entry of a channel with a cost: the first entry for a provider in the `dependsOn` of the
 * channel. The cap of the entry counts each send of the channel.
 */
export function spendEntryOf(descriptor: ChannelDescriptor, spend: readonly SpendConfig[] | undefined): SpendConfig | undefined {
  return spend?.find((entry) => descriptor.dependsOn.includes(entry.provider));
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
 * The two tsunami warning centers give the tsunami messages.
 */
export const INSTANCE_SOURCES: readonly SourceDescriptor[] = [NWS_DESCRIPTOR, IPAWS_DESCRIPTOR, USGS_DESCRIPTOR, EMSC_DESCRIPTOR, ...TSUNAMI.map((center) => tsunamiDescriptor(center))];

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
 * The times of the loop of the instance. They come from the intervals of the sources and the time
 * limit of the Pushover channel. The host reads them before a start: the stop grace holds one pass.
 */
export const INSTANCE_TIMES: LoopTimes = loopTimes(INSTANCE_SOURCES, { delivery: { callLimit: CALL_LIMIT, retry: CALL_LIMIT } });

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
 * The wait of each rank of a copy: 30 s. A copy with rank 1 sends a step 30 s after the copy with rank 0. In that
 * time, the send of rank 0 ends, and its delivery comes to rank 1 by the exchange:
 *
 * - the flight limit of one send, 20 s
 * - one interval of the exchange, 5 s, and the time limit of one read, 3 s
 * - the largest difference of the clocks of the copies with no system line, 2 s.
 */
export const RANK_DELAY: Duration = DELIVERY_TIMES.flightLimit + EXCHANGE_EVERY + EXCHANGE_LIMIT + CLOCK_SKEW_LIMIT;

/**
 * This function gives the problems of a configuration that stop the start of the instance:
 *
 * - a missing token, or a token with a bad form
 * - some keys of Twilio and not all, or a key of Twilio with a bad form
 * - a step of a policy on a channel with no sender
 * - a step on a channel with a cost, when the configuration has no spend entry for its provider
 * - a place that no source covers
 * - a setting of an unknown expectation, or a `since` after the time `at`.
 *
 * The message names ids, fields and the names of secrets, and no value.
 *
 * The function `parseConfig` checks the fields of each address with the descriptors of `INSTANCE_CHANNELS`.
 */
export function instanceProblems(parsed: ParsedConfig, secret: SecretLookup, descriptors: readonly SourceDescriptor[], at: Instant): string[] {
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
  // A place that no source covers gets no alert. The usual cause is a missing code of a level.
  const kinds = [...new Set(descriptors.flatMap((descriptor) => descriptor.kinds))];
  const placeProblems = localPlaces(parsed.config).flatMap((place) =>
    descriptors.some((descriptor) => kinds.some((kind) => sourceCovers(descriptor, place, kind)))
      ? []
      : [`No source covers the place ${place.id}. Give the place its codes at each level: the NWS zone and county, SAME, the state and the country (iso3166).`],
  );
  return [...tokenProblems, ...twilioProblems, ...senderProblems, ...spendProblems, ...placeProblems, ...expectationProblems(parsed.config.expectations, INSTANCE_EXPECTATIONS, at)];
}

/** The check of a configuration file for the live instance: its channels and the problems that stop its start. */
export const INSTANCE_CHECK: InstanceCheck = {
  channels: INSTANCE_CHANNELS,
  problems: (parsed, secret) => instanceProblems(parsed, secret, INSTANCE_SOURCES, wallClock().now()),
};

/**
 * This function gives the check of the live instance of a copy, the profile `daemon`. It adds the key of the first
 * check of the copy to `INSTANCE_CHECK`, because the live instance does not start without its heartbeat. A copy with
 * other copies also needs the token of the exchange.
 */
export function daemonCheck(copy: CopySettings): InstanceCheck {
  const pingKey = pingKeyOf(copy);
  const ping = requireKey(INSTANCE_CHECK, pingKey, "The live instance needs its outside heartbeat.");
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
  /** The runtime starts this hook at the end of each pass with no error. */
  readonly onPass?: (pass: Pass) => void | Promise<void>;
  /** The loop gives each failed pass to this function. */
  readonly onError?: (error: unknown, failures: number) => void;
  /**
   * This function gives the longest time of one fetch of a source. The default is the interval of the
   * source. A test with a fake clock gives a long limit, because a slow runner moves the fake clock during a fetch.
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
   * The instance starts this function one time, when new outlines change the codes of a place. The check is after a refresh
   * with requests, when no task is due. The entry of the profile `daemon` stops the runtime, and the supervisor starts it again.
   */
  readonly onPlaceCodes?: () => void;
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
}

/**
 * This function makes the instance. It throws when the configuration or the secret store has a
 * problem. A problem is a missing token, a key with a bad form, or a place that no source covers.
 * The message names ids, fields and the names of secrets, and no value.
 *
 * - The sources are the NWS API, IPAWS, the USGS, EMSC and the two tsunami warning centers. Each source gets the codes of
 *   the places. It gets the position of a place only when the place shares it with that source. The USGS, EMSC and the
 *   centers ask for no place.
 * - The channels are Pushover, and the Twilio call channel when the secrets have its keys. Each time of the delivery comes
 *   from a fact of the channels.
 * - A spend entry of a channel gives its cap and the watch of the balance of its account.
 * - The times of the loop come from the limits of the runtime.
 */
export function openInstance(options: InstanceOptions): Instance {
  const { clock } = options;
  const wall = frameClock(options.wall, clock);
  const factories = [createNwsSource, createIpawsSource, createUsgsSource, createEmscSource, ...TSUNAMI.map((center) => tsunamiFactory(center))] as const;
  const pace = sourcePace(clock, wall, factories.length);
  // One User-Agent for each request of the instance: the sources and the store of shapes.
  const agent = userAgent(options.config.config.contact);
  const sources = factories.map((make) => make({ pace, transport: options.transport, userAgent: agent }));

  const descriptors = sources.map((source) => source.describe());
  const kinds = [...new Set(descriptors.flatMap((descriptor) => descriptor.kinds))];

  const { config, recipients } = options.config;
  const problems = instanceProblems(options.config, options.secret, descriptors, wall.now());
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
  const twilio = twilioChannel(options, config.spend);
  const quotas = (): readonly ChannelQuota[] => [
    ...(options.pushoverQuota === undefined ? [] : [channelQuota(CHANNEL_ID, options.pushoverQuota)]),
    ...(twilio?.gates === undefined ? [] : [channelQuota(TWILIO_CHANNEL, twilio.gates.gate, SPEND_UNIT)]),
  ];
  const balances = twilio?.watch === undefined ? [] : [twilio.watch];
  const channels = twilio === undefined ? [pushover] : [pushover, twilio.channel];
  // The labels of the places go only into the why line of each message. The policy of the configuration replaces the default policy of the core.
  const delivery: DeliveryOptions = {
    recipients,
    channels,
    labels: placeLabels(placed),
    ...(config.assess === undefined ? {} : { assess: config.assess }),
    ...DELIVERY_TIMES,
    rank: (options.copy ?? ONLY_COPY).rank,
    rankDelay: RANK_DELAY,
  };

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
    copy: (options.copy ?? ONLY_COPY).id,
    delivery,
    // The loop exists before the first pass, and only a pass starts a wake.
    wake: () => loop.wake(),
    // Each stage of a quota is a line of system reports, and so is each stage of a balance.
    quotas,
    balances,
    // After each pass, the store of shapes gets the outlines that are due, and it ends before the next fetch of a source.
    onPass: async (pass) => {
      shapes.afterPass(pass.view.incidents, earliest(runtime.config.sources.map((descriptor) => nextFetch(runtime.state(), descriptor))));
      await options.onPass?.(pass);
    },
    ...(options.fetchLimit === undefined ? {} : { fetchLimit: options.fetchLimit }),
  });
  const loop = createLoop({
    pass: (stop) => runtime.pass(stop),
    clock,
    wall,
    times: loopTimes(runtime.config.sources, { delivery }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return { runtime, loop, shapes, ...(start === undefined ? {} : { zones: start.counts }), quotas, balances };
}

/** The Twilio call channel of an instance, its gates of the spend and the watch of its balance. */
interface TwilioParts {
  readonly channel: ChannelProcedures;
  readonly gates?: SpendGates;
  readonly watch?: BalanceWatch;
}

/**
 * This function makes the Twilio call channel when the secrets have its keys. The function `instanceProblems` checked the
 * keys before. A spend entry gives the cap and the watch of the balance. Its floor is in the currency of the account.
 */
function twilioChannel(options: InstanceOptions, spend: readonly SpendConfig[] | undefined): TwilioParts | undefined {
  const setup = twilioSetup(options.secret);
  if (setup.tag === "err" || setup.value === undefined) return undefined;
  const { credentials, from } = setup.value;
  const fetch = options.twilio;
  if (fetch === undefined) throw new Error("The secret store has the keys of Twilio, and the instance has no fetch for the call channel.");
  const now = (): number => options.wall.now();
  const entry = spendEntryOf(twilioCallDescriptor(), spend);
  if (entry === undefined) return { channel: createTwilioCallChannel({ credentials, from, fetch, now }) };
  const store = options.spendStore;
  if (store === undefined) throw new Error(`The configuration has a spend entry for ${entry.provider}, and the instance has no store for its count.`);
  // The key names the provider, not the account SID.
  const gates = spendGates(spendQuota({ name: "Twilio spend", ...entry }), { key: `${entry.provider}:spend`, store, now });
  const watch = balanceWatch({
    provider: entry.provider,
    title: "Twilio",
    channels: [TWILIO_CHANNEL],
    floor: entry.floor,
    read: (signal) => readTwilioBalance({ credentials, fetch }, signal),
  });
  const channel = createTwilioCallChannel({ credentials, from, fetch, now, spend: { ...gates, units: spendUnits(TWILIO_CALL_COST_USD) } });
  return { channel, gates, watch };
}
