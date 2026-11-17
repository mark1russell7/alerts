import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { ChannelDescriptor } from "./contracts.ts";
import { OPT_IN_WORDS, optedIn, optInFields, optInProblems, optInTime, resolveOptIn, type OptInChange, type OptInRecord } from "./opt-in.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

// Made-up numbers in the range 555-0100 to 555-0199, which no person gets.
const A = "+15550100123";
const B = "+15550100145";
const YES_AT = "2026-11-17T21:30:00Z";
const YES = Date.parse(YES_AT);
const MINUTE = 60_000;

const record = (number: string, at = YES_AT): OptInRecord => ({ number, at, way: "written", words: "texts-consent/1" });
const change = (number: string, kind: OptInChange["kind"], at: number): OptInChange => ({ number, kind, at });

describe("optInTime", () => {
  it("reads a UTC time with seconds, and refuses each other form", () => {
    expect(optInTime({ at: YES_AT })).toBe(YES);
    expect(optInTime({ at: "2024-02-29T00:00:00Z" })).toBe(Date.UTC(2024, 1, 29));
    for (const at of ["2026-11-17T21:30Z", "2026-11-17T21:30:00", "2026-11-17T21:30:00.000Z", "2026-11-17T16:30:00-05:00", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2025-02-29T00:00:00Z", "", "yesterday"]) {
      expect(optInTime({ at }), at).toBeUndefined();
    }
  });
});

describe("optInProblems", () => {
  it("gives no problem for a good list", () => {
    expect(optInProblems([])).toEqual([]);
    expect(optInProblems([record(A), { ...record(B), way: "spoken" }])).toEqual([]);
    expect(OPT_IN_WORDS).toContain("texts-consent/1");
  });

  it("names the index of each bad record, and no number", () => {
    const problems = optInProblems([record(A), record("5550100145"), { ...record(B), at: "2026-11-17" }, { ...record("+15550100177"), words: "texts-consent/0" }, record(A)]);
    expect(problems).toEqual([
      "Record 2 of the opt-in list has no phone number in E.164 form.",
      "Record 3 of the opt-in list has no time in UTC with seconds, as 2026-11-17T21:30:00Z.",
      "Record 4 of the opt-in list names consent words of an unknown version.",
      "Records 1 and 5 of the opt-in list have the same number.",
    ]);
    for (const problem of problems) expect(problem).not.toMatch(/555/u);
  });
});

describe("resolveOptIn", () => {
  it("takes the number of a record from its secret, and names a secret with no value, and no number", () => {
    const secrets: Readonly<Record<string, string>> = { PHONE_A: A, EMPTY: "" };
    const lookup = (name: string): string | undefined => secrets[name];
    expect(resolveOptIn([{ ...record(A), number: { secret: "PHONE_A" } }, record(B)], lookup)).toEqual({ records: [record(A), record(B)], problems: [] });
    const resolved = resolveOptIn([{ ...record(A), number: { secret: "MISSING" } }, { ...record(A), number: { secret: "EMPTY" } }, record(B), { ...record(A), number: { secret: "PHONE_A" } }, record(A)], lookup);
    expect(resolved.records).toEqual([record(B), record(A), record(A)]);
    expect(resolved.problems).toEqual([
      "Record 1 of the opt-in list names the secret MISSING, and the secret store has no value for it.",
      "Record 2 of the opt-in list names the secret EMPTY, and the secret store has no value for it.",
      "Records 4 and 5 of the opt-in list have the same number.",
    ]);
    for (const problem of resolved.problems) expect(problem).not.toMatch(/555/u);
  });
});

describe("optedIn", () => {
  it("gives the opt-in only to a number with a record at or before the time", () => {
    expect(optedIn([record(A)], [], A, YES)).toBe(true);
    expect(optedIn([record(A)], [], A, YES - 1)).toBe(false);
    expect(optedIn([record(A)], [], B, YES + MINUTE)).toBe(false);
    expect(optedIn([], [change(A, "start", YES)], A, YES + MINUTE)).toBe(false);
    expect(optedIn([{ ...record(A), at: "not a time" }], [], A, YES + MINUTE)).toBe(false);
  });

  it("removes a number at a STOP, and puts it back at a later START", () => {
    const changes = [change(A, "start", YES + 3 * MINUTE), change(A, "stop", YES + MINUTE)];
    expect(optedIn([record(A)], changes, A, YES + MINUTE - 1)).toBe(true);
    expect(optedIn([record(A)], changes, A, YES + MINUTE)).toBe(false);
    expect(optedIn([record(A)], changes, A, YES + 2 * MINUTE)).toBe(false);
    expect(optedIn([record(A)], changes, A, YES + 3 * MINUTE)).toBe(true);
    // The STOP of one number does not change another number.
    expect(optedIn([record(A), record(B)], changes.slice(1), B, YES + 2 * MINUTE)).toBe(true);
  });

  it("gives STOP for a STOP and a START at the same time, and drops the changes before a new yes", () => {
    expect(optedIn([record(A)], [change(A, "start", YES + MINUTE), change(A, "stop", YES + MINUTE)], A, YES + MINUTE)).toBe(false);
    expect(optedIn([record(A)], [change(A, "stop", YES + MINUTE), change(A, "start", YES + MINUTE)], A, YES + MINUTE)).toBe(false);
    const again = record(A, "2026-11-17T21:40:00Z");
    expect(optedIn([again], [change(A, "stop", YES + MINUTE)], A, YES + 20 * MINUTE)).toBe(true);
    // A STOP at the time of the yes counts.
    expect(optedIn([record(A)], [change(A, "stop", YES)], A, YES + MINUTE)).toBe(false);
  });

  it("holds its laws over seeded histories of replies", () => {
    for (const seed of SEEDS) {
      const r = random(`opt-in:${seed}`);
      for (let round = 0; round < 100; round += 1) {
        const records = r.chance(0.8) ? [record(A)] : [];
        const changes = Array.from({ length: r.int(0, 6) }, () => change(r.pick([A, B]), r.pick(["stop", "start"] as const), YES + r.int(-3, 10) * MINUTE));
        const at = YES + r.int(-2, 12) * MINUTE;
        const context = `seed ${seed}, round ${round}`;
        const result = optedIn(records, changes, A, at);
        // The order of the changes does not matter.
        expect(optedIn(records, r.shuffle(changes), A, at), context).toBe(result);
        // The changes of another number do not matter.
        expect(optedIn(records, changes.filter((entry) => entry.number === A), A, at), context).toBe(result);
        // No record, or a time before the yes: no opt-in.
        if (records.length === 0 || at < YES) expect(result, context).toBe(false);
        // A STOP after each other change of the number, from the yes to the time: no opt-in.
        const counted = changes.filter((entry) => entry.number === A && entry.at >= YES && entry.at <= at);
        const latest = Math.max(...counted.map((entry) => entry.at));
        if (counted.some((entry) => entry.kind === "stop" && entry.at === latest)) expect(result, context).toBe(false);
        // A new yes after each change gives the opt-in back.
        const later = new Date(YES + 11 * MINUTE).toISOString().replace(".000Z", "Z");
        if (records.length > 0) expect(optedIn([record(A, later)], changes, A, YES + 12 * MINUTE), context).toBe(true);
      }
    }
  });
});

describe("optInFields", () => {
  it("gives the address fields with the opt-in", () => {
    const base: Pick<ChannelDescriptor, "address"> = {
      address: [
        { name: "to", required: true, pattern: "\\+[0-9]{8,15}", form: "a phone number", optIn: true },
        { name: "device", required: false, pattern: "[a-z]+", form: "a device name", optIn: false },
        { name: "user", required: false, pattern: "[a-z]+", form: "a user key" },
      ],
    };
    expect(optInFields(base).map((field) => field.name)).toEqual(["to"]);
    expect(optInFields({})).toEqual([]);
  });
});
