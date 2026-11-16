import type { ChannelId, Instant, PersonId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { CHANNEL_ID } from "./descriptor.ts";
import { endedFunction, entryFunction, noteLine, pressFunction, scriptTwiml, tokenMatches, type OutagePorts, type PlacedCall } from "./function.ts";
import { OUTAGE_TEXTS, type OutageList, type OutageNote } from "./outage.ts";

// Fake numbers only: 555-0100 to 555-0199 are numbers of fiction.
const BASE = "https://outage-0000.twil.io";
const MINUTE = 60_000;
const TOKEN = "token-0000";
const p1 = "person-1" as PersonId;
const p2 = "person-2" as PersonId;
const steps = (count: number): ChannelId[] => Array.from({ length: count }, () => CHANNEL_ID);
const LIST: OutageList = {
  version: "v1",
  message: "The alert system is down.",
  people: [
    { person: p1, to: "+15555550123", chain: { steps: steps(2) } },
    { person: p2, to: "+15555550124", chain: { steps: steps(2) } },
  ],
  repeats: 2,
  ringSeconds: 45,
  maxCalls: 10,
  capWindow: 60 * MINUTE,
};
const AT = 1_000 * MINUTE;

interface Fake {
  readonly ports: OutagePorts;
  readonly placed: PlacedCall[];
  readonly moves: (readonly [string, string])[];
  readonly lines: string[];
}

function fake(overrides: Partial<OutagePorts> = {}): Fake {
  const placed: PlacedCall[] = [];
  const moves: (readonly [string, string])[] = [];
  const lines: string[] = [];
  const ports: OutagePorts = {
    list: async () => LIST,
    recent: async () => [],
    call: async (call) => {
      placed.push(call);
    },
    move: async (sid, url) => {
      moves.push([sid, url]);
    },
    now: () => AT,
    log: (line) => lines.push(line),
    ...overrides,
  };
  return { ports, placed, moves, lines };
}

const paramsOf = (url: string): Record<string, string> => Object.fromEntries(new URL(url).searchParams);
const actionOf = (twiml: string): string => {
  const match = /action="([^"]*)"/u.exec(twiml);
  if (match?.[1] === undefined) throw new Error("The TwiML has no action.");
  return match[1].replaceAll("&amp;", "&");
};
const noNumber = (lines: readonly string[]): void => {
  for (const line of lines) expect(line).not.toMatch(/5555550/u);
};

