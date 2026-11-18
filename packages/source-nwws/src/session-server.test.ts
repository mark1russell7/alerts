import { wallClock } from "@mark1russell7/algebra/clock";
import { testCertificates, trustCertificate } from "@mark1russell7/rigor-testkit/tls";
import { startXmppServer, type XmppConnection, type XmppServer, type XmppSession, type XmppStep } from "@mark1russell7/rigor-testkit/xmpp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openXmppSession, type EndKind, type RoomProduct, type Session, type SessionOptions } from "./session.ts";
import { joinRefusal, productStanza, selfPresence } from "./stanzas.ts";

// These tests start one session of `openXmppSession` against a scripted XMPP server on this computer, with TLS.
const DOMAIN = "nwws.example.org";
const ROOM = `nwws@conference.${DOMAIN}`;
const ACCOUNT = { username: "reader", password: "secret-5d1e0b" };
const NICKNAME = "alerts-0000000a";
const SINCE = Date.parse("2026-11-17T11:45:00Z");

const certificates = testCertificates({ names: [DOMAIN] });
let untrust: (() => void) | undefined;
beforeAll(() => {
  untrust = trustCertificate(certificates.ca);
});
afterAll(() => untrust?.());

const servers: XmppServer[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const server of servers.splice(0)) await server.close();
});

const JOIN: XmppStep = { receive: "presence" };
const JOINED: XmppStep = { send: selfPresence("{{to}}", "{{jid}}") };

const product = (serial: number, delayed?: string): XmppStep => ({
  send: productStanza({
    room: ROOM,
    to: "{{jid}}",
    id: `case.${String(serial)}`,
    issue: "2026-11-17T12:00:00Z",
    ttaaii: "XOUS53",
    cccc: "KTOP",
    awipsid: "CAPTOP",
    text: `XOUS53 KTOP 171200\nCAPTOP\n\n<?xml version="1.0" encoding="UTF-8"?>\n<alert><identifier>${String(serial)}</identifier></alert>`,
    ...(delayed === undefined ? {} : { delayed }),
  }),
});

interface Events {
  joined: boolean;
  readonly products: RoomProduct[];
  ended?: { readonly reason: string; readonly kind: EndKind };
}

/** This function starts a server with the scripts, and opens one session to it. */
async function open(scripts: readonly XmppSession[], options: Partial<SessionOptions> = {}) {
  const server = await startXmppServer({ domain: DOMAIN, tls: certificates, accounts: [ACCOUNT], sessions: scripts });
  servers.push(server);
  const events: Events = { joined: false, products: [] };
  let wake = (): void => undefined;
  const session = openXmppSession(
    {
      service: server.url,
      domain: DOMAIN,
      room: ROOM,
      ...ACCOUNT,
      nickname: NICKNAME,
      history: { since: SINCE, maxStanzas: 50 },
      keepalive: 60_000,
      timeout: 5_000,
      clock: wallClock({ unref: true }),
      ...options,
    },
    {
      joined: () => {
        events.joined = true;
        wake();
      },
      product: (room) => {
        events.products.push(room);
        wake();
      },
      ended: (reason, kind) => {
        events.ended = { reason, kind };
        wake();
      },
    },
  );
  sessions.push(session);
  // This function waits for a state of the events, for 5 s at most.
  const until = (test: () => boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the events did not come in 5 s")), 5_000);
      const check = (): void => {
        if (!test()) return;
        clearTimeout(timer);
        resolve();
      };
      wake = check;
      check();
    });
  const connection = (): XmppConnection => {
    const first = server.connections[0];
    if (first === undefined) throw new Error("the server has no connection");
    return first;
  };
  return { session, events, until, connection };
}

