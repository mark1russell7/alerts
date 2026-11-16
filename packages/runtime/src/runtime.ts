/**
 * This module holds one pass of the runtime. A pass fetches each source that is due and writes the
 * events of each fetch. Then it makes the view of the system, writes its system reports and tells the
 * time of the next pass. The loop of the service starts the passes. The runtime reads only the clock
 * that it gets.
 */
import type { WallClock } from "@mark1russell7/algebra/clock";
import type { ChannelQuota, Duration, FetchOutcome, Instant, ReportId, SourceDescriptor, SourceId, SourceProcedures, Watch } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import type { BalanceWatch } from "./balance.ts";
import { createDispatcher, type DeliveryOptions, type DeliveryStep } from "./delivery.ts";
import { envelope, type RuntimeEvent } from "./events.ts";
import { fetchEvents } from "./fetch.ts";
import { limited } from "./limit.ts";
import type { RuntimeLog } from "./log.ts";
import { SNAPSHOT_MISSES, snapshotStep } from "./snapshot.ts";
import { fold, rebuild, type RuntimeState } from "./state.ts";
import { earliest, nextFetch, systemEvent, systemView, type SystemView, type ViewConfig } from "./view.ts";

/** The options of `openRuntime`. */
export interface RuntimeOptions {
  readonly log: RuntimeLog;
  /**
   * The clock of the runtime, and the only clock that it reads. Its `now()` is the instant: the time in
   * milliseconds since the epoch. A test gives `fakeWallClock(start)` of `@mark1russell7/algebra/clock`.
   */
  readonly clock: WallClock;
  /** The adapters of the sources. Each adapter holds its transport, thus a test gives a transport with faults. */
  readonly sources: readonly SourceProcedures[];
  /**
   * This function gives the places and the kinds that each fetch of a source asks for. Give each source
   * only what it needs. The function `sourcePlaces` of the core gives a position only to a source that can have it.
   */
  readonly watch: (source: SourceDescriptor) => Watch;
  /** The configuration of the views, other than the descriptors of the sources. */
  readonly view: Omit<ViewConfig, "sources">;
  /** The id of this run. Each start of the process has a new id. */
  readonly run: string;
  /** This function gives the longest time of one fetch of a source. The default is the interval of the source. */
  readonly fetchLimit?: (source: SourceDescriptor) => Duration;
  /**
   * The count of complete fetches in a row that miss a report of a snapshot source before its end. The
   * default is `SNAPSHOT_MISSES`.
   */
  readonly snapshotMisses?: number;
  /** The recipients and the channels. Without them, a pass sends nothing. */
  readonly delivery?: DeliveryOptions;
  /**
   * The runtime starts this function when work that ended after its pass needs a pass soon: a late send
   * with a delivery. The loop of the service gives its `wake()` here.
   */
  readonly wake?: () => void;
  /**
   * This function gives the quotas of the channels at the time of the view. Each stage of a quota is a
   * line of system reports. A throw keeps each open line of a quota as it is.
   */
  readonly quotas?: () => readonly ChannelQuota[];
  /**
   * The watches of the balances of the paid provider accounts. Each pass starts `check` of each watch, next to
   * its fetches. Each stage of a balance is a line of system reports.
   */
  readonly balances?: readonly BalanceWatch[];
  /** The runtime starts this hook at the end of each pass with no error. The outside heartbeat goes here. */
  readonly onPass?: (pass: Pass) => void | Promise<void>;
}

/** The result of one pass. */
export interface Pass {
  /** The time of the view. */
  readonly at: Instant;
  /** The sources that the pass fetched, in the order of the configuration. */
  readonly fetched: readonly SourceId[];
  readonly view: SystemView;
  /** The delivery step of the pass, when the runtime has a delivery. */
  readonly delivery?: DeliveryStep;
  /**
   * The time of the next pass: the next fetch of a source, the next timer of a fold or the next time of the delivery.
   * It is after `at`. A source that came due during the pass gives `at + 1`, thus the next pass starts at once and fetches it.
   */
  readonly wakeAt?: Instant;
  /** The ids of the events that are different from the events of the log with the same ids. The log kept its events. */
  readonly conflicts: readonly string[];
}

