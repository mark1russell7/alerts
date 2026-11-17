import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { describe, expect, it } from "vitest";
import { fakeSessions, type FakeSession } from "./fake.ts";
import { isCapProduct } from "./product.ts";
import type { RoomProduct, SessionHandlers } from "./session.ts";
import { createSupervisor, type StreamMark, type SupervisorOptions } from "./supervisor.ts";

const START = Date.parse("2026-11-16T20:00:00Z");
const MINUTE = 60_000;

function cap(serial: number, delayed = false): RoomProduct {
  return { attributes: { id: `nwws_processor.${String(serial)}`, issue: "2026-11-16T20:00:00Z", ttaaii: "XOUS55", cccc: "KWBC", awipsid: "CAPWBC" }, text: `CAP ${String(serial)}`, delayed };
}

function text(serial: number, delayed = false): RoomProduct {
  return { ...cap(serial, delayed), attributes: { ...cap(serial).attributes, ttaaii: "ASUS41", cccc: "KCLE", awipsid: "RWRCLE" } };
}

function setup(overrides: Partial<SupervisorOptions> = {}, onOpen?: (session: FakeSession) => void) {
  const clock = fakeWallClock(START);
  const fake = fakeSessions(onOpen);
  const bad: string[] = [];
  const supervisor = createSupervisor({
    account: { username: "operator", password: "a-password" },
    open: fake.open,
    clock,
    service: "xmpp://localhost:5222",
    domain: "example.org",
    room: "room@conference.example.org",
    nickname: () => "alerts-test",
    backoff: { base: 1000, factor: 2, cap: 8000 },
    random: () => 0,
    stallAfter: MINUTE,
    firstHistory: 15 * MINUTE,
    historyMargin: 2 * MINUTE,
    maxHistory: 1000,
    capacity: 100,
    keepalive: 30_000,
    timeout: 10_000,
    keep: isCapProduct,
    onBadProduct: (reason) => bad.push(reason),
    ...overrides,
  });
  return { clock, fake, supervisor, bad };
}

const serials = (supervisor: ReturnType<typeof setup>["supervisor"]) => supervisor.buffer.read().entries.map((entry) => entry.product.serial);

