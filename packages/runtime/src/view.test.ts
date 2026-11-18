import type { Expectation, SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { EMPTY_RUNTIME } from "./state.ts";
import { DELAY_LIMITS, systemView, type ViewConfig } from "./view.ts";

const EXPECT: Expectation = { id: "api-to-wea", from: "api" as SourceId, to: "wea" as SourceId, when: { statuses: ["actual"] } };
const CONFIG: ViewConfig = { sources: [], places: [], kinds: [], expectations: [EXPECT], delay: DELAY_LIMITS };

describe("the folds of the lateness from one view to the next", () => {
  it("keeps one rule for each policy, thus the next view continues each fold", () => {
    const first = systemView(EMPTY_RUNTIME, CONFIG, 1_000);
    const second = systemView(EMPTY_RUNTIME, CONFIG, 2_000, { folds: first.folds });
    expect(second.folds.get(EXPECT.id)!.limitOf).toBe(first.folds.get(EXPECT.id)!.limitOf);
    expect(second.lateness).toEqual(systemView(EMPTY_RUNTIME, CONFIG, 2_000).lateness);
  });

  it("gives another rule for another policy, thus each fold starts again", () => {
    const first = systemView(EMPTY_RUNTIME, CONFIG, 1_000);
    const other = systemView(EMPTY_RUNTIME, { ...CONFIG, delay: { ...DELAY_LIMITS } }, 2_000, { folds: first.folds });
    expect(other.folds.get(EXPECT.id)!.limitOf).not.toBe(first.folds.get(EXPECT.id)!.limitOf);
  });
});
