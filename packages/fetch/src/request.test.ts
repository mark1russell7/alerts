import type { FetchSignal, SourceId } from "@mark1russell7/alerts";
import type { Condition, Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { problemDetail } from "./failure.ts";
import { abortSignalOf, createRequester, DEFAULT_TIMEOUT_MS, type RequesterOptions } from "./request.ts";

const START = Date.parse("2026-11-15T00:00:00.000Z");

/** A clock of the tests: each wait moves the time at once. */
const testClock = (): { now: () => number; sleep: (ms: number) => Promise<void>; move: (ms: number) => void } => {
  let time = START;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    move: (ms) => {
      time += ms;
    },
  };
};

const reply = (status: number, body = "", headers: Record<string, string> = {}): Reply => ({
  status,
  statusText: status === 200 ? "OK" : status === 304 ? "Not Modified" : "Error",
  headers,
  body,
});

type Step = Reply | ((exchange: Exchange, signal: AbortSignal | undefined) => Promise<Reply>);

/** This function makes a requester whose transport gives the steps in turn, and then the last step again. */
const requesterWith = (steps: readonly Step[], options: Partial<RequesterOptions> = {}) => {
  const sent: Exchange[] = [];
  const clock = testClock();
  let index = 0;
  const transport: Transport = async (exchange, signal) => {
    sent.push(exchange);
    const step = steps[Math.min(index++, steps.length - 1)];
    if (step === undefined) throw new Error("no step");
    return typeof step === "function" ? step(exchange, signal) : step;
  };
  const requester = createRequester({
    source: "test-api" as SourceId,
    pace: { scheduler: new HostScheduler(clock, 1), now: clock.now },
    transport,
    baseUrl: "https://api.test/v1//",
    headers: { accept: "application/json", "user-agent": "alerts-tests" },
    minIntervalMs: 0,
    ...options,
  });
  return { requester, sent, clock };
};