describe("createSupervisor", () => {
  it("opens no session before the start, then one session with the history of the last 15 minutes", () => {
    const { fake, supervisor } = setup();
    expect(fake.sessions).toHaveLength(0);
    expect(supervisor.state()).toEqual({ status: "idle", failures: 0 });
    supervisor.start();
    supervisor.start();
    expect(fake.sessions).toHaveLength(1);
    expect(fake.last().options).toMatchObject({
      service: "xmpp://localhost:5222",
      domain: "example.org",
      room: "room@conference.example.org",
      username: "operator",
      password: "a-password",
      nickname: "alerts-test",
      history: { since: START - 15 * MINUTE, maxStanzas: 1000 },
      keepalive: 30_000,
      timeout: 10_000,
    });
    expect(supervisor.state().status).toBe("joining");
    fake.last().join();
    expect(supervisor.state().status).toBe("joined");
  });

  it("keeps only the CAP products, and holds the place of the last product in the stream", async () => {
    const { clock, fake, supervisor } = setup();
    supervisor.start();
    fake.last().join();
    fake.last().send(cap(1));
    await clock.advance(1000);
    fake.last().send(text(2));
    fake.last().send(cap(3));
    expect(serials(supervisor)).toEqual([1, 3]);
    expect(supervisor.buffer.read().lost).toBe(false);
    expect(supervisor.state().mark).toEqual({ at: START + 1000, serials: { nwws_processor: 3 } });
  });

  it("tells a gap in the sequence numbers as a loss", () => {
    const { fake, supervisor } = setup();
    supervisor.start();
    fake.last().join();
    fake.last().send(cap(1));
    const before = supervisor.buffer.read().position;
    fake.last().send(text(4));
    expect(supervisor.buffer.read(before)).toMatchObject({ entries: [], lost: true, position: { losses: 1 } });
  });

  it("ignores a product of the history that it saw, and reads a live lower number as a restart of the processor", () => {
    const { fake, supervisor } = setup();
    supervisor.start();
    fake.last().join();
    fake.last().send(cap(5));
    fake.last().send(cap(4, true));
    fake.last().send(cap(5, true));
    expect(supervisor.buffer.read()).toMatchObject({ lost: false, position: { seq: 1, losses: 0 } });
    fake.last().send(cap(6, true));
    expect(serials(supervisor)).toEqual([5, 6]);
    fake.last().send(cap(2));
    fake.last().send(cap(3));
    expect(serials(supervisor)).toEqual([5, 6, 2, 3]);
    expect(supervisor.buffer.read().position.losses).toBe(1);
  });

  it("gives each product that it cannot read to onBadProduct", () => {
    const { fake, supervisor, bad } = setup();
    supervisor.start();
    fake.last().join();
    fake.last().send({ ...cap(1), attributes: { ...cap(1).attributes, issue: "noon" } });
    expect(bad).toEqual(['the issue time "noon" is not a time in UTC']);
    expect(supervisor.buffer.size).toBe(0);
  });

  it("opens the next session after the backoff, with the history from before the last product", async () => {
    const { clock, fake, supervisor } = setup();
    supervisor.start();
    fake.last().join();
    await clock.advance(5000);
    fake.last().send(cap(1));
    fake.last().end("the connection closed");
    expect(supervisor.state()).toMatchObject({ status: "waiting", failures: 1, ended: { reason: "the connection closed", kind: "network", at: START + 5000 } });
    await clock.advance(999);
    expect(fake.sessions).toHaveLength(1);
    await clock.advance(1);
    expect(fake.sessions).toHaveLength(2);
    expect(fake.last().options.history).toEqual({ since: START + 5000 - 2 * MINUTE, maxStanzas: 1000 });
    expect(supervisor.state().status).toBe("joining");
  });

  it("doubles the backoff while sessions end with no live product, and starts again after a live product", async () => {
    const { clock, fake, supervisor } = setup();
    supervisor.start();
    const opened: number[] = [];
    for (const wait of [1000, 2000, 4000, 8000, 8000]) {
      fake.last().end("refused");
      await clock.advance(wait - 1);
      opened.push(fake.sessions.length);
      await clock.advance(1);
    }
    expect(opened).toEqual([1, 2, 3, 4, 5]);
    expect(fake.sessions).toHaveLength(6);
    expect(supervisor.state().failures).toBe(5);
    // A product of the history does not prove a good session. A live product does.
    fake.last().join();
    fake.last().send(cap(1, true));
    expect(supervisor.state().failures).toBe(5);
    fake.last().send(cap(2));
    expect(supervisor.state().failures).toBe(0);
    fake.last().end("cut");
    await clock.advance(1000);
    expect(fake.sessions).toHaveLength(7);
  });

  it("ends a session whose room sends no product for stallAfter, and opens the next one", async () => {
    const { clock, fake, supervisor } = setup();
    supervisor.start();
    const first = fake.last();
    first.join();
    await clock.advance(MINUTE - 1);
    first.send(text(1));
    await clock.advance(MINUTE - 1);
    expect(first.closed).toBe(false);
    await clock.advance(1);
    expect(first.closed).toBe(true);
    expect(supervisor.state()).toMatchObject({ status: "waiting", ended: { reason: "the room sent no product in 60 s", kind: "timeout" } });
    await clock.advance(1000);
    expect(fake.sessions).toHaveLength(2);
  });

  it("closes a session that ends while open runs, and opens the next one after the backoff", async () => {
    let count = 0;
    const { clock, fake, supervisor } = setup({}, (session) => {
      count += 1;
      if (count === 1) session.end("the login failed: not-authorized", "auth");
    });
    supervisor.start();
    expect(supervisor.state()).toMatchObject({ status: "waiting", failures: 1, ended: { kind: "auth" } });
    expect(fake.sessions[0]!.closed).toBe(true);
    await clock.advance(1000);
    expect(fake.sessions).toHaveLength(2);
    fake.last().join();
    expect(supervisor.state().status).toBe("joined");
  });

  it("does not hear a session after its end", async () => {
    // A real session can tell an event after its end. These handlers do not check the end, as the fake does.
    const handlers: SessionHandlers[] = [];
    const { clock, supervisor } = setup({
      open: (_options, given) => {
        handlers.push(given);
        return { close: async () => undefined };
      },
    });
    supervisor.start();
    handlers[0]!.joined();
    handlers[0]!.ended("cut", "network");
    await clock.advance(1000);
    expect(handlers).toHaveLength(2);
    handlers[0]!.product(cap(1));
    handlers[0]!.joined();
    handlers[0]!.ended("late", "network");
    expect(supervisor.buffer.size).toBe(0);
    expect(supervisor.state()).toMatchObject({ status: "joining", failures: 1, ended: { reason: "cut" } });
    expect(clock.pending).toBe(0);
  });

  it("starts from a mark: the history from before the mark, and the sequence from the mark", () => {
    const mark: StreamMark = { at: START - MINUTE, serials: { nwws_processor: 10 } };
    const { fake, supervisor } = setup();
    supervisor.start(mark);
    expect(fake.last().options.history).toEqual({ since: START - MINUTE - 2 * MINUTE, maxStanzas: 1000 });
    expect(supervisor.state().mark).toEqual(mark);
    fake.last().join();
    fake.last().send(cap(10, true));
    fake.last().send(cap(11, true));
    expect(supervisor.buffer.read()).toMatchObject({ lost: false, position: { seq: 1 } });
    const gap = setup();
    gap.supervisor.start(mark);
    gap.fake.last().join();
    gap.fake.last().send(cap(13, true));
    expect(gap.supervisor.buffer.read().lost).toBe(true);
  });

  it("closes the session and stops each timer at the close", async () => {
    const { clock, fake, supervisor } = setup();
    supervisor.start();
    fake.last().join();
    expect(clock.pending).toBeGreaterThan(0);
    await supervisor.close();
    expect(fake.last().closed).toBe(true);
    expect(clock.pending).toBe(0);
    expect(supervisor.state().status).toBe("closed");
    const waiting = setup();
    waiting.supervisor.start();
    waiting.fake.last().end("cut");
    await waiting.supervisor.close();
    await waiting.clock.advance(10 * MINUTE);
    expect(waiting.fake.sessions).toHaveLength(1);
    expect(waiting.clock.pending).toBe(0);
  });
});

