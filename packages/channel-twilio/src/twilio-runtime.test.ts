import type { ChannelId, PersonId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { CHANNEL_ID } from "./descriptor.ts";
import type { OutageList } from "./outage.ts";
import {
  OUTAGE_LIST_ASSET,
  readOutageList,
  runtimeHandler,
  runtimeGlobalsOf,
  runtimePorts,
  twilioGlobals,
  type RuntimeCallOptions,
  type RuntimeCalls,
  type RuntimeContext,
  type RuntimeGlobals,
  type RuntimeResponse,
} from "./twilio-runtime.ts";

// Fake numbers only: 555-0100 to 555-0199 are numbers of fiction.
const FROM = "+15555550100";
const steps = (count: number): ChannelId[] => Array.from({ length: count }, () => CHANNEL_ID);
const LIST: OutageList = {
  version: "v1",
  message: "The alert system is down.",
  people: [{ person: "person-1" as PersonId, to: "+15555550123", chain: { steps: steps(2) } }],
  repeats: 2,
  ringSeconds: 45,
  maxCalls: 10,
  capWindow: 3_600_000,
};

const assetsOf = (text: string): Readonly<Record<string, { open(): string }>> => ({ [OUTAGE_LIST_ASSET]: { open: () => text } });

interface FakeClient {
  readonly calls: RuntimeCalls;
  readonly created: RuntimeCallOptions[];
  readonly updated: (readonly [string, unknown])[];
  readonly listed: unknown[];
}

function fakeClient(dates: readonly (Date | null)[] = []): FakeClient {
  const created: RuntimeCallOptions[] = [];
  const updated: (readonly [string, unknown])[] = [];
  const listed: unknown[] = [];
  const calls: RuntimeCalls = Object.assign((sid: string) => ({ update: async (options: unknown) => void updated.push([sid, options]) }), {
    create: async (options: RuntimeCallOptions) => {
      created.push(options);
      return { sid: "CA0000" };
    },
    list: async (options: unknown) => {
      listed.push(options);
      return dates.map((dateCreated) => ({ dateCreated }));
    },
  });
  return { calls, created, updated, listed };
}

function contextOf(client: FakeClient, fields: Partial<RuntimeContext> = {}): RuntimeContext {
  return { DOMAIN_NAME: "outage-0000.twil.io", OUTAGE_TOKEN: "token-0000", OUTAGE_FROM: FROM, getTwilioClient: () => ({ calls: client.calls }), ...fields };
}

interface FakeResponse extends RuntimeResponse {
  readonly status: number[];
  readonly headers: [string, string][];
  readonly bodies: string[];
}

function fakeResponse(): FakeResponse {
  const status: number[] = [];
  const headers: [string, string][] = [];
  const bodies: string[] = [];
  return {
    status,
    headers,
    bodies,
    setStatusCode: (code) => void status.push(code),
    appendHeader: (name, value) => void headers.push([name, value]),
    setBody: (body) => void bodies.push(body),
  };
}

function globalsOf(text: string, lines: string[], response: FakeResponse): RuntimeGlobals {
  return { assets: () => assetsOf(text), response: () => response, now: () => 60_000_000, log: (line) => lines.push(line) };
}

describe("readOutageList", () => {
  it("reads and checks the list of the Asset", () => {
    expect(readOutageList(assetsOf(JSON.stringify(LIST)))).toEqual(LIST);
  });

  it("throws for an absent Asset, for a text that is not JSON, for a wrong field and for a list with problems", () => {
    expect(() => readOutageList({})).toThrow(`The service has no Asset ${OUTAGE_LIST_ASSET}.`);
    // The parse error of JSON quotes the text. The error of the read must not hold the number.
    expect(() => readOutageList(assetsOf('{"to":"+15555550123",'))).toThrow(/^The Asset \/outage-list\.json is not valid JSON\.$/u);
    expect(() => readOutageList(assetsOf(JSON.stringify({ ...LIST, extra: 1 })))).toThrow(/is not a list/u);
    expect(() => readOutageList(assetsOf(JSON.stringify({ ...LIST, repeats: 9 })))).toThrow("The list has problems: The repeats are not a whole number from 1 to 5.");
  });
});

describe("runtimePorts", () => {
  const globals: RuntimeGlobals = { assets: () => assetsOf(JSON.stringify(LIST)), response: fakeResponse, now: () => 7, log: () => undefined };

  it("starts a call from the number of the environment, with the end status at the moved callback", async () => {
    const client = fakeClient();
    await runtimePorts(contextOf(client), globals).call({ to: "+15555550123", twiml: "<Response/>", statusCallback: "https://outage-0000.twil.io/ended?x=1", ringSeconds: 45 });
    expect(client.created).toEqual([
      {
        to: "+15555550123",
        from: FROM,
        twiml: "<Response/>",
        statusCallback: "https://outage-0000.twil.io/ended?x=1",
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["completed"],
        timeout: 45,
      },
    ]);
  });

  it("reads the newest calls of the number, and keeps each call with a time", async () => {
    const client = fakeClient([new Date(5_000), null, new Date(3_000)]);
    expect(await runtimePorts(contextOf(client), globals).recent(10)).toEqual([5_000, 3_000]);
    expect(client.listed).toEqual([{ from: FROM, limit: 10 }]);
  });

  it("moves the status callback of a live call", async () => {
    const client = fakeClient();
    await runtimePorts(contextOf(client), globals).move("CA0001", "https://outage-0000.twil.io/ended?acked=1");
    expect(client.updated).toEqual([["CA0001", { statusCallback: "https://outage-0000.twil.io/ended?acked=1", statusCallbackMethod: "POST" }]]);
  });

  it("refuses a call and a read when the environment has no number", async () => {
    const ports = runtimePorts(contextOf(fakeClient(), { OUTAGE_FROM: undefined }), globals);
    await expect(ports.recent(1)).rejects.toThrow("The environment has no variable OUTAGE_FROM.");
    await expect(ports.call({ to: "+15555550123", twiml: "", statusCallback: "", ringSeconds: 45 })).rejects.toThrow("OUTAGE_FROM");
  });
});

describe("runtimeHandler", () => {
  it("gives the reply of the adapter as a response of the runtime", async () => {
    const client = fakeClient();
    const response = fakeResponse();
    const lines: string[] = [];
    const handler = runtimeHandler("entry", () => globalsOf(JSON.stringify(LIST), lines, response));
    const result = await new Promise<RuntimeResponse | undefined>((resolve, reject) => {
      handler(contextOf(client), { token: "token-0000", status: "down" }, (error, reply) => (error === null ? resolve(reply) : reject(error)));
    });
    expect(result).toBe(response);
    expect(response.status).toEqual([200]);
    expect(response.headers).toEqual([["Content-Type", "application/json"]]);
    expect(response.bodies).toEqual([JSON.stringify({ calls: 1 })]);
    expect(client.created).toHaveLength(1);
    expect(client.created[0]!.statusCallback.startsWith("https://outage-0000.twil.io/ended?")).toBe(true);
  });

  it("gives an error when the context has no domain", async () => {
    const handler = runtimeHandler("ended", () => globalsOf(JSON.stringify(LIST), [], fakeResponse()));
    const error = await new Promise<unknown>((resolve) => handler(contextOf(fakeClient(), { DOMAIN_NAME: undefined }), {}, resolve));
    expect(error).toEqual(new Error("The context has no DOMAIN_NAME."));
  });
});

describe("twilioGlobals", () => {
  it("throws outside the Functions runtime, and names both absent globals", () => {
    expect(() => twilioGlobals()).toThrow("The Functions runtime does not give Runtime and Twilio.");
  });
});

describe("runtimeGlobalsOf", () => {
  const response = fakeResponse();
  const runtime = { getAssets: () => ({ [OUTAGE_LIST_ASSET]: { open: () => JSON.stringify(LIST) } }) };
  const twilio = { Response: class {} };

  it("names each absent part", () => {
    expect(() => runtimeGlobalsOf(undefined, twilio)).toThrow("The Functions runtime does not give Runtime.");
    expect(() => runtimeGlobalsOf({}, twilio)).toThrow("The Functions runtime does not give Runtime.getAssets.");
    expect(() => runtimeGlobalsOf(runtime, {})).toThrow("The Functions runtime does not give Twilio.Response.");
    expect(() => runtimeGlobalsOf(1, null)).toThrow("The Functions runtime does not give Runtime.getAssets and Twilio.Response.");
  });

  it("reads the Assets and makes a response with the values that it gets", () => {
    const globals = runtimeGlobalsOf(runtime, { Response: function Response() { return response; } });
    expect(Object.keys(globals.assets())).toEqual([OUTAGE_LIST_ASSET]);
    expect(globals.response()).toBe(response);
  });
});