describe("openXmppSession", () => {
  it("logs in over TLS, joins the room with the history, and gives each product of the history and of the stream", async () => {
    const { events, until, connection } = await open([{ steps: [JOIN, JOINED, product(1, "2026-11-17T12:00:05Z"), product(2)] }]);
    await until(() => events.products.length === 2);
    expect(events.joined).toBe(true);
    expect(events.products.map((room) => [room.attributes["id"], room.delayed])).toEqual([
      ["case.1", true],
      ["case.2", false],
    ]);
    expect(events.products[1]?.text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(connection()).toMatchObject({ secure: true, sasl: "success", jid: `${ACCOUNT.username}@${DOMAIN}/${NICKNAME}` });
    const join = connection().stanzas.find((stanza) => stanza.name === "presence");
    expect(join?.attrs["to"]).toBe(`${ROOM}/${NICKNAME}`);
    expect(join?.xml).toMatch(/since=["']2026-11-17T11:45:00\.000Z["']/);
    expect(join?.xml).toMatch(/maxstanzas=["']50["']/);
    expect(events.ended).toBeUndefined();
  });

  it("ends with the kind auth when the server refuses the login, and the reason has no user name and no password", async () => {
    const { events, until } = await open([{ sasl: { failure: "not-authorized", text: `no login ${ACCOUNT.username} ${ACCOUNT.password}` } }]);
    await until(() => events.ended !== undefined);
    expect(events.ended?.kind).toBe("auth");
    expect(events.ended?.reason).not.toContain(ACCOUNT.username);
    expect(events.ended?.reason).not.toContain(ACCOUNT.password);
    expect(events.joined).toBe(false);
  });

  it("ends with the kind refused, and sends no login, when the server offers no TLS", async () => {
    const { events, until, connection } = await open([{ startTls: "none" }]);
    await until(() => events.ended !== undefined);
    expect(events.ended).toEqual({ reason: expect.stringContaining("the link is not secure") as unknown, kind: "refused" });
    expect(connection()).toMatchObject({ secure: false, username: undefined, sasl: undefined });
    expect(connection().negotiation).not.toContain("auth");
  });

  it("ends with the kind refused when the room refuses the join", async () => {
    const { events, until } = await open([{ steps: [JOIN, { send: joinRefusal("{{to}}", "{{jid}}", "not-allowed") }] }]);
    await until(() => events.ended !== undefined);
    expect(events.ended).toEqual({ reason: "the room refused the join: not-allowed", kind: "refused" });
  });

  it("ends with the kind network for a stream error of the server, after the products before it", async () => {
    const { events, until } = await open([{ steps: [JOIN, JOINED, product(1), { close: { condition: "system-shutdown" } }] }]);
    await until(() => events.ended !== undefined);
    expect(events.products).toHaveLength(1);
    expect(events.ended?.kind).toBe("network");
    expect(events.ended?.reason).toContain("system-shutdown");
  });

  it("ends with the kind network when the connection breaks", async () => {
    // A reset deletes the bytes that the client did not read, so the reset comes after the client reads the join.
    const { events, until } = await open([{ steps: [JOIN, JOINED, { destroy: true, delayMs: 200 }] }]);
    await until(() => events.ended !== undefined);
    expect(events.joined).toBe(true);
    expect(events.ended?.kind).toBe("network");
  });

  it("ends with the kind network when the server ends TCP with no close of the stream", async () => {
    const { events, until } = await open([{ steps: [JOIN, JOINED, product(1), { end: true, delayMs: 200 }] }]);
    await until(() => events.ended !== undefined);
    expect(events.products).toHaveLength(1);
    expect(events.ended).toEqual({ reason: "the server closed the connection", kind: "network" });
  });

  it("ends with the kind timeout when the room does not answer the join in time", async () => {
    const { events, until } = await open([{ steps: [JOIN] }], { timeout: 300 });
    await until(() => events.ended !== undefined);
    expect(events.ended).toEqual({ reason: "the session did not join the room in 0.3 s", kind: "timeout" });
  });

  it("closes the stream at close, and tells no end", async () => {
    const { session, events, until, connection } = await open([{ steps: [JOIN, JOINED] }]);
    await until(() => events.joined);
    await session.close();
    expect(connection().clientClosed).toBe(true);
    expect(events.ended).toBeUndefined();
  });
});
