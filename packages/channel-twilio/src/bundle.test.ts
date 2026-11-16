import { builtinModules } from "node:module";
import { createContext, runInContext } from "node:vm";
import type { ChannelId, PersonId } from "@mark1russell7/alerts";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleFunctions, type FunctionBundle } from "./bundle.ts";
import { CHANNEL_ID } from "./descriptor.ts";
import { OUTAGE_PATHS, OUTAGE_TEXTS, type OutageList } from "./outage.ts";
import { OUTAGE_LIST_ASSET, type RuntimeCallOptions, type RuntimeCalls, type RuntimeContext, type RuntimeHandler } from "./twilio-runtime.ts";

// Fake numbers only: 555-0100 to 555-0199 are numbers of fiction.
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

interface Loaded {
  readonly handler: RuntimeHandler;
  /** The modules that the bundle requires. */
  readonly required: string[];
  readonly lines: string[];
}

class FakeResponse {
  status = 0;
  headers: [string, string][] = [];
  body = "";
  setStatusCode(code: number): void {
    this.status = code;
  }
  appendHeader(name: string, value: string): void {
    this.headers.push([name, value]);
  }
  setBody(body: string): void {
    this.body = body;
  }
}

// The Node globals of the Functions runtime that a bundle can read.
const NODE_GLOBALS = ["process", "Buffer", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "setTimeout", "clearTimeout", "queueMicrotask", "structuredClone", "crypto", "performance"];

// This function runs a bundle as the Functions runtime does: in a context with the Node globals, `Runtime` and `Twilio`.
// The `require` of the context gives only the Node built-ins.
function load(bundle: FunctionBundle): Loaded {
  const required: string[] = [];
  const lines: string[] = [];
  const builtins = new Set(builtinModules);
  const module = { exports: {} as Record<string, unknown> };
  const context = createContext({
    module,
    exports: module.exports,
    require: (name: string) => {
      required.push(name);
      const bare = name.startsWith("node:") ? name.slice("node:".length) : name;
      if (!builtins.has(bare)) throw new Error(`The bundle requires ${name}, and the runtime of Twilio does not give it.`);
      return process.getBuiltinModule(name);
    },
    console: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) },
    ...Object.fromEntries(NODE_GLOBALS.map((name) => [name, Reflect.get(globalThis, name)])),
    Runtime: { getAssets: () => ({ [OUTAGE_LIST_ASSET]: { open: () => JSON.stringify(LIST) } }) },
    Twilio: { Response: FakeResponse },
  });
  runInContext(bundle.code, context, { filename: `${bundle.path}.js` });
  const handler = module.exports["handler"];
  if (typeof handler !== "function") throw new Error(`The bundle of ${bundle.path} has no handler.`);
  return { handler: (context, event, callback) => Reflect.apply(handler, undefined, [context, event, callback]), required, lines };
}

function fakeCalls(created: RuntimeCallOptions[]): RuntimeCalls {
  return Object.assign((_sid: string) => ({ update: async () => ({}) }), {
    create: async (options: RuntimeCallOptions) => {
      created.push(options);
      return { sid: "CA0000" };
    },
    list: async () => [],
  });
}

async function invoke(loaded: Loaded, event: Record<string, unknown>, created: RuntimeCallOptions[] = []): Promise<FakeResponse> {
  const context: RuntimeContext = { DOMAIN_NAME: "outage-0000.twil.io", OUTAGE_TOKEN: "token-0000", OUTAGE_FROM: "+15555550100", getTwilioClient: () => ({ calls: fakeCalls(created) }) };
  return new Promise((resolve, reject) => {
    loaded.handler(context, event, (error, response) => (error === null && response instanceof FakeResponse ? resolve(response) : reject(error)));
  });
}

describe("bundleFunctions", () => {
  let bundles: FunctionBundle[] = [];
  beforeAll(async () => {
    bundles = await bundleFunctions();
  }, 60_000);

  it("gives one bundle for each path: a public entry and two protected Functions", () => {
    expect(bundles.map((bundle) => [bundle.path, bundle.visibility])).toEqual([
      [OUTAGE_PATHS.entry, "public"],
      [OUTAGE_PATHS.press, "protected"],
      [OUTAGE_PATHS.ended, "protected"],
    ]);
  });

  it("gives the same code for the same sources", async () => {
    expect((await bundleFunctions()).map((bundle) => bundle.code)).toEqual(bundles.map((bundle) => bundle.code));
  });

  it("gives bundles that require only the Node built-ins, and that hold no send code of the channel", () => {
    for (const bundle of bundles) {
      load(bundle);
      const named = [...bundle.code.matchAll(/\brequire\("([^"]+)"\)/gu)].map((match) => match[1]!.replace(/^node:/u, ""));
      expect(named.filter((name) => !builtinModules.includes(name))).toEqual([]);
      expect(bundle.code).not.toContain("polite-crawler");
    }
  });

  it("starts the calls in the bundle of the entry", async () => {
    const created: RuntimeCallOptions[] = [];
    const response = await invoke(load(bundles[0]!), { token: "token-0000", status: "down" }, created);
    expect(response.status).toBe(200);
    expect(response.body).toBe(JSON.stringify({ calls: 1 }));
    expect(created.map((call) => [call.to, call.from])).toEqual([["+15555550123", "+15555550100"]]);
    expect(created[0]!.twiml).toContain("<Gather");
  });

  it("refuses a wrong token in the bundle of the entry", async () => {
    expect((await invoke(load(bundles[0]!), { token: "token-0001" })).status).toBe(403);
  });

  it("says the confirmed text in the bundle of the press Function", async () => {
    const event = { outage: "60000000", person: "0", step: "0", round: "0", list: "v1", Digits: "1", CallSid: "CA0001" };
    const response = await invoke(load(bundles[1]!), event);
    expect(response.headers).toEqual([["Content-Type", "text/xml"]]);
    expect(response.body).toContain(`<Say>${OUTAGE_TEXTS.confirmed}</Say>`);
  });

  it("starts the next call in the bundle of the end Function", async () => {
    const created: RuntimeCallOptions[] = [];
    const event = { outage: "60000000", person: "0", step: "0", round: "0", list: "v1", CallStatus: "busy" };
    const response = await invoke(load(bundles[2]!), event, created);
    expect(response.body).toBe(JSON.stringify({ calls: 1 }));
    expect(new URL(created[0]!.statusCallback).searchParams.get("step")).toBe("1");
  });
});
