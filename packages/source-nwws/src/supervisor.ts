/**
 * The supervisor of the sessions of NWWS-OI. It keeps one session in the room. When a session ends, it opens the next
 * one after a backoff. It reads each product, finds the products that the stream lost from their sequence numbers, and
 * keeps the products of the source in the buffer. A room that sends no product for `stallAfter` is a stalled session:
 * the supervisor ends it and opens the next one.
 */

import type { FetchSignal, Instant } from "@mark1russell7/alerts";
import type { Cancel, WallClock } from "@mark1russell7/algebra/clock";
import { backoffDelay, type Backoff } from "@mark1russell7/service/backoff";
import { createProductBuffer, type ProductBuffer } from "./buffer.ts";
import { readProduct, type NwwsProduct } from "./product.ts";
import type { EndKind, OpenSession, RoomProduct, Session, SessionOptions } from "./session.ts";

/** The account of NWWS-OI. The NWS gives each account on request. */
export interface NwwsAccount {
  readonly username: string;
  readonly password: string;
}

/** The place in the stream from which a supervisor starts: the last product that a fetch saw. */
export interface StreamMark {
  /** The time at which the session got the last product. */
  readonly at: Instant;
  /** The sequence number of the last product of each processor. */
  readonly serials: Readonly<Record<string, number>>;
}

/** The options of a supervisor. */
export interface SupervisorOptions {
  readonly account: NwwsAccount;
  /** The function that opens a session. */
  readonly open: OpenSession;
  readonly clock: WallClock;
  readonly service: string;
  readonly domain: string;
  readonly room: string;
  /** The function that gives the name of each new session. */
  readonly nickname: () => string;
  /** The backoff before each new session after an end. */
  readonly backoff: Backoff;
  readonly random: () => number;
  /** The longest time with no product before the supervisor ends a session. */
  readonly stallAfter: number;
  /** The history of the first join, back from the start, when the supervisor has no mark. */
  readonly firstHistory: number;
  /** The time before the last product that the history of a join starts at, for a difference of the two clocks. */
  readonly historyMargin: number;
  /** The most products that a join asks for again. */
  readonly maxHistory: number;
  /** The most products in the buffer. */
  readonly capacity: number;
  /** The time between two keepalives of a session. */
  readonly keepalive: number;
  /** The longest time of the connect, the login and the join. */
  readonly timeout: number;
  /** This function tells if the buffer keeps a product. */
  readonly keep: (product: NwwsProduct) => boolean;
  /** This function gets each product that the supervisor did not read, with the reason. */
  readonly onBadProduct?: (reason: string) => void;
}

/** The state of a supervisor. */
export interface SupervisorState {
  /** `idle` before the start. `joining` while a session connects. `joined` in the room. `waiting` before the next session. */
  readonly status: "idle" | "joining" | "joined" | "waiting" | "closed";
  /** The reason of the last end of a session, and its kind. */
  readonly ended?: { readonly reason: string; readonly kind: EndKind; readonly at: Instant };
  /** The count of the sessions that ended in a row with no live product. */
  readonly failures: number;
  /** The place of the last product in the stream. */
  readonly mark?: StreamMark;
  /** The time of the join of the session in the room. Only the state `joined` has it. */
  readonly joined?: Instant;
}

/** The supervisor of the sessions. */
export interface Supervisor {
  readonly buffer: Pick<ProductBuffer, "read" | "size">;
  /** This method opens the first session. A second start does nothing. */
  start(from?: StreamMark): void;
  /**
   * This method gives a promise. The promise resolves when a session is in the room or ends, after `ms`, or at the abort
   * of the signal. It does not reject.
   */
  settled(ms: number, signal?: FetchSignal): Promise<void>;
  state(): SupervisorState;
  /** This method ends the session and stops each timer. */
  close(): Promise<void>;
}

/** The default backoff: 5 seconds, then twice as long each time, to at most 5 minutes, with a jitter of half. */
export const DEFAULT_BACKOFF: Backoff = { base: 5_000, factor: 2, cap: 300_000, jitter: { kind: "subtract", fraction: 0.5 } };