describe("settled", () => {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("resolves at once when no session connects", async () => {
    const { supervisor } = setup();
    let done = false;
    void supervisor.settled(5000).then(() => (done = true));
    await flush();
    expect(done).toBe(true);
  });

  it("resolves at the join, at the end of the session, after the time, or at the abort", async () => {
    const results: string[] = [];
    const join = setup();
    join.supervisor.start();
    void join.supervisor.settled(5000).then(() => results.push("join"));
    join.fake.last().join();
    const end = setup();
    end.supervisor.start();
    void end.supervisor.settled(5000).then(() => results.push("end"));
    end.fake.last().end("cut");
    await flush();
    expect(results).toEqual(["join", "end"]);
    const time = setup();
    time.supervisor.start();
    void time.supervisor.settled(5000).then(() => results.push("time"));
    await time.clock.advance(4999);
    await flush();
    expect(results).toEqual(["join", "end"]);
    await time.clock.advance(1);
    await flush();
    expect(results).toEqual(["join", "end", "time"]);
    const abort = setup();
    abort.supervisor.start();
    const controller = new AbortController();
    void abort.supervisor.settled(5000, controller.signal).then(() => results.push("abort"));
    controller.abort();
    await flush();
    expect(results).toEqual(["join", "end", "time", "abort"]);
    // Each wait stopped its timer.
    expect(join.clock.pending).toBe(1);
    expect(abort.clock.pending).toBe(0);
  });
});
