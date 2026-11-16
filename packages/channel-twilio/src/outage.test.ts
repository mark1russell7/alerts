import type { ChannelId, PersonId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { CHANNEL_ID } from "./index.ts";
import {
  callEnd,
  cursorQuery,
  MAX_PRESS_ROUNDS,
  OUTAGE_TEXTS,
  outageEnded,
  outageListProblems,
  outagePress,
  outageStart,
  parseCursor,
  type CallScript,
  type OutageAction,
  type OutageList,
} from "./outage.ts";

// Fake numbers only: 555-0100 to 555-0199 are numbers of fiction.
const BASE = "https://outage-0000.twil.io";
const MINUTE = 60_000;
const p1 = "person-1" as PersonId;
const p2 = "person-2" as PersonId;
const steps = (count: number): ChannelId[] => Array.from({ length: count }, () => CHANNEL_ID);
const LIST: OutageList = {
  version: "v1",
  message: "The alert system is down.",
  people: [
    { person: p1, to: "+15555550123", chain: { steps: steps(3) } },
    { person: p2, to: "+15555550124", chain: { steps: steps(2) } },
  ],
  repeats: 3,
  ringSeconds: 45,
  maxCalls: 10,
  capWindow: 60 * MINUTE,
};
const AT = 1_000 * MINUTE;

const paramsOf = (url: string): Record<string, string> => Object.fromEntries(new URL(url).searchParams);
const calls = (actions: readonly OutageAction[]): Extract<OutageAction, { kind: "call" }>[] => actions.flatMap((action) => (action.kind === "call" ? [action] : []));
const actionOf = (script: CallScript | undefined): string => {
  if (script?.kind !== "gather") throw new Error("The script is not a gather.");
  return script.action;
};

describe("outageStart", () => {
  it("makes the first call of each person, with the cursor of the try in each callback", () => {
    const step = outageStart(LIST, BASE, AT, []);
    expect(step.notes).toEqual([]);
    expect(step.actions.map((action) => action.person)).toEqual([p1, p2]);
    const [first] = calls(step.actions);
    expect(first).toMatchObject({ to: "+15555550123", ringSeconds: 45 });
    expect(new URL(first!.statusCallback).pathname).toBe("/ended");
    expect(paramsOf(first!.statusCallback)).toEqual({ outage: String(AT), person: "0", step: "0", round: "0", list: "v1" });
    expect(first!.script).toEqual({ kind: "gather", text: `The alert system is down. ${OUTAGE_TEXTS.prompt}`, action: expect.stringContaining(`${BASE}/press?`), repeats: 3, after: OUTAGE_TEXTS.noPress });
    expect(paramsOf(actionOf(first!.script))).toEqual({ outage: String(AT), person: "0", step: "0", round: "0", list: "v1" });
  });

  it("counts the calls of the cap window, and stops each try above the cap", () => {
    const recent = [AT - 61 * MINUTE, AT - 30 * MINUTE, ...Array.from({ length: 8 }, (_, i) => AT - i * MINUTE)];
    const step = outageStart(LIST, BASE, AT, recent);
    expect(step.actions.map((action) => action.person)).toEqual([p1]);
    expect(step.notes).toEqual([{ kind: "capped", person: p2 }]);
  });

  it("gives the voice and the texts of the list to the script", () => {
    const list = { ...LIST, voice: "Polly.Joanna", language: "en-US", texts: { prompt: "Press 1." } };
    expect(calls(outageStart(list, BASE, AT, []).actions)[0]!.script).toMatchObject({ text: "The alert system is down. Press 1.", voice: "Polly.Joanna", language: "en-US", after: OUTAGE_TEXTS.noPress });
  });
});

describe("outagePress", () => {
  const press = (Digits: string | undefined, round = 0, list = LIST) => {
    const params = { ...Object.fromEntries(cursorQuery({ outage: AT, person: 0, step: 1, round }, "v1")), ...(Digits === undefined ? {} : { Digits }) };
    return outagePress(list, BASE, params);
  };

  it("confirms a 1: it moves the status callback of the live call to the URL with acked=1", () => {
    const step = press("1");
    expect(step.script).toEqual({ kind: "say", text: OUTAGE_TEXTS.confirmed });
    expect(step.actions).toEqual([{ kind: "ack", person: p1, statusCallback: expect.stringContaining(`${BASE}/ended?`) }]);
    expect(paramsOf(step.actions[0]!.statusCallback)).toEqual({ outage: String(AT), person: "0", step: "1", round: "0", list: "v1", acked: "1" });
  });

  it("asks again after another key, and ends after the last round", () => {
    const again = press("2");
    expect(again.actions).toEqual([]);
    expect(paramsOf(actionOf(again.script))).toMatchObject({ step: "1", round: "1" });
    expect(press("#", MAX_PRESS_ROUNDS - 1).script).toEqual({ kind: "say", text: OUTAGE_TEXTS.noPress });
    expect(press(undefined, MAX_PRESS_ROUNDS - 1).actions).toEqual([]);
  });

  it("starts no action for a press with no valid cursor", () => {
    expect(press("1", 0, { ...LIST, version: "v2" })).toEqual({ actions: [], script: { kind: "say", text: OUTAGE_TEXTS.confirmed }, notes: [{ kind: "stale" }] });
    expect(press("2", 0, { ...LIST, version: "v2" }).script).toEqual({ kind: "say", text: LIST.message });
    expect(outagePress(LIST, BASE, { ...Object.fromEntries(cursorQuery({ outage: AT, person: 5, step: 0, round: 0 }, "v1")), Digits: "1" }).actions).toEqual([]);
  });
});

describe("outageEnded", () => {
  const ended = (step: number, CallStatus: string, acked = false, recent: number[] = [], person = 0) =>
    outageEnded(LIST, BASE, { ...Object.fromEntries(cursorQuery({ outage: AT, person, step, round: 2 }, "v1", acked)), CallStatus }, AT + MINUTE, recent);

  it("makes the next call of the chain after a call with no confirmation", () => {
    for (const status of ["completed", "busy", "no-answer", "failed", "canceled"]) {
      const step = ended(0, status);
      expect(step.notes, status).toEqual([]);
      const [next] = calls(step.actions);
      expect(paramsOf(next!.statusCallback), status).toEqual({ outage: String(AT), person: "0", step: "1", round: "0", list: "v1" });
    }
  });

  it("stops at a confirmation and at the last step", () => {
    expect(ended(1, "completed", true)).toEqual({ actions: [], notes: [{ kind: "acked", person: p1, step: 1 }] });
    expect(ended(2, "no-answer")).toEqual({ actions: [], notes: [{ kind: "exhausted", person: p1 }] });
    expect(ended(1, "busy", false, [], 1)).toEqual({ actions: [], notes: [{ kind: "exhausted", person: p2 }] });
  });

  it("starts no call for a status that is not an end, a stale cursor, a step out of the chain and a full cap", () => {
    expect(ended(0, "in-progress")).toEqual({ actions: [], notes: [{ kind: "open", status: "in-progress" }] });
    expect(outageEnded({ ...LIST, version: "v2" }, BASE, { ...Object.fromEntries(cursorQuery({ outage: AT, person: 0, step: 0, round: 0 }, "v1")), CallStatus: "busy" }, AT, [])).toEqual({ actions: [], notes: [{ kind: "stale" }] });
    expect(ended(7, "busy")).toEqual({ actions: [], notes: [{ kind: "exhausted", person: p1 }] });
    expect(ended(0, "busy", false, Array.from({ length: 10 }, () => AT))).toEqual({ actions: [], notes: [{ kind: "capped", person: p1 }] });
  });
});

describe("callEnd", () => {
  it("maps each final status of a call to the end of a try", () => {
    expect(["completed", "busy", "no-answer", "failed", "canceled", "queued", "ringing", "in-progress", ""].map((status) => callEnd(status, false))).toEqual([
      "unconfirmed",
      "unconfirmed",
      "unconfirmed",
      "failed",
      "failed",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(callEnd("completed", true)).toBe("acked");
    expect(callEnd("no-answer", true)).toBe("unconfirmed");
  });
});

describe("the cursor", () => {
  it("reads back each cursor that it writes", () => {
    for (const cursor of [{ outage: 0, person: 0, step: 0, round: 0 }, { outage: Number.MAX_SAFE_INTEGER, person: 12, step: 3, round: 2 }]) {
      expect(parseCursor(Object.fromEntries(cursorQuery(cursor, "v1")), "v1")).toEqual(cursor);
    }
  });

  it("refuses a field that is not a whole number in decimal, and another version", () => {
    const good = Object.fromEntries(cursorQuery({ outage: AT, person: 0, step: 1, round: 0 }, "v1"));
    for (const step of ["01", "-1", "1.5", "1e3", " 1", "", "99999999999999999", "0x1"]) expect(parseCursor({ ...good, step }, "v1"), step).toBeUndefined();
    expect(parseCursor({ ...good, step: 2 }, "v1")).toBeUndefined();
    expect(parseCursor({ ...good, list: "v0" }, "v1")).toBeUndefined();
    expect(parseCursor(Object.fromEntries(Object.entries(good).filter(([key]) => key !== "round")), "v1")).toBeUndefined();
  });
});

// The outcome of one call in the gate: a key press of 1, or the final status of a call with no press.
type Outcome = "press" | "completed" | "busy" | "no-answer" | "failed";
const OUTCOMES: readonly Outcome[] = ["press", "completed", "busy", "no-answer", "failed"];

function sequences(length: number): Outcome[][] {
  if (length === 0) return [[]];
  return sequences(length - 1).flatMap((rest) => OUTCOMES.map((outcome) => [outcome, ...rest]));
}

// One outage through the handlers, as the Function applies them. Each call takes the next outcome of its person.
// The calls list of Twilio holds each call from its creation, so each new call counts against the cap at once.
function simulate(list: OutageList, outcomes: ReadonlyMap<PersonId, readonly Outcome[]>): Map<PersonId, number> {
  const made = new Map<PersonId, number>();
  const placed: number[] = [];
  const queue: Extract<OutageAction, { kind: "call" }>[] = [];
  let at = AT;
  const enqueue = (actions: readonly OutageAction[]): void => {
    for (const call of calls(actions)) {
      placed.push(at);
      queue.push(call);
    }
  };
  enqueue(outageStart(list, BASE, at, placed).actions);
  while (queue.length > 0) {
    const call = queue.shift()!;
    const index = made.get(call.person) ?? 0;
    made.set(call.person, index + 1);
    at += MINUTE;
    const outcome = outcomes.get(call.person)?.[index] ?? "no-answer";
    let callback = call.statusCallback;
    if (outcome === "press") {
      const pressed = outagePress(list, BASE, { ...paramsOf(actionOf(call.script)), Digits: "1" });
      callback = pressed.actions.find((action) => action.kind === "ack")!.statusCallback;
    }
    const status = outcome === "press" ? "completed" : outcome;
    enqueue(outageEnded(list, BASE, { ...paramsOf(callback), CallStatus: status }, at, placed).actions);
  }
  return made;
}

describe("the gate: the calls of a person stop at the first key press, and each step makes one call", () => {
  it("holds for each sequence of outcomes of a chain of 1 to 4 calls", () => {
    for (const length of [1, 2, 3, 4]) {
      const list = { ...LIST, people: [{ person: p1, to: "+15555550123", chain: { steps: steps(length) } }], maxCalls: 100 };
      for (const sequence of sequences(length)) {
        const pressed = sequence.indexOf("press");
        expect(simulate(list, new Map([[p1, sequence]])).get(p1), sequence.join(" ")).toBe(pressed === -1 ? length : pressed + 1);
      }
    }
  });

  it("holds for two people, and the cap bounds the calls of the outage", () => {
    for (const first of sequences(3)) {
      const made = simulate(LIST, new Map([[p1, first], [p2, ["no-answer", "press"]]]));
      const pressed = first.indexOf("press");
      expect(made.get(p1)).toBe(pressed === -1 ? 3 : pressed + 1);
      expect(made.get(p2)).toBe(2);
    }
    const capped = simulate({ ...LIST, maxCalls: 3 }, new Map());
    expect((capped.get(p1) ?? 0) + (capped.get(p2) ?? 0)).toBe(3);
  });
});

describe("outageListProblems", () => {
  it("finds no problem in a valid list", () => {
    expect(outageListProblems(LIST)).toEqual([]);
  });

  it("finds each problem of a list, and names no phone number", () => {
    const bad: OutageList = {
      version: " ",
      message: "Down\u0007",
      people: [
        { person: p1, to: "+1555555012", chain: { steps: [CHANNEL_ID, "pushover" as ChannelId] } },
        { person: p1, to: "+15555550124", chain: { steps: [] } },
      ],
      repeats: 0,
      ringSeconds: 4,
      maxCalls: 1,
      capWindow: 0,
      texts: { confirmed: "" },
    };
    const problems = outageListProblems(bad);
    expect(problems).toEqual([
      "The list has no version.",
      "The text message has a control character, and TwiML cannot hold it.",
      "The text confirmed is empty.",
      "The person person-1: The field to of the address on twilio-call is not a phone number in E.164 form: a plus sign, the country code and the number.",
      "Step 1 of the person person-1 uses the channel pushover. The outage call makes only calls on twilio-call.",
      "The list has the person person-1 two times.",
      "The chain of the person person-1 has no step, so no call reaches the person.",
      "The repeats are not a whole number from 1 to 5.",
      "The ring seconds are not a whole number from 5 to 600.",
      "The time of the cap is not more than 0.",
      "The cap of 1 calls is below the 2 calls of one outage, so the cap stops tries of one outage.",
    ]);
    expect(problems.join(" ")).not.toMatch(/555/);
  });

  it("finds a message that is too long and a list with no person", () => {
    expect(outageListProblems({ ...LIST, message: "x".repeat(600) })).toEqual(["The message and the prompt have more than 600 characters."]);
    expect(outageListProblems({ ...LIST, people: [], maxCalls: 1 })).toEqual(["The list has no person, so no outage call reaches a person."]);
  });
});
