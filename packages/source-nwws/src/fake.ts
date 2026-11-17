/**
 * A fake of the sessions of NWWS-OI, for tests. Each session is open until the test ends it or the supervisor closes it.
 * The test tells each event of a session: the join, a product and the end. The fake opens no connection.
 */

import type { EndKind, OpenSession, RoomProduct, SessionHandlers, SessionOptions } from "./session.ts";

/** One fake session. */
export interface FakeSession {
  readonly options: SessionOptions;
  /** True after the supervisor closed the session, or after the test ended it. */
  readonly closed: boolean;
  /** This method tells that the session is in the room. */
  join(): void;
  /** This method sends a product of the room to the session. */
  send(product: RoomProduct): void;
  /** This method ends the session, with the reason and its kind. */
  end(reason: string, kind?: EndKind): void;
}

/** The fake sessions of one test. */
export interface FakeSessions {
  /** The function that opens a fake session: give it to the supervisor. */
  readonly open: OpenSession;
  /** Each session that the supervisor opened, oldest first. */
  readonly sessions: readonly FakeSession[];
  /** This method gives the newest session. */
  last(): FakeSession;
}

/**
 * This function makes the fake sessions of one test. The function `onOpen` gets each new session before `open` gives
 * it back, so that a test can join or end a session at once.
 */
export function fakeSessions(onOpen?: (session: FakeSession) => void): FakeSessions {
  const sessions: FakeSession[] = [];
  const open: OpenSession = (options: SessionOptions, handlers: SessionHandlers) => {
    let closed = false;
    const session: FakeSession = {
      options,
      get closed() {
        return closed;
      },
      join: () => {
        if (!closed) handlers.joined();
      },
      send: (product) => {
        if (!closed) handlers.product(product);
      },
      end: (reason, kind = "network") => {
        if (closed) return;
        closed = true;
        handlers.ended(reason, kind);
      },
    };
    sessions.push(session);
    onOpen?.(session);
    return {
      close: async () => {
        closed = true;
      },
    };
  };
  return {
    open,
    sessions,
    last: () => {
      const session = sessions.at(-1);
      if (session === undefined) throw new Error("The supervisor opened no session.");
      return session;
    },
  };
}
