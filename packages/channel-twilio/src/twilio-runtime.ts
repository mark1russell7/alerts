/**
 * The glue between the Functions runtime of Twilio and the adapter of `function.ts`. It makes the ports
 * from the context of a Function, and it gives the handler of each Function.
 *
 * - The client of each port is the helper library of Twilio, from `context.getTwilioClient()`. The account of the Functions owns it, so the files hold no key.
 * - The list is the private Asset `OUTAGE_LIST_ASSET`. Only the Functions of the service can read it.
 * - The deploy sets the variables `OUTAGE_TOKEN` and `OUTAGE_FROM` of the environment.
 */

import { entryFunction, endedFunction, pressFunction, type FunctionReply, type OutagePorts, type OutageRequest } from "./function.ts";
import { outageListProblems, outageListSchema, type OutageList } from "./outage.ts";

/** The path of the private Asset that holds the list as JSON. */
export const OUTAGE_LIST_ASSET = "/outage-list.json";

/** The options of a new call, in the form of the helper library of Twilio. */
export interface RuntimeCallOptions {
  readonly to: string;
  readonly from: string;
  readonly twiml: string;
  readonly statusCallback: string;
  readonly statusCallbackMethod: "POST";
  readonly statusCallbackEvent: readonly string[];
  /** The seconds that the phone rings. */
  readonly timeout: number;
}

/** The calls of the helper library of Twilio that the Functions use. */
export interface RuntimeCalls {
  (sid: string): { update(options: { readonly statusCallback: string; readonly statusCallbackMethod: "POST" }): Promise<unknown> };
  create(options: RuntimeCallOptions): Promise<{ readonly sid: string }>;
  /** The helper library gives the newest calls first. */
  list(options: { readonly from: string; readonly limit: number }): Promise<readonly { readonly dateCreated: Date | null }[]>;
}

/** The part of the context of a Function that the outage Functions read. */
export interface RuntimeContext {
  readonly DOMAIN_NAME?: string | undefined;
  readonly OUTAGE_TOKEN?: string | undefined;
  readonly OUTAGE_FROM?: string | undefined;
  getTwilioClient(): { readonly calls: RuntimeCalls };
}

/** The response class of the Functions runtime: the global `Twilio.Response`. */
export interface RuntimeResponse {
  setStatusCode(status: number): void;
  appendHeader(name: string, value: string): void;
  setBody(body: string): void;
}

/** The globals of the Functions runtime that the handlers read. */
export interface RuntimeGlobals {
  /** This function gives the open function of each Asset, by its path. */
  readonly assets: () => Readonly<Record<string, { open(): string } | undefined>>;
  readonly response: () => RuntimeResponse;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/** The callback of a handler of the Functions runtime. */
export type RuntimeCallback = (error: unknown, response?: RuntimeResponse) => void;

/** The handler of a Function, in the form of the Functions runtime. */
export type RuntimeHandler = (context: RuntimeContext, event: Readonly<Record<string, unknown>>, callback: RuntimeCallback) => void;

/** The three outage Functions. */
export type OutageFunction = "entry" | "press" | "ended";

/** This function reads the list from the Asset, and checks it with the schema and with `outageListProblems`. It throws an error with each problem. */
export function readOutageList(assets: Readonly<Record<string, { open(): string } | undefined>>): OutageList {
  const asset = assets[OUTAGE_LIST_ASSET];
  if (asset === undefined) throw new Error(`The service has no Asset ${OUTAGE_LIST_ASSET}.`);
  const parsed = outageListSchema.safeParse(jsonOf(asset.open()));
  if (!parsed.success) throw new Error(`The Asset ${OUTAGE_LIST_ASSET} is not a list: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  const problems = outageListProblems(parsed.data);
  if (problems.length > 0) throw new Error(`The list has problems: ${problems.join(" ")}`);
  return parsed.data;
}

/**
 * This function reads the globals of the Functions runtime: `Runtime.getAssets()`, `Twilio.Response` and
 * the console. It throws an error when a global is absent, for example outside the runtime.
 */
export function twilioGlobals(): RuntimeGlobals {
  const runtime: unknown = Reflect.get(globalThis, "Runtime");
  const twilio: unknown = Reflect.get(globalThis, "Twilio");
  const getAssets: unknown = typeof runtime === "object" && runtime !== null ? Reflect.get(runtime, "getAssets") : undefined;
  const Response: unknown = typeof twilio === "object" && twilio !== null ? Reflect.get(twilio, "Response") : undefined;
  if (typeof getAssets !== "function" || typeof Response !== "function") throw new Error("The globals Runtime and Twilio of the Functions runtime are absent.");
  return {
    assets: () => Reflect.apply(getAssets, runtime, []),
    response: () => Reflect.construct(Response, []),
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}

/** This function makes the ports of the adapter from the context of a Function and the globals of the runtime. */
export function runtimePorts(context: RuntimeContext, globals: RuntimeGlobals): OutagePorts {
  const from = context.OUTAGE_FROM ?? "";
  const calls = (): RuntimeCalls => context.getTwilioClient().calls;
  return {
    list: async () => readOutageList(globals.assets()),
    recent: async (count) => {
      if (from === "") throw new Error("The environment has no variable OUTAGE_FROM.");
      const listed = await calls().list({ from, limit: count });
      return listed.flatMap((call) => (call.dateCreated === null ? [] : [call.dateCreated.getTime()]));
    },
    call: async (call) => {
      if (from === "") throw new Error("The environment has no variable OUTAGE_FROM.");
      await calls().create({
        to: call.to,
        from,
        twiml: call.twiml,
        statusCallback: call.statusCallback,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["completed"],
        timeout: call.ringSeconds,
      });
    },
    move: async (sid, statusCallback) => {
      await calls()(sid).update({ statusCallback, statusCallbackMethod: "POST" });
    },
    now: globals.now,
    log: globals.log,
  };
}

/** This function gives the handler of one outage Function. */
export function runtimeHandler(kind: OutageFunction, globals: () => RuntimeGlobals): RuntimeHandler {
  return (context, event, callback) => {
    if (context.DOMAIN_NAME === undefined || context.DOMAIN_NAME === "") {
      callback(new Error("The context has no DOMAIN_NAME."));
      return;
    }
    const live = globals();
    const ports = runtimePorts(context, live);
    const request: OutageRequest = { base: `https://${context.DOMAIN_NAME}`, params: event };
    replyOf(kind, ports, request, context.OUTAGE_TOKEN ?? "").then(
      (reply) => callback(null, responseOf(live, reply)),
      (error: unknown) => callback(error),
    );
  };
}

async function replyOf(kind: OutageFunction, ports: OutagePorts, request: OutageRequest, token: string): Promise<FunctionReply> {
  switch (kind) {
    case "entry":
      return entryFunction(ports, request, token);
    case "press":
      return pressFunction(ports, request);
    case "ended":
      return endedFunction(ports, request);
  }
}

// The message of a parse error of JSON can quote the text, and the text holds numbers. So the error has no message of the parse.
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The Asset ${OUTAGE_LIST_ASSET} is not valid JSON.`);
  }
}

function responseOf(globals: RuntimeGlobals, reply: FunctionReply): RuntimeResponse {
  const response = globals.response();
  response.setStatusCode(reply.status);
  response.appendHeader("Content-Type", reply.type);
  response.setBody(reply.body);
  return response;
}
