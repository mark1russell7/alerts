/**
 * This module makes the instance of the owner from the private configuration: the sources, the
 * Pushover channel, the runtime and its loop. The entry `main.ts` reads the files, and it gives the
 * clocks and the transports. This module reads no file, no environment variable and no clock.
 */
import { delay, type Clock, type WallClock } from "@mark1russell7/algebra/clock";
import { localPlaces, sourceCovers, sourcePlaces, type ChannelDescriptor, type DelayLimitOptions, type ParsedConfig, type SecretLookup } from "@mark1russell7/alerts";
import { CHANNEL_ID, createPushoverChannel, isPushoverKey, pushoverDescriptor, PUSHOVER_REPEAT_MS, PUSHOVER_TIMEOUT_MS, type PushoverChannelOptions } from "@mark1russell7/alerts-channel-pushover";
import { createIpawsSource, IPAWS_DESCRIPTOR, WEA_EXPECTATION } from "@mark1russell7/alerts-source-ipaws";
import { createNwsSource, NWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nws-api";
import type { Pace, Transport } from "polite-crawler/api";
import { DEFAULT_POLICY, HostScheduler, type PolitenessPolicy } from "polite-crawler/politeness";
import type { DeliveryOptions } from "./delivery.ts";
import type { RuntimeLog } from "./log.ts";
import { createLoop, loopTimes, type LoopTimes, type RuntimeLoop } from "./loop.ts";
import { openRuntime, type Pass, type Runtime } from "./runtime.ts";

/** The name of the secret that holds the API token of the Pushover application. */
export const PUSHOVER_TOKEN = "PUSHOVER_APP_TOKEN";

/**
 * The User-Agent of each request to a source. The NWS asks for the name of the application and a
 * contact. The contact is the page of the project, thus no request names a person.
 */
export const USER_AGENT = "alerts-runtime (+https://github.com/mark1russell7/alerts)";

/**
 * The quantile and the level of the two limits of each expectation. In normal work, 1 copy in 100 or
 * fewer comes after the limit of the delay. A run of misses makes a source late by chance in 1 case
 * in 20 or fewer.
 */
export const DELAY_LIMITS: DelayLimitOptions = { quantile: 0.99, level: 0.95 };

/**
 * The descriptors of the channels of the instance. The loader of the configuration checks each
 * recipient against this list. Thus the loader and the instance agree on the channels.
 */
export const INSTANCE_CHANNELS: readonly ChannelDescriptor[] = [pushoverDescriptor()];

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

/** The channel stops its own call at this time limit. */
const CALL_LIMIT = PUSHOVER_TIMEOUT_MS;

/**
 * The times of the loop of the instance. They come from the intervals of the sources and the time
 * limit of the Pushover channel. The host reads them before a start: the stop grace holds one pass.
 */
export const INSTANCE_TIMES: LoopTimes = loopTimes([NWS_DESCRIPTOR, IPAWS_DESCRIPTOR], { delivery: { callLimit: CALL_LIMIT, retry: CALL_LIMIT } });

/** The options of `openInstance`. */
export interface InstanceOptions {
  /** The private configuration and its recipients. The function `parseConfig` gives them with the channels `INSTANCE_CHANNELS`. */
  readonly config: ParsedConfig;
  /** The secret store of the instance. It gives the keys of the file `secrets.env`. */
  readonly secret: SecretLookup;
  readonly log: RuntimeLog;
  /** The monotonic clock of the service. The loop and the pace of the sources use it. */
  readonly clock: Clock;
  /** The clock of the runtime. It gives each instant. */
  readonly wall: WallClock;
  /** The transport of the requests of the sources. A test gives a transport with faults. */
  readonly transport: Transport;
  /** The fetch of the Pushover channel. */
  readonly pushover: PushoverChannelOptions["fetch"];
  /** The id of this run. Each start of the process has a new id. */
  readonly run: string;
  /** The runtime starts this hook at the end of each pass with no error. */
  readonly onPass?: (pass: Pass) => void | Promise<void>;
  /** The loop gives each failed pass to this function. */
  readonly onError?: (error: unknown, failures: number) => void;
}

/** The instance: the runtime and its loop. */
export interface Instance {
  readonly runtime: Runtime;
  readonly loop: RuntimeLoop;
}

/**
 * This function makes the instance. It throws when the configuration or the secret store has a
 * problem. A problem is a missing token, a key with a bad form, or a place that no source covers.
 * The message names ids, fields and the names of secrets, and no value.
 *
 * - The sources are the NWS API and IPAWS. Each source gets the codes of the places. It gets the
 *   position of a place only when the place shares it with that source.
 * - The channel is Pushover. Each time of the delivery comes from a fact of the channel.
 * - The times of the loop come from the limits of the runtime.
 */
export function openInstance(options: InstanceOptions): Instance {
  const { clock, wall } = options;
  const factories = [createNwsSource, createIpawsSource] as const;
  const pace = sourcePace(clock, wall, factories.length);
  const sources = factories.map((make) => make({ pace, transport: options.transport, userAgent: USER_AGENT }));

  const descriptors = sources.map((source) => source.describe());
  const kinds = [...new Set(descriptors.flatMap((descriptor) => descriptor.kinds))];

  const { config, recipients } = options.config;
  const places = localPlaces(config);
  const token = options.secret(PUSHOVER_TOKEN) ?? "";
  // A bad key fails each send. Thus it stops the start, before the first alert.
  const tokenProblems =
    token === ""
      ? [`The secret store has no value for ${PUSHOVER_TOKEN}, the API token of the Pushover application.`]
      : isPushoverKey(token)
        ? []
        : [`The value of ${PUSHOVER_TOKEN} is not a key of Pushover: 30 letters and digits.`];
  const userProblems = recipients.flatMap((recipient) => {
    const user = recipient.addresses[CHANNEL_ID]?.["user"];
    return user === undefined || isPushoverKey(user) ? [] : [`The Pushover user key of ${recipient.watch.person} is not 30 letters and digits.`];
  });
  // A place that no source covers gets no alert. The usual cause is a missing code of a level.
  const placeProblems = places.flatMap((place) =>
    descriptors.some((descriptor) => kinds.some((kind) => sourceCovers(descriptor, place, kind)))
      ? []
      : [`No source covers the place ${place.id}. Give the place its codes at each level: the NWS zone and county, SAME, the state and the country (iso3166).`],
  );
  const problems = [...tokenProblems, ...userProblems, ...placeProblems];
  if (problems.length > 0) throw new Error(`The instance does not start. The configuration has these problems:\n- ${problems.join("\n- ")}`);

  const pushover = createPushoverChannel({ token, fetch: options.pushover, now: () => wall.now() });
  const callLimit = CALL_LIMIT;
  const delivery: DeliveryOptions = {
    recipients,
    channels: [pushover],
    // A `life-safety` message repeats until the person acknowledges it. A poll at the pace of the repeats sees an acknowledgment in one repeat.
    pollEvery: PUSHOVER_REPEAT_MS,
    // A failed call goes again after the time limit of one call. Pushover asks for a wait of 5 seconds or more after a failure.
    retry: callLimit,
    callLimit,
    // A send ends by the time limit of the channel. A second send of its key goes after its retry.
    flightLimit: callLimit + callLimit,
  };

  const runtime: Runtime = openRuntime({
    log: options.log,
    clock: wall,
    sources,
    watch: (source) => ({ places: sourcePlaces(config, source.id) }),
    view: {
      places,
      kinds,
      expectations: [WEA_EXPECTATION],
      delay: DELAY_LIMITS,
    },
    run: options.run,
    delivery,
    // The loop exists before the first pass, and only a pass starts a wake.
    wake: () => loop.wake(),
    ...(options.onPass === undefined ? {} : { onPass: options.onPass }),
  });
  const loop = createLoop({
    pass: () => runtime.pass(),
    clock,
    wall,
    times: loopTimes(runtime.config.sources, { delivery }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return { runtime, loop };
}