/** The runtime: its state and its pass. */
export interface Runtime {
  /** The configuration of the views, with the descriptor of each source. */
  readonly config: ViewConfig;
  /** This function gives the state: the fold of the log. */
  state(): RuntimeState;
  /**
   * This function does one pass. It throws when a write to the log fails. Then the state is the state of
   * the log, and the next pass does the work again.
   *
   * The signal `stop` aborts each fetch of the pass. A fetch that fails after the abort writes nothing to the
   * log: the stop is not a fault of the source. The delivery step does not read the signal. Each of its calls
   * ends at its own time limit.
   */
  pass(stop?: AbortSignal): Promise<Pass>;
}

/**
 * This function opens the runtime on a log. It rebuilds the state from the events of the log, and then
 * it writes the start of this run.
 */
export function openRuntime(options: RuntimeOptions): Runtime {
  const { clock, log } = options;
  const config: ViewConfig = { ...options.view, sources: options.sources.map((source) => source.describe()) };
  const ids = config.sources.map((source) => source.id);
  const repeated = ids.find((id, at) => ids.indexOf(id) !== at);
  if (repeated !== undefined) throw new Error(`Two sources have the id ${repeated}.`);

  let state = rebuild(log.read(), config);

  // The fold runs on a draft before each write. The state changes only when the transaction commits.
  const append = (events: readonly RuntimeEvent[]): readonly string[] => {
    let draft = state;
    const conflicts = log.appendAll(events, (event) => {
      draft = fold(draft, event, config);
    });
    state = draft;
    return conflicts;
  };

  append([{ ...envelope("started", `started:${options.run}`, clock.now()), run: options.run }]);

  const dispatcher = options.delivery === undefined ? undefined : createDispatcher(options.delivery, { clock, run: options.run, places: config.places, link: config.link, state: () => state, append, wake: options.wake });

  // The misses of the reports of each snapshot source, in memory only. A restart starts them at 0.
  const misses = new Map<SourceId, ReadonlyMap<ReportId, number>>();
  const limit = options.snapshotMisses ?? SNAPSHOT_MISSES;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`The count of snapshot misses is ${limit}, not an integer of 1 or more.`);

  const fetchOne = async (source: SourceProcedures, descriptor: SourceDescriptor, stop: AbortSignal | undefined): Promise<readonly string[]> => {
    const started = clock.now();
    const cursor = state.cursors[descriptor.id];
    // Each fetch has its own signal. It aborts at the stop of the runtime, and at the end of the fetch: its
    // outcome or its time limit. Thus no request of a fetch waits behind the park of its host and goes later.
    const own = new AbortController();
    let stopped = false;
    const onStop = (): void => {
      stopped = true;
      own.abort(stop?.reason);
    };
    if (stop?.aborted === true) onStop();
    else stop?.addEventListener("abort", onStop, { once: true });
    // A fetch that throws at once is a failure of its source too, not a failure of the pass.
    const work = Promise.resolve().then(() => source.fetch({ watch: options.watch(descriptor), ...(cursor === undefined ? {} : { cursor }) }, own.signal));
    const outcome = await bounded(work, options.fetchLimit?.(descriptor) ?? descriptor.interval, clock);
    stop?.removeEventListener("abort", onStop);
    own.abort(new Error(`The fetch of ${descriptor.id} ended.`));
    // A failure after the stop is the stop, not a fault of the source. The log keeps no fetch, and the cursor stays.
    if (stopped && !outcome.ok) return [];
    const ended = clock.now();
    const conflicts = append(fetchEvents({ source: descriptor.id, procedures: source, started, ended, outcome, known: (id) => log.has(id) }));
    if (descriptor.listing !== "snapshot") return conflicts;
    // The step reads the merge state after the fetch, thus a new report of the fetch has no miss.
    const step = snapshotStep({ source: descriptor.id, started, ended, outcome, merge: state.merge, misses: misses.get(descriptor.id) ?? new Map(), limit });
    const more = append(step.events);
    // The counts change only after the write. A failed write leaves the old counts, thus the end comes later.
    misses.set(descriptor.id, step.misses);
    return [...conflicts, ...more];
  };

  const watches = options.balances ?? [];
  const providers = watches.map((watch) => watch.provider);
  if (new Set(providers).size !== providers.length) throw new Error("Two balance watches have the same provider. Give one watch to each account.");

  // A fault of the store of a gate ends no line of a quota. The notes of the heartbeat tell of the fault.
  const readQuotas = (): readonly ChannelQuota[] | undefined => {
    if (options.quotas === undefined) return [];
    try {
      return options.quotas();
    } catch {
      return undefined;
    }
  };

  return {
    config,
    state: () => state,
    async pass(stop) {
      const start = clock.now();
      const due = options.sources.flatMap((source, at) => {
        const descriptor = config.sources[at]!;
        return nextFetch(state, descriptor) <= start ? [{ source, descriptor }] : [];
      });
      // A watch reads only when it is due, and its check does not throw. It runs next to the fetches.
      const checks = Promise.all(watches.map((watch) => watch.check(clock, stop)));
      // Each fetch ends before the pass ends, also when one of them fails. Thus no fetch of a pass runs on in the next pass.
      const settled = await Promise.allSettled(due.map(({ source, descriptor }) => fetchOne(source, descriptor, stop)));
      await checks;
      const failed = settled.find((result) => result.status === "rejected");
      if (failed !== undefined) throw failed.reason;
      const conflicts = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

      const at = clock.now();
      const view = systemView(state, config, at, readQuotas(), watches.flatMap((watch) => watch.balance() ?? []));
      const event = systemEvent(view);
      if (event !== undefined) conflicts.push(...append([event]));

      // The system reports of this pass are incidents too, thus the delivery comes after their write.
      const delivery = await dispatcher?.step(at);
      if (delivery !== undefined) conflicts.push(...delivery.conflicts);

      // A source or a balance watch can come due after `start`, while the fetches of the pass run. A fetch that runs to its
      // limit of one interval also ends at its next fetch. Such work is due, not a fault: its wake is the first instant after the pass.
      const nextWork = earliest([...config.sources.map((descriptor) => nextFetch(state, descriptor)), ...watches.map((watch) => watch.nextReadAt())]);
      const wakeAt = earliest([nextWork === undefined ? undefined : Math.max(nextWork, at + 1), view.wakeAt, delivery?.wakeAt]);
      const pass: Pass = {
        at,
        fetched: due.map(({ descriptor }) => descriptor.id),
        view,
        conflicts,
        ...(delivery === undefined ? {} : { delivery }),
        ...(wakeAt === undefined ? {} : { wakeAt }),
      };
      await options.onPass?.(pass);
      return pass;
    },
  };
}

/**
 * This function gives the outcome of a fetch, or a timeout when the fetch takes longer than its limit.
 * A fetch that throws is a fault of the adapter. Its outcome is a failure, and the health records it.
 * This function does not stop the fetch. The runtime aborts the signal of the fetch after this outcome.
 */
export function bounded(work: Promise<FetchOutcome>, limit: Duration, clock: WallClock): Promise<FetchOutcome> {
  return limited<FetchOutcome>(
    work,
    limit,
    clock,
    () => ({ ok: false, failure: { kind: "timeout", message: `The fetch took longer than ${limit} ms.` } }),
    (error) => ({ ok: false, failure: { kind: "network", message: `The fetch threw: ${errorMessage(error)}` } }),
  );
}
