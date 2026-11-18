import { SHARED_HANDOVER, type ChannelId, type CopyWatch, type Expectation, type ProviderBalance, type SourceId } from "@mark1russell7/alerts";
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

describe("the facts of a shared account in two copies (AL-62)", () => {
  const T0 = Date.UTC(2026, 10, 15, 12);
  const HOUR = 3_600_000;
  const LOW: ProviderBalance = { provider: "provider:twilio", title: "Twilio", channels: ["twilio-call" as ChannelId], floors: [5], maxAge: 48 * HOUR, since: T0, read: { balance: 1, currency: "USD", at: T0 } };
  const watch = (copy: string, read: number): CopyWatch => ({ copy, skewLimit: 2_000, maxAge: HOUR, since: T0, read: { at: read, skew: 0, sameConfig: true } });
  const lows = (view: ReturnType<typeof systemView>) => view.step.reports.filter((report) => report.kind.code === "system.balance.low").length;

  it("reports a low balance in the copy with the smaller id, and wakes the other copy at the handover", () => {
    const first = systemView(EMPTY_RUNTIME, CONFIG, T0, { balances: [LOW], copy: "copy-a", copies: [watch("copy-b", T0)] });
    expect(lows(first)).toBe(1);
    const second = systemView(EMPTY_RUNTIME, CONFIG, T0, { balances: [LOW], copy: "copy-b", copies: [watch("copy-a", T0)] });
    expect(lows(second)).toBe(0);
    expect(second.wakeAt).toBe(T0 + SHARED_HANDOVER);
    // The first copy is silent past the handover, thus the second copy reports.
    expect(lows(systemView(EMPTY_RUNTIME, CONFIG, T0 + SHARED_HANDOVER, { balances: [LOW], copy: "copy-b", copies: [watch("copy-a", T0)] }))).toBe(1);
  });

  it("reports in each copy with no copy watches, as before", () => {
    expect(lows(systemView(EMPTY_RUNTIME, CONFIG, T0, { balances: [LOW] }))).toBe(1);
    expect(lows(systemView(EMPTY_RUNTIME, CONFIG, T0, { balances: [LOW], copy: "copy-b" }))).toBe(1);
  });
});
