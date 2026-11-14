import { describe, expect, expectTypeOf, it } from "vitest";
import { LEVELS, type FetchOutcome, type Level, type ReportId, type SourceId } from "./index.ts";

describe("the levels", () => {
  it("go from the lowest to the highest, with no duplicate", () => {
    expect(LEVELS).toEqual(["digest", "notice", "urgent", "life-safety"]);
    expect(new Set(LEVELS).size).toBe(LEVELS.length);
  });

  it("order by their index, so the level already sent is a max", () => {
    const max = (a: Level, b: Level): Level => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);
    expect(max("notice", "life-safety")).toBe("life-safety");
    expect(max("urgent", "digest")).toBe("urgent");
  });
});

describe("the contracts", () => {
  it("keep the ids of different kinds apart", () => {
    expectTypeOf<SourceId>().not.toEqualTypeOf<ReportId>();
  });

  it("tell an empty answer from a failure", () => {
    const empty: FetchOutcome = { ok: true, observations: [], complete: true };
    const failed: FetchOutcome = { ok: false, failure: { kind: "timeout", message: "no answer in 10 s" } };
    expect(empty.ok).not.toBe(failed.ok);
  });
});
