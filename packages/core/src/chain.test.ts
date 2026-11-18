import { machineProblems, replay } from "@mark1russell7/algebra";
import { random, seedsFrom } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { CHAIN_MACHINE, chainNext, chainRun, outageAudit, TRY_ENDS, type TimedEnd, type TryChain, type TryRecord } from "./chain.ts";
import type { ChannelId, PersonId } from "./contracts.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const call = "twilio-call" as ChannelId;
const text = "twilio-sms" as ChannelId;
const CHAIN: TryChain = { steps: [call, call, text] };
const p1 = "person-1" as PersonId;
const p2 = "person-2" as PersonId;
const MINUTE = 60_000;

describe("CHAIN_MACHINE", () => {
  it("is a consistent machine document", () => {
    expect(machineProblems(CHAIN_MACHINE)).toEqual([]);
  });
});

describe("chainNext", () => {
  it("starts at the first step, and a chain with no step is exhausted at once", () => {
    expect(chainNext(CHAIN)).toEqual({ kind: "trying", step: 0, channel: call });
    expect(chainNext({ steps: [] })).toEqual({ kind: "exhausted" });
  });

  it("stops at a confirmation, and goes to the next step at each other end", () => {
    expect(chainNext(CHAIN, 0, "acked")).toEqual({ kind: "acked", step: 0 });
    expect(chainNext(CHAIN, 0, "unconfirmed")).toEqual({ kind: "trying", step: 1, channel: call });
    expect(chainNext(CHAIN, 1, "failed")).toEqual({ kind: "trying", step: 2, channel: text });
    expect(chainNext(CHAIN, 2, "sent")).toEqual({ kind: "exhausted" });
  });

  it("starts no try for a step that the chain does not have", () => {
    for (const step of [-1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(chainNext(CHAIN, step, "unconfirmed")).toEqual({ kind: "exhausted" });
      expect(chainNext(CHAIN, step, "acked")).toEqual({ kind: "exhausted" });
    }
  });
});

describe("the gate: a chain makes at most one try for each step, and only the transitions of its machine", () => {
  for (const seed of SEEDS) {
    it(`holds for random ends (seed ${seed})`, () => {
      const rng = random(seed);
      for (let round = 0; round < 200; round += 1) {
        const steps = Array.from({ length: Math.floor(rng.next() * 5) }, () => (rng.next() < 0.5 ? call : text));
        const ends: TimedEnd[] = Array.from({ length: Math.floor(rng.next() * 8) }, (_, i) => ({ end: TRY_ENDS[Math.floor(rng.next() * TRY_ENDS.length)]!, at: (i + 1) * MINUTE }));
        const run = chainRun({ steps }, 0, ends, `round ${round}`);
        expect(run.tries).toBeLessThanOrEqual(steps.length);
        expect(replay(CHAIN_MACHINE, run.transitions)).toEqual([]);
        expect(run.transitions.length - 1 + run.extra).toBe(ends.length);
      }
    });
  }
});

describe("chainRun", () => {
  it("counts the ends after a final state as faults of the records", () => {
    const run = chainRun(CHAIN, 0, [{ end: "acked", at: MINUTE }, { end: "unconfirmed", at: 2 * MINUTE }], "x");
    expect(run.state).toEqual({ kind: "acked", step: 0 });
    expect(run).toMatchObject({ tries: 1, extra: 1 });
  });
});

describe("outageAudit", () => {
  const chains = new Map([
    [p1, CHAIN],
    [p2, CHAIN],
  ]);
  const record = (person: PersonId, started: number, end: TryRecord["end"]): TryRecord => ({ person, started, end, at: started + MINUTE });

  it("finds the person who confirmed, the person with no confirmation and the outage with no try", () => {
    const records = [record(p1, 10_000, "unconfirmed"), record(p1, 80_000, "acked"), record(p2, 10_000, "failed"), record(p2, 80_000, "unconfirmed"), record(p2, 150_000, "sent")];
    expect(outageAudit([{ down: 0, up: 300_000 }, { down: 10 * MINUTE }], chains, records, 5 * MINUTE)).toEqual([
      { down: 0, person: p1, state: "acked", tries: 2, ackedAt: 140_000 },
      { down: 0, person: p2, state: "exhausted", tries: 3 },
      { down: 10 * MINUTE, person: p1, state: "untried", tries: 0 },
      { down: 10 * MINUTE, person: p2, state: "untried", tries: 0 },
    ]);
  });

  it("gives a try to one outage only: the next down time and the time within end it", () => {
    const records = [record(p1, 3 * MINUTE, "acked"), record(p1, 7 * MINUTE, "acked")];
    const reach = outageAudit([{ down: 2 * MINUTE }, { down: 0 }], new Map([[p1, CHAIN]]), records, 4 * MINUTE);
    expect(reach.map(({ down, state }) => [down, state])).toEqual([
      [0, "untried"],
      [2 * MINUTE, "acked"],
    ]);
  });

  it("shows an open chain, and a count of tries above the steps of the chain", () => {
    expect(outageAudit([{ down: 0 }], new Map([[p1, CHAIN]]), [record(p1, 1_000, "unconfirmed")], 5 * MINUTE)).toEqual([{ down: 0, person: p1, state: "open", tries: 1 }]);
    const many = [1, 2, 3, 4].map((i) => record(p1, i * 1_000, "unconfirmed"));
    expect(outageAudit([{ down: 0 }], new Map([[p1, CHAIN]]), many, 5 * MINUTE)[0]).toMatchObject({ state: "exhausted", tries: 4 });
  });
});