describe("entryFunction", () => {
  it("starts the first call of each person, and gives the count of the calls", async () => {
    const f = fake();
    const reply = await entryFunction(f.ports, { base: BASE, params: { token: TOKEN, status: "down" } }, TOKEN);
    expect(reply).toEqual({ status: 200, type: "application/json", body: JSON.stringify({ calls: 2 }) });
    expect(f.placed.map((call) => call.to)).toEqual(["+15555550123", "+15555550124"]);
    const [first] = f.placed;
    expect(first!.ringSeconds).toBe(45);
    expect(first!.twiml).toContain('<Gather input="dtmf" numDigits="1"');
    expect(first!.twiml).toContain(`<Say>The alert system is down. ${OUTAGE_TEXTS.prompt}</Say>`);
    expect(new URL(actionOf(first!.twiml)).pathname).toBe("/press");
    expect(paramsOf(first!.statusCallback)).toEqual({ outage: String(AT), person: "0", step: "0", round: "0", list: "v1" });
    noNumber(f.lines);
  });

  it("starts the calls of a webhook with no field status", async () => {
    const f = fake();
    expect((await entryFunction(f.ports, { base: BASE, params: { token: TOKEN } }, TOKEN)).status).toBe(200);
    expect(f.placed).toHaveLength(2);
  });

  it("refuses a wrong token, a token that is not a text, and each request when the entry has no token", async () => {
    for (const [params, token] of [[{ token: "token-0001" }, TOKEN], [{}, TOKEN], [{ token: 7 }, TOKEN], [{ token: "" }, ""]] as const) {
      const f = fake();
      expect((await entryFunction(f.ports, { base: BASE, params }, token)).status).toBe(403);
      expect(f.placed).toEqual([]);
    }
    const f = fake();
    await entryFunction(f.ports, { base: BASE, params: { token: "" } }, "");
    expect(f.lines).toEqual(["The entry has no token, so it refuses each request."]);
  });

  it("starts no call for a status other than down, for example the webhook of the up event", async () => {
    const f = fake();
    const reply = await entryFunction(f.ports, { base: BASE, params: { token: TOKEN, status: "up" } }, TOKEN);
    expect(reply).toEqual({ status: 200, type: "application/json", body: JSON.stringify({ calls: 0, ignored: "status" }) });
    expect(f.placed).toEqual([]);
  });

  it("gives 500 when the list cannot be read, and the log tells why", async () => {
    const f = fake({ list: () => Promise.reject(new Error("no asset")) });
    expect((await entryFunction(f.ports, { base: BASE, params: { token: TOKEN } }, TOKEN)).status).toBe(500);
    expect(f.lines).toEqual(["The read of the list failed: no asset"]);
  });

  it("counts no call when the read of the recent calls fails, so the outage still calls", async () => {
    const f = fake({ recent: () => Promise.reject(new Error("timeout")) });
    await entryFunction(f.ports, { base: BASE, params: { token: TOKEN } }, TOKEN);
    expect(f.placed).toHaveLength(2);
    expect(f.lines[0]).toBe("The read of the recent calls failed, so the cap counts no call: timeout");
  });

  it("counts the recent calls against the cap", async () => {
    const f = fake({ recent: async (count) => Array.from({ length: Math.min(count, 9) }, (_, i): Instant => AT - i * MINUTE) });
    await entryFunction(f.ports, { base: BASE, params: { token: TOKEN } }, TOKEN);
    expect(f.placed.map((call) => call.to)).toEqual(["+15555550123"]);
    expect(f.lines).toContain(`The cap stopped a call of the person ${p2}.`);
  });

  it("continues with the next person when a call fails, and the log line has no number", async () => {
    let first = true;
    const f = fake();
    const ports: OutagePorts = {
      ...f.ports,
      call: async (call) => {
        if (first) {
          first = false;
          throw new Error(`The 'To' number ${call.to} is not valid. Digits ${call.to.slice(1)}.`);
        }
        await f.ports.call(call);
      },
    };
    const reply = await entryFunction(ports, { base: BASE, params: { token: TOKEN } }, TOKEN);
    expect(reply.body).toBe(JSON.stringify({ calls: 1 }));
    expect(f.placed.map((call) => call.to)).toEqual(["+15555550124"]);
    expect(f.lines).toContain(`The call action of the person ${p1} failed: The 'To' number [number] is not valid. Digits [number].`);
    noNumber(f.lines);
  });
});

describe("pressFunction", () => {
  const cursor = { outage: String(AT), person: "0", step: "0", round: "0", list: "v1" };

  it("moves the status callback of the live call for a 1, and says the confirmed text", async () => {
    const f = fake();
    const reply = await pressFunction(f.ports, { base: BASE, params: { ...cursor, Digits: "1", CallSid: "CA0000" } });
    expect(f.moves).toHaveLength(1);
    expect(f.moves[0]![0]).toBe("CA0000");
    expect(paramsOf(f.moves[0]![1])).toEqual({ ...cursor, acked: "1" });
    expect(reply.type).toBe("text/xml");
    expect(reply.body).toContain(`<Say>${OUTAGE_TEXTS.confirmed}</Say>`);
  });

  it("says the text unrecorded when the move fails or the request has no call SID", async () => {
    const failing = fake({ move: () => Promise.reject(new Error("refused")) });
    const failed = await pressFunction(failing.ports, { base: BASE, params: { ...cursor, Digits: "1", CallSid: "CA0000" } });
    expect(failed.body).toContain(`<Say>${OUTAGE_TEXTS.unrecorded}</Say>`);
    expect(failing.lines).toEqual([`The ack action of the person ${p1} failed: refused`]);
    const f = fake();
    const noSid = await pressFunction(f.ports, { base: BASE, params: { ...cursor, Digits: "1" } });
    expect(noSid.body).toContain(`<Say>${OUTAGE_TEXTS.unrecorded}</Say>`);
    expect(f.moves).toEqual([]);
  });

  it("gives the prompt again for another key, with the next round in the action", async () => {
    const f = fake();
    const reply = await pressFunction(f.ports, { base: BASE, params: { ...cursor, Digits: "2", CallSid: "CA0000" } });
    expect(reply.body).toContain("<Gather");
    expect(paramsOf(actionOf(reply.body))).toEqual({ ...cursor, round: "1" });
    expect(f.moves).toEqual([]);
  });

  it("says the text unrecorded when the list cannot be read", async () => {
    const f = fake({ list: () => Promise.reject(new Error("no asset")) });
    expect((await pressFunction(f.ports, { base: BASE, params: { ...cursor, Digits: "1" } })).body).toContain(`<Say>${OUTAGE_TEXTS.unrecorded}</Say>`);
  });
});

