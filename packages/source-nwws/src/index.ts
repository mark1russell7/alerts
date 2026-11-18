/**
 * The source adapter of the alert system for NWWS-OI, the Open Interface of the NOAA Weather Wire Service. The NWS sends
 * each of its products to one XMPP room of NWWS-OI. The package keeps one session in the room, keeps the CAP messages
 * of the NWS, and gives the procedures of the source contract of `@mark1russell7/alerts`.
 *
 * The stream sends a CAP message less than a minute after the NWS sends it. The NWS API source polls the same messages
 * on another path. NWWS-OI needs an account of the NWS. The products are works of the US government, in the public domain.
 */

import { randomBytes } from "node:crypto";
import type { SourceProcedures } from "@mark1russell7/alerts";
import { wallClock, type WallClock } from "@mark1russell7/algebra/clock";
import type { Backoff } from "@mark1russell7/service/backoff";
import { checkCanary } from "./check.ts";
import { NWWS_DESCRIPTOR } from "./descriptor.ts";
import { createNwwsFetch } from "./fetch.ts";
import { mapObservation } from "./map.ts";
import { isCapProduct } from "./product.ts";
import { NWWS_DOMAIN, NWWS_ROOM, NWWS_SERVICE, openXmppSession, sessionNickname, type OpenSession } from "./session.ts";
import { createSupervisor, DEFAULT_BACKOFF, type NwwsAccount, type SupervisorState } from "./supervisor.ts";

export { createProductBuffer, type BufferEntry, type BufferPosition, type BufferRead, type ProductBuffer } from "./buffer.ts";
export { checkCanary, keepaliveSent, type CanarySession } from "./check.ts";
export { NWWS_DESCRIPTOR } from "./descriptor.ts";
export { fakeSessions, type FakeSession, type FakeSessions } from "./fake.ts";
export { CONTENT_TYPE, createNwwsFetch, cursorOf, failureOf, markOf, observationOf, positionOf, type NwwsFetchOptions } from "./fetch.ts";
export { mapObservation, SOURCE_ID } from "./map.ts";
export { capXml, isCapProduct, PRODUCT_NAMESPACE, readProduct, type NwwsProduct, type ProductRead } from "./product.ts";
export {
  NWWS_DOMAIN,
  NWWS_ROOM,
  NWWS_SERVICE,
  openXmppSession,
  roomProduct,
  sessionNickname,
  type EndKind,
  type JoinHistory,
  type OpenSession,
  type RoomProduct,
  type Session,
  type SessionHandlers,
  type SessionOptions,
} from "./session.ts";
export { joinRefusal, productStanza, selfPresence, type ProductStanza } from "./stanzas.ts";
export { createSupervisor, DEFAULT_BACKOFF, type NwwsAccount, type StreamMark, type Supervisor, type SupervisorOptions, type SupervisorState } from "./supervisor.ts";

/**
 * The longest time with no product before the source ends a session: 5 minutes. A capture of 10 minutes on 2026-11-16
 * had 225 live products, and the longest time between two was 27 seconds.
 */
export const STALL_AFTER_MS: number = 5 * 60_000;

/** The options of the source. Each option except the account has a default. */
export interface NwwsSourceOptions {
  readonly account: NwwsAccount;
  readonly clock?: WallClock;
  /** The function that opens a session. The default is `openXmppSession`. A test gives a fake session. */
  readonly open?: OpenSession;
  readonly random?: () => number;
  readonly nickname?: () => string;
  /** The id of the buffer of this process. The default is random. */
  readonly epoch?: string;
  readonly backoff?: Backoff;
  readonly stallAfter?: number;
  readonly service?: string;
  readonly domain?: string;
  readonly room?: string;
}

/** The procedures of the source, and the end of its session. */
export interface NwwsSource extends SourceProcedures {
  /** This method gives the state of the supervisor of the sessions. */
  state(): SupervisorState;
  /** This method ends the session and stops each timer of the source. */
  close(): Promise<void>;
}

/**
 * This function makes the procedures of the source: `describe`, `fetch`, `map` and `check`. The first fetch opens the
 * session. The source has no `locate`: it asks for no point. The source has a session until `close`.
 */
export function createNwwsSource(options: NwwsSourceOptions): NwwsSource {
  // The timers of the source do not keep a process alive. The socket of a session keeps it alive while it is open.
  const clock = options.clock ?? wallClock({ unref: true });
  const room = options.room ?? NWWS_ROOM;
  const supervisor = createSupervisor({
    account: options.account,
    open: options.open ?? openXmppSession,
    clock,
    service: options.service ?? NWWS_SERVICE,
    domain: options.domain ?? NWWS_DOMAIN,
    room,
    nickname: options.nickname ?? sessionNickname,
    backoff: options.backoff ?? DEFAULT_BACKOFF,
    random: options.random ?? Math.random,
    stallAfter: options.stallAfter ?? STALL_AFTER_MS,
    // At a join, the room sends again only its last 25 products, whatever the request. Thus the history fills only a
    // short gap, and it holds a keepalive only by chance. The canary gives no read in the first minutes of a session.
    firstHistory: 15 * 60_000,
    historyMargin: 2 * 60_000,
    maxHistory: 1000,
    capacity: 2000,
    keepalive: 60_000,
    timeout: 30_000,
    keep: isCapProduct,
  });
  const fetch = createNwwsFetch({ supervisor, epoch: options.epoch ?? randomBytes(8).toString("hex"), clock, url: `xmpp:${room}`, joinWait: 20_000 });
  return {
    describe: () => NWWS_DESCRIPTOR,
    fetch,
    map: ({ observation }) => mapObservation(observation),
    check: ({ observations }) => {
      const state = supervisor.state();
      return checkCanary(observations, state.joined === undefined ? undefined : { joined: state.joined, now: clock.now() });
    },
    state: () => supervisor.state(),
    close: () => supervisor.close(),
  };
}
