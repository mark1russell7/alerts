/**
 * This module makes the instance of the owner from the private configuration: the sources, the
 * Pushover channel, the runtime and its loop. The entry `main.ts` reads the files, and it gives the
 * clocks and the transports. This module reads no file, no environment variable and no clock.
 */
import { delay, type Clock, type WallClock } from "@mark1russell7/algebra/clock";
import { localPlaces, sourceCovers, sourcePlaces, type ChannelDescriptor, type ParsedConfig, type SecretLookup, type SourceDescriptor } from "@mark1russell7/alerts";
import { CHANNEL_ID, createPushoverChannel, isPushoverKey, pushoverDescriptor, PUSHOVER_REPEAT_MS, PUSHOVER_TIMEOUT_MS, type PushoverChannelOptions } from "@mark1russell7/alerts-channel-pushover";
import { createIpawsSource, IPAWS_DESCRIPTOR, WEA_EXPECTATION } from "@mark1russell7/alerts-source-ipaws";
import { createShapeStore, type ShapeCache, type ShapeStore } from "@mark1russell7/alerts-shapes-nws";
import { createNwsSource, NWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nws-api";
import type { Pace, Transport } from "polite-crawler/api";
import { DEFAULT_POLICY, HostScheduler, type PolitenessPolicy } from "polite-crawler/politeness";
import { requireKey, type InstanceCheck } from "./config.ts";
import type { DeliveryOptions } from "./delivery.ts";
import type { RuntimeLog } from "./log.ts";
import { createLoop, loopTimes, type LoopTimes, type RuntimeLoop } from "./loop.ts";
import { openRuntime, type Pass, type Runtime, type RuntimeOptions } from "./runtime.ts";
import { keepShapes, placeCodesKey, withZoneCodes, type InstanceShapes, type ShapeOutcome } from "./shapes.ts";
import { DELAY_LIMITS, earliest, nextFetch } from "./view.ts";

/** The name of the secret that holds the API token of the Pushover application. */
export const PUSHOVER_TOKEN = "PUSHOVER_APP_TOKEN";

/** The name of the key of `secrets.env` that holds the address of the outside heartbeat. */
export const PING_URL_KEY = "HEALTHCHECKS_PING_URL";

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
 * recipient against this list. Thus the loader and the instance agree on the channels.
 */
export const INSTANCE_CHANNELS: readonly ChannelDescriptor[] = [pushoverDescriptor()];

/** The descriptors of the sources of the instance. The function `describe` of each source gives the same descriptor. */
export const INSTANCE_SOURCES: readonly SourceDescriptor[] = [NWS_DESCRIPTOR, IPAWS_DESCRIPTOR];

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
export const INSTANCE_TIMES: LoopTimes = loopTimes(INSTANCE_SOURCES, { delivery: { callLimit: CALL_LIMIT, retry: CALL_LIMIT } });

/**
 * This function gives the problems of a configuration that stop the start of the instance. A problem
 * is a missing token, a key with a bad form, or a place that no source covers. The message names ids,
 * fields and the names of secrets, and no value.
 */
export function instanceProblems(parsed: ParsedConfig, secret: SecretLookup, descriptors: readonly SourceDescriptor[]): string[] {
  const token = secret(PUSHOVER_TOKEN) ?? "";
  // A bad key fails each send. Thus it stops the start, before the first alert.
  const tokenProblems =
    token === ""
      ? [`The secret store has no value for ${PUSHOVER_TOKEN}, the API token of the Pushover application.`]
      : isPushoverKey(token)
        ? []
        : [`The value of ${PUSHOVER_TOKEN} is not a key of Pushover: 30 letters and digits.`];
  const userProblems = parsed.recipients.flatMap((recipient) => {
    const user = recipient.addresses[CHANNEL_ID]?.["user"];
    return user === undefined || isPushoverKey(user) ? [] : [`The Pushover user key of ${recipient.watch.person} is not 30 letters and digits.`];
  });
  // A place that no source covers gets no alert. The usual cause is a missing code of a level.
  const kinds = [...new Set(descriptors.flatMap((descriptor) => descriptor.kinds))];
  const placeProblems = localPlaces(parsed.config).flatMap((place) =>
    descriptors.some((descriptor) => kinds.some((kind) => sourceCovers(descriptor, place, kind)))
      ? []
      : [`No source covers the place ${place.id}. Give the place its codes at each level: the NWS zone and county, SAME, the state and the country (iso3166).`],
  );
  return [...tokenProblems, ...userProblems, ...placeProblems];
}

/** The check of a configuration file for the live instance: its channels and the problems that stop its start. */
export const INSTANCE_CHECK: InstanceCheck = {
  channels: INSTANCE_CHANNELS,
  problems: (parsed, secret) => instanceProblems(parsed, secret, INSTANCE_SOURCES),
};

/**
 * The check of the live instance, the profile `daemon`. It adds the key of the outside heartbeat to
 * `INSTANCE_CHECK`, because the live instance does not start without its heartbeat.
 */
export const DAEMON_CHECK: InstanceCheck = requireKey(INSTANCE_CHECK, PING_URL_KEY, "The live instance needs its outside heartbeat.");

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
  /**
   * The gate of the monthly messages of the Pushover application. The entry gives it a store in a file,
   * thus the count holds across a restart. With no gate, the channel counts nothing.
   */
  readonly pushoverQuota?: PushoverChannelOptions["quota"];
  /** The id of this run. Each start of the process has a new id. */
  readonly run: string;
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
  /** The count of the codes that the outlines of the store added to the places at the start. */
  readonly zoneCodes: number;
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
  // One User-Agent for each request of the instance: the sources and the store of shapes.
  const agent = userAgent(options.config.config.contact);
  const sources = factories.map((make) => make({ pace, transport: options.transport, userAgent: agent }));

  const descriptors = sources.map((source) => source.describe());
  const kinds = [...new Set(descriptors.flatMap((descriptor) => descriptor.kinds))];

  const { config, recipients } = options.config;
  const problems = instanceProblems(options.config, options.secret, descriptors);
  if (problems.length > 0) throw new Error(`The instance does not start. The configuration has these problems:\n- ${problems.join("\n- ")}`);
  const token = options.secret(PUSHOVER_TOKEN) ?? "";

  // The store of shapes shares the pace of the sources. Thus its requests to the NWS API keep the rests of that host.
  const store = options.shapes === undefined ? undefined : createShapeStore({ pace, transport: options.transport, userAgent: agent, cache: options.shapes });
  const cache = options.shapes;
  // The places get the codes of the zones near their positions, from the outlines of the store at the start.
  const zoned = (from: ShapeStore) => withZoneCodes(config, (state) => from.basemap(state));
  const placed = store === undefined ? config : zoned(store);
  const places = localPlaces(placed);
  const zoneCodes = places.reduce((count, place, at) => count + place.codes.length - (config.places[at]?.codes.length ?? 0), 0);
  // New outlines can change the codes of a place. The check is after a refresh with requests, when no task is due.
  const opened = placeCodesKey(placed);
  let fresh = false;
  let told = false;
  const checkCodes = (outcome: ShapeOutcome): void => {
    if (store === undefined || told || !outcome.ok) return;
    if (outcome.refreshed.requests > 0) fresh = true;
    if (!fresh || outcome.refreshed.stop !== "done") return;
    fresh = false;
    if (placeCodesKey(zoned(store)) === opened) return;
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

  const pushover = createPushoverChannel({ token, fetch: options.pushover, now: () => wall.now(), ...(options.pushoverQuota === undefined ? {} : { quota: options.pushoverQuota }) });
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
    watch: (source) => ({ places: sourcePlaces(placed, source.id) }),
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
    // After each pass, the store of shapes gets the outlines that are due, and it ends before the next fetch of a source.
    onPass: async (pass) => {
      shapes.afterPass(pass.view.incidents, earliest(runtime.config.sources.map((descriptor) => nextFetch(runtime.state(), descriptor))));
      await options.onPass?.(pass);
    },
    ...(options.fetchLimit === undefined ? {} : { fetchLimit: options.fetchLimit }),
  });
  const loop = createLoop({
    pass: () => runtime.pass(),
    clock,
    wall,
    times: loopTimes(runtime.config.sources, { delivery }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return { runtime, loop, shapes, zoneCodes };
}
