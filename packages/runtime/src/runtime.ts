/**
 * This module holds one pass of the runtime. A pass fetches each source that is due and writes the
 * events of each fetch. Then it makes the view of the system, writes its system reports and tells the
 * time of the next pass. The loop of the service starts the passes. The runtime reads only the clock
 * that it gets.
 */
import type { Clock } from "@mark1russell7/algebra/clock";
import type { Duration, FetchOutcome, Instant, SourceDescriptor, SourceId, SourceProcedures, Watch } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import { envelope, type RuntimeEvent } from "./events.ts";
import { fetchEvents } from "./fetch.ts";
import type { RuntimeLog } from "./log.ts";
import { fold, rebuild, type RuntimeState } from "./state.ts";
import { earliest, nextFetch, systemEvent, systemView, type SystemView, type ViewConfig } from "./view.ts";

/** The options of `openRuntime`. */
export interface RuntimeOptions {
  readonly log: RuntimeLog;
  /**
   * The clock of the runtime, and the only clock that it reads. Its `now()` is the time in milliseconds
   * since the epoch. A test gives `fakeClock(start)` of `@mark1russell7/algebra/clock`.
   */
  readonly clock: Clock;
  /** The adapters of the sources. Each adapter holds its transport, thus a test gives a transport with faults. */
  readonly sources: readonly SourceProcedures[];
  /** The places and the kinds that each fetch asks for. */
  readonly watch: Watch;
  /** The configuration of the views, other than the descriptors of the sources. */
  readonly view: Omit<ViewConfig, "sources">;
  /** The id of this run. Each start of the process has a new id. */
  readonly run: string;
  /** This function gives the longest time of one fetch of a source. The default is the interval of the source. */
  readonly fetchLimit?: (source: SourceDescriptor) => Duration;
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
  /** The time of the next pass: the next fetch of a source, or the next timer of a fold. */
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
   */
  pass(): Promise<Pass>;
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

  const fetchOne = async (source: SourceProcedures, descriptor: SourceDescriptor): Promise<readonly string[]> => {
    const started = clock.now();
    const cursor = state.cursors[descriptor.id];
    const work = source.fetch({ watch: options.watch, ...(cursor === undefined ? {} : { cursor }) });
    const outcome = await bounded(work, options.fetchLimit?.(descriptor) ?? descriptor.interval, clock);
    return append(fetchEvents({ source: descriptor.id, procedures: source, started, ended: clock.now(), outcome, known: (id) => log.has(id) }));
  };

  return {
    config,
    state: () => state,
    async pass() {
      const start = clock.now();
      const due = options.sources.flatMap((source, at) => {
        const descriptor = config.sources[at]!;
        return nextFetch(state, descriptor) <= start ? [{ source, descriptor }] : [];
      });
      // Each fetch ends before the pass ends, also when one of them fails. Thus no fetch of a pass runs on in the next pass.
      const settled = await Promise.allSettled(due.map(({ source, descriptor }) => fetchOne(source, descriptor)));
      const failed = settled.find((result) => result.status === "rejected");
      if (failed !== undefined) throw failed.reason;
      const conflicts = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

      const at = clock.now();
      const view = systemView(state, config, at);
      const event = systemEvent(view);
      if (event !== undefined) conflicts.push(...append([event]));

      const wakeAt = earliest([...config.sources.map((descriptor) => nextFetch(state, descriptor)), view.wakeAt]);
      const pass: Pass = { at, fetched: due.map(({ descriptor }) => descriptor.id), view, conflicts, ...(wakeAt === undefined ? {} : { wakeAt }) };
      await options.onPass?.(pass);
      return pass;
    },
  };
}

/**
 * This function gives the outcome of a fetch, or a timeout when the fetch takes longer than its limit.
 * A fetch that throws is a fault of the adapter. Its outcome is a failure, and the health records it.
 * The fetch continues after a timeout, and the runtime ignores its outcome. The adapter owns its transport.
 */
export function bounded(work: Promise<FetchOutcome>, limit: Duration, clock: Clock): Promise<FetchOutcome> {
  return new Promise((resolve) => {
    const cancel = clock.after(limit, () => resolve({ ok: false, failure: { kind: "timeout", message: `The fetch took longer than ${limit} ms.` } }));
    work.then(
      (outcome) => {
        cancel();
        resolve(outcome);
      },
      (error: unknown) => {
        cancel();
        resolve({ ok: false, failure: { kind: "network", message: `The fetch threw: ${errorMessage(error)}` } });
      },
    );
  });
}