describe("createRequester", () => {
  it("sends the option read to the transport, and gives the bytes of the answer", async () => {
    const bytes = new Uint8Array([10, 3, 50, 46, 48]);
    const { requester, sent } = requesterWith([{ ...reply(200, "", { "content-type": "application/x-protobuf" }), bytes }]);
    const result = await requester.get({ path: "/alerts.pb", what: "the alerts", read: "bytes" });
    expect(sent[0]?.read).toBe("bytes");
    expect(result.ok && result.answer.reply.bytes).toEqual(bytes);
    await requester.get({ path: "/alerts.json", what: "the alerts" });
    expect(sent[1]).not.toHaveProperty("read");
  });

  it("removes the slashes at the end of the base URL, and sends a GET with the headers", async () => {
    const { requester, sent } = requesterWith([reply(200, "{}")]);
    expect(requester.baseUrl).toBe("https://api.test/v1");
    expect(requester.host).toBe("api.test");
    expect(requester.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    const result = await requester.get({ path: "/alerts?x=1", what: "the alerts" });
    expect(result).toMatchObject({ ok: true, url: "https://api.test/v1/alerts?x=1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "GET", url: "https://api.test/v1/alerts?x=1", body: null });
    expect(sent[0]?.headers).toMatchObject({ accept: "application/json", "user-agent": "alerts-tests" });
  });

  it("gives the latency of the transport", async () => {
    const steps: Step[] = [];
    const { requester, clock } = requesterWith(steps);
    steps.push(async () => {
      clock.move(25);
      return reply(200, "{}");
    });
    const result = await requester.get({ path: "/", what: "the root" });
    expect(result).toMatchObject({ ok: true, latency: 25 });
  });

  it("sends the validators with a store of conditions, and a 304 is a success", async () => {
    const { requester, sent } = requesterWith([reply(200, "{}", { etag: '"v1"' }), reply(304)]);
    const conditions = new Map<string, Condition>();
    const first = await requester.get({ path: "/a", what: "a", conditions });
    expect(first).toMatchObject({ ok: true });
    expect(conditions.get("https://api.test/v1/a")?.etag).toBe('"v1"');
    const second = await requester.get({ path: "/a", what: "a", conditions });
    expect(sent[1]?.headers["if-none-match"]).toBe('"v1"');
    expect(second.ok && second.answer.classified.outcome).toBe("not-modified");
  });

  it("gives a failure for a 304 with no store of conditions", async () => {
    const result = await requesterWith([reply(304)]).requester.get({ path: "/a", what: "a" });
    expect(result).toMatchObject({ ok: false, url: "https://api.test/v1/a", failure: { kind: "refused", message: "304 Not Modified (not-modified)" } });
    expect(!result.ok && result.answer?.reply.status).toBe(304);
  });

  it("maps an answer that is not a success with the reader of the problem text", async () => {
    const body = JSON.stringify({ detail: "bad area" });
    const { requester } = requesterWith([reply(400, body)], { detail: problemDetail });
    expect(await requester.get({ path: "/a", what: "a" })).toMatchObject({ ok: false, failure: { kind: "refused", message: "400 Error: bad area" } });
    const plain = requesterWith([reply(400, body)]).requester;
    expect(await plain.get({ path: "/a", what: "a" })).toMatchObject({ ok: false, failure: { kind: "refused", message: "400 Error" } });
  });

  it("gives the failure network when the transport throws", async () => {
    const broken = requesterWith([
      async () => {
        throw new Error("connection reset");
      },
    ]).requester;
    const result = await broken.get({ path: "/a", what: "a" });
    expect(result).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(!result.ok && result.failure.message).toContain("connection reset");
  });

  it("sends a POST with the body, and the message of a failure has no secret", async () => {
    const key = "key-5e1c7a";
    const refusal = JSON.stringify({ errors: [{ message: `Unsupported API key: ${key}`, code: 21 }] });
    const firstError = (text: string): string | undefined => (JSON.parse(text) as { errors: { message: string }[] }).errors[0]?.message;
    const { requester, sent } = requesterWith([reply(403, refusal)], { detail: firstError, secrets: [key], headers: { "content-type": "application/json" } });
    const body = JSON.stringify({ api_key: key });
    const result = await requester.get({ path: "/get-mag-alert", what: "the current alert", body });
    expect(sent).toEqual([{ method: "POST", url: "https://api.test/v1/get-mag-alert", headers: { "content-type": "application/json" }, body }]);
    expect(result).toMatchObject({ ok: false, failure: { kind: "refused" } });
    expect(!result.ok && result.failure.message).toContain("Unsupported API key");
    expect(!result.ok && result.failure.message).not.toContain(key);
    expect(!result.ok && result.answer?.reply.status).toBe(403);
  });

  it("removes the secrets from the message of an error of the transport", async () => {
    const key = "key-5e1c7a";
    const broken = requesterWith(
      [
        async () => {
          throw new Error(`the body ${key} was cut`);
        },
      ],
      { secrets: [key] },
    ).requester;
    const result = await broken.get({ path: "/a", what: "a", body: "{}" });
    expect(result).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(!result.ok && result.failure.message).toContain("was cut");
    expect(!result.ok && result.failure.message).not.toContain(key);
  });

  it("gives the failure timeout at the end of the time limit", async () => {
    const hangs: Step = (_exchange, signal) =>
      new Promise<Reply>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      });
    const slow = requesterWith([hangs], { timeoutMs: 20 }).requester;
    expect(await slow.get({ path: "/a", what: "a" })).toEqual({
      ok: false,
      url: "https://api.test/v1/a",
      failure: { kind: "timeout", message: "no answer in 20 ms: https://api.test/v1/a" },
    });
  });

  it("throws when the signal of the caller aborts", async () => {
    const controller = new AbortController();
    const hangs: Step = (_exchange, signal) =>
      new Promise<Reply>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
        controller.abort(new Error("the caller stops"));
      });
    const { requester } = requesterWith([hangs]);
    await expect(requester.get({ path: "/a", what: "a" }, controller.signal)).rejects.toThrow("the caller stops");
  });
});

describe("abortSignalOf", () => {
  // A signal of the contract that is not an `AbortSignal`.
  const foreign = () => {
    const listeners: (() => void)[] = [];
    const signal: FetchSignal & { reason?: unknown } = {
      aborted: false,
      addEventListener: (_type, listener) => listeners.push(listener),
      removeEventListener: () => undefined,
    };
    const abort = (reason: unknown): void => {
      Object.assign(signal, { aborted: true, reason });
      for (const listener of listeners) listener();
    };
    return { signal, abort };
  };

  it("keeps an AbortSignal as it is, and keeps no signal as no signal", () => {
    const controller = new AbortController();
    expect(abortSignalOf(controller.signal)).toBe(controller.signal);
    expect(abortSignalOf(undefined)).toBeUndefined();
  });

  it("links a signal of another kind: the AbortSignal aborts at its abort, with the same reason", () => {
    const { signal, abort } = foreign();
    const linked = abortSignalOf(signal);
    expect(linked?.aborted).toBe(false);
    const reason = new Error("The fetch ended at its limit.");
    abort(reason);
    expect(linked?.aborted).toBe(true);
    expect(linked?.reason).toBe(reason);
  });

  it("gives an aborted AbortSignal for a signal of another kind that aborted before", () => {
    const { signal, abort } = foreign();
    const reason = new Error("The runtime stops.");
    abort(reason);
    const linked = abortSignalOf(signal);
    expect(linked?.aborted).toBe(true);
    expect(linked?.reason).toBe(reason);
  });
});
