import type { SourceId } from "@mark1russell7/alerts";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { describe, expect, it } from "vitest";
import { heartbeat, heartbeatStep, pingOf, pingUrl, type HeartbeatFetch, type HeartbeatState, type PassSummary } from "./heartbeat.ts";

const T0 = Date.UTC(2026, 10, 15, 12, 0);
const SECOND = 1000;
// A fake ping URL. No check has it.
const URL_OF_CHECK = "https://hc-ping.com/00000000-0000-4000-8000-000000000000";
const AGENT = "alerts-runtime (test)";
const NWS = "nws-api" as SourceId;
const IPAWS = "ipaws" as SourceId;

const healthy = (at: number): PassSummary => ({
  at,
  view: {
    health: [
      { source: NWS, state: "healthy" },
      { source: IPAWS, state: "failing" },
    ],
  },
});
const refused = (at: number, kind = "auth"): PassSummary => ({
  ...healthy(at),
  delivery: {
    failures: [
      { call: "send", channel: "pushover", kind },
      { call: "status", channel: "pushover", kind: "network" },
    ],
  },
});

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
};

/** A fake server of pings. Each call waits for `answer`, or ends at the abort of its signal. */
function pings(answer: () => Promise<number> = async () => 200) {
  const calls: { url: string; body: string; agent: string | undefined; method: string }[] = [];
  const fetch: HeartbeatFetch = (url, init) => {
    calls.push({ url, body: init.body, agent: init.headers["user-agent"], method: init.method });
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error(`The request to ${url} was aborted.`)));
      answer().then((status) => resolve({ status }), reject);
    });
  };
  return { calls, fetch };
}

function open(answer?: () => Promise<number>, onError: (message: string) => void = () => undefined) {
  const clock = fakeWallClock(T0);
  const server = pings(answer);
  const errors: string[] = [];
  const hook = heartbeat({
    url: URL_OF_CHECK,
    fetch: server.fetch,
    clock,
    userAgent: AGENT,
    onError: (message) => {
      errors.push(message);
      onError(message);
    },
  });
  return { clock, server, errors, hook };
}

describe("the steps of the heartbeat", () => {
  it("pings at the first pass, then once in each 60 s", () => {
    let state: HeartbeatState = {};
    const kinds: (string | undefined)[] = [];
    for (const at of [T0, T0 + 30 * SECOND, T0 + 60 * SECOND, T0 + 90 * SECOND, T0 + 121 * SECOND]) {
      const step = heartbeatStep(state, healthy(at), 60 * SECOND);
      state = step.state;
      kinds.push(step.ping?.kind);
    }
    expect(kinds).toEqual(["success", undefined, "success", undefined, "success"]);
  });

  it("pings fail at once when a channel refuses a send, and success at once after it", () => {
    const first = heartbeatStep({}, healthy(T0), 60 * SECOND);
    const fail = heartbeatStep(first.state, refused(T0 + SECOND), 60 * SECOND);
    expect(fail.ping).toEqual({ kind: "fail", body: "The channel pushover gave the kind auth to a send." });
    const again = heartbeatStep(fail.state, refused(T0 + 2 * SECOND), 60 * SECOND);
    expect(again.ping).toBeUndefined();
    const back = heartbeatStep(again.state, healthy(T0 + 3 * SECOND), 60 * SECOND);
    expect(back.ping?.kind).toBe("success");
  });

  it("pings again when the wall clock steps back", () => {
    const first = heartbeatStep({}, healthy(T0), 60 * SECOND);
    expect(heartbeatStep(first.state, healthy(T0 - 3600 * SECOND), 60 * SECOND).ping?.kind).toBe("success");
  });

  it("gives success to a failure that can pass, and puts the state of each source in the body", () => {
    expect(pingOf({ ...healthy(T0), delivery: { failures: [{ call: "send", channel: "pushover", kind: "network" }] } })).toEqual({
      kind: "success",
      body: "nws-api: healthy\nipaws: failing",
    });
    expect(pingOf(refused(T0, "rate-limited")).kind).toBe("fail");
    expect(pingOf(refused(T0, "refused")).kind).toBe("fail");
  });

  it("adds /fail to the path of the ping URL and keeps its query", () => {
    expect(pingUrl(URL_OF_CHECK, "success")).toBe(URL_OF_CHECK);
    expect(pingUrl(URL_OF_CHECK, "fail")).toBe(`${URL_OF_CHECK}/fail`);
    expect(pingUrl("https://hc-ping.com/key/alerts-runtime/?create=1", "fail")).toBe("https://hc-ping.com/key/alerts-runtime/fail?create=1");
  });
});

describe("the hook of the heartbeat", () => {
  it("posts the ping with the User-Agent and the body, and returns before the answer", async () => {
    let answer: (status: number) => void = () => undefined;
    const { server, hook, errors } = open(() => new Promise((resolve) => (answer = resolve)));
    expect(hook(healthy(T0))).toBeUndefined();
    await settle();
    expect(server.calls).toEqual([{ url: URL_OF_CHECK, body: "nws-api: healthy\nipaws: failing", agent: AGENT, method: "POST" }]);
    answer(200);
    await settle();
    expect(errors).toEqual([]);
  });

  it("posts a fail to /fail", async () => {
    const { server, hook } = open();
    hook(refused(T0));
    await settle();
    expect(server.calls.map((call) => [call.url, call.body])).toEqual([[`${URL_OF_CHECK}/fail`, "The channel pushover gave the kind auth to a send."]]);
  });

  it("stops a ping at its limit, keeps one ping in flight, and gives no URL in the error", async () => {
    const { clock, server, hook, errors } = open(() => new Promise<number>(() => undefined));
    hook(healthy(T0));
    await settle();
    // The ping is in flight, thus a new kind starts no second ping.
    hook(refused(T0 + SECOND));
    await settle();
    expect(server.calls).toHaveLength(1);
    await clock.advance(10 * SECOND);
    await settle();
    expect(errors).toEqual(["The success ping of the heartbeat failed. It took longer than 10000 ms."]);
    hook(refused(T0 + 11 * SECOND));
    await settle();
    expect(server.calls.map((call) => call.url)).toEqual([URL_OF_CHECK, `${URL_OF_CHECK}/fail`]);
  });

  it("removes the ping URL from the text of a failed fetch", async () => {
    const { hook, errors } = open(async () => {
      throw new Error(`The connection to ${URL_OF_CHECK} failed.`);
    });
    hook(healthy(T0));
    await settle();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^The success ping of the heartbeat failed\. /);
    expect(errors[0]).not.toContain("00000000-0000-4000-8000-000000000000");
  });

  it("gives a status that is not 2xx to onError, and survives an error of onError", async () => {
    const { hook, errors } = open(
      async () => 404,
      () => {
        throw new Error("The log is closed.");
      },
    );
    hook(healthy(T0));
    await settle();
    expect(errors).toEqual(["The success ping of the heartbeat got the status 404."]);
  });

  it("refuses a ping URL that is not a URL or has no https, and names no URL", () => {
    const options = { fetch: pings().fetch, clock: fakeWallClock(T0), userAgent: AGENT, onError: () => undefined };
    expect(() => heartbeat({ ...options, url: "hc-ping.com/secret-key" })).toThrow("The ping URL of the heartbeat is not a URL.");
    expect(() => heartbeat({ ...options, url: "http://hc-ping.com/secret-key" })).toThrow("The ping URL of the heartbeat does not start with https.");
  });
});