/** This function makes a supervisor. It opens no session until `start`. */
export function createSupervisor(options: SupervisorOptions): Supervisor {
  const buffer = createProductBuffer(options.capacity);
  const serials = new Map<string, number>();
  const waiters = new Set<() => void>();
  let state: SupervisorState = { status: "idle", failures: 0 };
  // The time of the last join. The state shows it only while a session is in the room.
  let joinedAt: Instant | undefined;
  let session: Session | undefined;
  // Each session has a token. A handler of a session that is not the active one does nothing.
  let active: object | undefined;
  let retry: Cancel | undefined;
  let stall: Cancel | undefined;
  let lastAt: Instant | undefined;

  const settle = (): void => {
    for (const wake of [...waiters]) wake();
  };
  const set = (next: Partial<SupervisorState>): void => {
    state = { ...state, ...next };
  };
  const mark = (): StreamMark | undefined => (lastAt === undefined ? undefined : { at: lastAt, serials: Object.fromEntries(serials) });

  // Each product starts the stall timer again. The timers wait on the monotonic time, so a step of the wall clock does
  // not end a session.
  const watchStall = (): void => {
    stall?.();
    stall = options.clock.after(options.stallAfter, () => {
      stall = undefined;
      ended(`the room sent no product in ${String(Math.round(options.stallAfter / 1000))} s`, "timeout");
    });
  };

  // A loss of the stream is a gap in the sequence numbers of a processor.
  const sequence = (product: NwwsProduct, delayed: boolean): "new" | "seen" => {
    const last = serials.get(product.processor);
    if (last === undefined) {
      serials.set(product.processor, product.serial);
      return "new";
    }
    if (product.serial === last) return "seen";
    if (product.serial < last) {
      // A product of the history that the source saw comes again. A live product with a lower number tells a restart of
      // the processor: the products before the restart are not known.
      if (delayed) return "seen";
      buffer.markLoss();
      serials.set(product.processor, product.serial);
      return "new";
    }
    if (product.serial > last + 1) buffer.markLoss();
    serials.set(product.processor, product.serial);
    return "new";
  };

  const onProduct = (room: RoomProduct): void => {
    watchStall();
    const read = readProduct(room.attributes, room.text);
    const now = options.clock.now();
    if (!read.ok) {
      options.onBadProduct?.(read.reason);
      return;
    }
    if (!room.delayed) set({ failures: 0 });
    if (sequence(read.product, room.delayed) === "seen") return;
    lastAt = now;
    if (options.keep(read.product)) buffer.add(read.product, now);
  };

  const ended = (reason: string, kind: EndKind): void => {
    if (state.status === "closed") return;
    const current = session;
    session = undefined;
    active = undefined;
    stall?.();
    stall = undefined;
    current?.close().catch(() => undefined);
    const failures = state.failures + 1;
    set({ status: "waiting", ended: { reason, kind, at: options.clock.now() }, failures });
    retry = options.clock.after(backoffDelay(options.backoff, failures, options.random), () => {
      retry = undefined;
      open();
    });
    settle();
  };

  const open = (): void => {
    if (state.status === "closed") return;
    set({ status: "joining" });
    const since = lastAt === undefined ? options.clock.now() - options.firstHistory : lastAt - options.historyMargin;
    const sessionOptions: SessionOptions = {
      service: options.service,
      domain: options.domain,
      room: options.room,
      username: options.account.username,
      password: options.account.password,
      nickname: options.nickname(),
      history: { since, maxStanzas: options.maxHistory },
      keepalive: options.keepalive,
      timeout: options.timeout,
      clock: options.clock,
    };
    const token = {};
    active = token;
    const opened = options.open(sessionOptions, {
      joined: () => {
        if (active !== token) return;
        joinedAt = options.clock.now();
        set({ status: "joined" });
        watchStall();
        settle();
      },
      product: (room) => {
        if (active === token) onProduct(room);
      },
      ended: (reason, kind) => {
        if (active === token) ended(reason, kind);
      },
    });
    // A session can end while `open` runs. The supervisor then closes the session that `open` gives.
    if (active === token) session = opened;
    else opened.close().catch(() => undefined);
  };

  return {
    buffer,
    start(from) {
      if (state.status !== "idle") return;
      if (from !== undefined) {
        lastAt = from.at;
        for (const [processor, serial] of Object.entries(from.serials)) serials.set(processor, serial);
      }
      open();
    },
    settled(ms, signal) {
      if (state.status !== "joining" || signal?.aborted === true) return Promise.resolve();
      return new Promise((resolve) => {
        const done = (): void => {
          waiters.delete(done);
          timer();
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = options.clock.after(ms, done);
        waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },
    state: () => {
      const now = mark();
      const marked = now === undefined ? state : { ...state, mark: now };
      return state.status === "joined" && joinedAt !== undefined ? { ...marked, joined: joinedAt } : marked;
    },
    async close() {
      if (state.status === "closed") return;
      set({ status: "closed" });
      retry?.();
      stall?.();
      settle();
      const current = session;
      session = undefined;
      active = undefined;
      await current?.close();
    },
  };
}