describe("endedFunction", () => {
  const cursor = { outage: String(AT), person: "1", step: "0", round: "0", list: "v1" };

  it("starts the next call of the chain after a call with no key press", async () => {
    const f = fake();
    const reply = await endedFunction(f.ports, { base: BASE, params: { ...cursor, CallStatus: "no-answer" } });
    expect(reply.body).toBe(JSON.stringify({ calls: 1 }));
    expect(f.placed.map((call) => call.to)).toEqual(["+15555550124"]);
    expect(paramsOf(f.placed[0]!.statusCallback)).toEqual({ ...cursor, step: "1" });
  });

  it("starts no call after a confirmed call, after the last step and for a stale cursor", async () => {
    for (const params of [{ ...cursor, CallStatus: "completed", acked: "1" }, { ...cursor, step: "1", CallStatus: "busy" }, { ...cursor, list: "v0", CallStatus: "busy" }]) {
      const f = fake();
      expect((await endedFunction(f.ports, { base: BASE, params })).body).toBe(JSON.stringify({ calls: 0 }));
      expect(f.placed).toEqual([]);
      expect(f.lines).toHaveLength(1);
    }
  });
});

describe("one outage through the three Functions", () => {
  it("calls each person until a key press, and stops the calls of the person who pressed 1", async () => {
    const f = fake();
    await entryFunction(f.ports, { base: BASE, params: { token: TOKEN } }, TOKEN);
    const [first, second] = f.placed;
    // The person 1 presses 1. Twilio then sends the end of the call to the moved status callback.
    await pressFunction(f.ports, { base: BASE, params: { ...paramsOf(actionOf(first!.twiml)), Digits: "1", CallSid: "CA0001" } });
    await endedFunction(f.ports, { base: BASE, params: { ...paramsOf(f.moves[0]![1]), CallStatus: "completed" } });
    // The person 2 does not answer, and the chain calls again. The second call goes to voicemail.
    await endedFunction(f.ports, { base: BASE, params: { ...paramsOf(second!.statusCallback), CallStatus: "no-answer" } });
    const third = f.placed[2]!;
    await endedFunction(f.ports, { base: BASE, params: { ...paramsOf(third.statusCallback), CallStatus: "completed" } });
    expect(f.placed.map((call) => call.to)).toEqual(["+15555550123", "+15555550124", "+15555550124"]);
    expect(f.lines).toContain(`The person ${p1} confirmed at step 0.`);
    expect(f.lines).toContain(`The chain of the person ${p2} ended with no confirmation.`);
    noNumber(f.lines);
  });
});

describe("scriptTwiml", () => {
  it("renders a say script with its voice, and escapes the text", () => {
    expect(scriptTwiml({ kind: "say", text: "Up & down", voice: "Polly.Joanna" })).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Up &amp; down</Say></Response>');
  });

  it("renders a gather script with its repeats, its action and the text after it", () => {
    const twiml = scriptTwiml({ kind: "gather", text: "Down.", action: `${BASE}/press?a=1&b=2`, repeats: 2, after: "Bye." });
    expect(twiml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="dtmf" numDigits="1" timeout="5" action="${BASE}/press?a=1&amp;b=2" method="POST"><Say>Down.</Say><Pause length="1"/><Say>Down.</Say></Gather><Say>Bye.</Say></Response>`,
    );
  });
});

describe("tokenMatches", () => {
  it("is true only for the same text, and false for an empty token of the entry", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}0`, TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches(["token-0000"], TOKEN)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });
});

describe("noteLine", () => {
  it("names the kind and the person of each note", () => {
    const notes: OutageNote[] = [
      { kind: "capped", person: p1 },
      { kind: "acked", person: p1, step: 1 },
      { kind: "exhausted", person: p1 },
      { kind: "stale" },
      { kind: "open", status: "ringing" },
    ];
    expect(notes.map(noteLine)).toEqual([
      `The cap stopped a call of the person ${p1}.`,
      `The person ${p1} confirmed at step 1.`,
      `The chain of the person ${p1} ended with no confirmation.`,
      "The request has no valid cursor of this list, so no call starts.",
      "The status ringing is not the end of a call, so no step follows.",
    ]);
  });
});
