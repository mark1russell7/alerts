/**
 * The fetch of the NWWS-OI source. The stream does not wait for a fetch. The supervisor keeps the CAP products in the
 * buffer, and each fetch reads the products after its cursor. The cursor holds the position in the buffer and the place
 * in the stream. A new process starts the stream from that place, so a restart loses no product that the room still has
 * in its history.
 */

import { observationId, type Cursor, type FetchFailure, type FetchOutcome, type FetchSignal, type Instant, type Observation, type Watch } from "@mark1russell7/alerts";
import type { WallClock } from "@mark1russell7/algebra/clock";
import { keepaliveSent } from "./check.ts";
import type { BufferEntry, BufferPosition } from "./buffer.ts";
import { SOURCE_ID } from "./map.ts";
import { capXml } from "./product.ts";
import type { StreamMark, Supervisor, SupervisorState } from "./supervisor.ts";

/** The content type of each observation: the XML of one CAP message. */
export const CONTENT_TYPE = "application/xml";

const EPOCH = "epoch";
const SEQ = "seq";
const LOSSES = "losses";
const AT = "at";
const SERIAL = "serial:";

/** The options of the fetch. */
export interface NwwsFetchOptions {
  readonly supervisor: Supervisor;
  /** The id of the buffer of this process. A cursor of another process has another epoch. */
  readonly epoch: string;
  readonly clock: WallClock;
  /** The address of the room, as the URL of each observation. */
  readonly url: string;
  /** The longest wait of a fetch for a session that connects. */
  readonly joinWait: number;
}

/** This function gives the place in the stream that a cursor holds. A cursor with no place gives `undefined`. */
export function markOf(cursor: Cursor | undefined): StreamMark | undefined {
  const at = Number(cursor?.[AT]);
  if (cursor === undefined || !Number.isFinite(at)) return undefined;
  // The names of the processors come from the stream. `Object.fromEntries` keeps a name such as `__proto__` as a key.
  const serials: Record<string, number> = Object.fromEntries(
    Object.entries(cursor).flatMap(([key, value]) => {
      const serial = Number(value);
      return key.startsWith(SERIAL) && Number.isSafeInteger(serial) ? [[key.slice(SERIAL.length), serial] as const] : [];
    }),
  );
  return { at, serials };
}

/** This function gives the cursor of a fetch: the epoch, the position in the buffer and the place in the stream. */
export function cursorOf(epoch: string, position: BufferPosition, mark: StreamMark | undefined): Cursor {
  const cursor: Record<string, string> = { [EPOCH]: epoch, [SEQ]: String(position.seq), [LOSSES]: String(position.losses) };
  if (mark !== undefined) {
    cursor[AT] = String(mark.at);
    for (const [processor, serial] of Object.entries(mark.serials)) cursor[`${SERIAL}${processor}`] = String(serial);
  }
  return cursor;
}

/** This function gives the position in the buffer that a cursor of this epoch holds. Another epoch gives `undefined`. */
export function positionOf(cursor: Cursor | undefined, epoch: string): BufferPosition | undefined {
  if (cursor?.[EPOCH] !== epoch) return undefined;
  const seq = Number(cursor[SEQ]);
  const losses = Number(cursor[LOSSES]);
  return Number.isSafeInteger(seq) && Number.isSafeInteger(losses) ? { seq, losses } : undefined;
}

/** This function gives the observation of one product of the buffer. A product with no XML gives `undefined`. */
export function observationOf(entry: BufferEntry, url: string): Observation | undefined {
  const body = capXml(entry.product.text);
  if (body === undefined) return undefined;
  return {
    id: observationId({ source: SOURCE_ID, contentType: CONTENT_TYPE, url, body }),
    source: SOURCE_ID,
    fetched: entry.received,
    contentType: CONTENT_TYPE,
    body,
    // The stream has no request. The latency is the time from the issue of the product to its receipt.
    transport: { url, latency: Math.max(0, entry.received - entry.product.issue) },
  };
}

/** This function gives the failure of a fetch while the source has no session in the room. */
export function failureOf(state: SupervisorState): FetchFailure {
  if (state.status === "closed") return { kind: "network", message: "the source of NWWS-OI is closed" };
  if (state.ended === undefined) return { kind: "network", message: "the session of NWWS-OI is not in the room yet" };
  return { kind: state.ended.kind, message: `the session of NWWS-OI ended: ${state.ended.reason}` };
}

/**
 * This function makes the fetch of the source. The first fetch starts the supervisor from the place in its cursor. A
 * fetch gives the new CAP products of the buffer, and the newest keepalive again with the time of the fetch, for the
 * canary check. When the source has no session and no new product, the fetch fails with the reason of the last end.
 */
export function createNwwsFetch(options: NwwsFetchOptions): (input: { readonly watch: Watch; readonly cursor?: Cursor }, signal?: FetchSignal) => Promise<FetchOutcome> {
  const { supervisor } = options;
  let keepalive: Observation | undefined;
  return async (input, signal) => {
    if (supervisor.state().status === "idle") supervisor.start(markOf(input.cursor));
    await supervisor.settled(options.joinWait, signal);
    const state = supervisor.state();
    const read = supervisor.buffer.read(positionOf(input.cursor, options.epoch));
    if (read.entries.length === 0 && state.status !== "joined") return { ok: false, failure: failureOf(state) };
    const observations = read.entries.flatMap((entry) => observationOf(entry, options.url) ?? []);
    for (const observation of observations) if (keepaliveSent(observation) !== undefined) keepalive = observation;
    const fetched: Instant = options.clock.now();
    const again = keepalive !== undefined && !observations.some((observation) => observation.id === keepalive?.id) ? [{ ...keepalive, fetched }] : [];
    return { ok: true, observations: [...observations, ...again], cursor: cursorOf(options.epoch, read.position, state.mark), complete: !read.lost };
  };
}
