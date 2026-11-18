import { PRIORS_FORMAT, type ScorePriors } from "@mark1russell7/alerts";
import { committedPriors } from "@mark1russell7/alerts-rates";
import { describe, expect, it } from "vitest";
import { loadPriors } from "./priors.ts";

describe("loadPriors", () => {
  it("gives the committed priors of the package rates", () => {
    const reports: string[] = [];
    expect(loadPriors((message) => reports.push(message))).toEqual(committedPriors());
    expect(reports).toEqual([]);
  });

  it("gives the priors of the read", () => {
    const priors: ScorePriors = { format: PRIORS_FORMAT, kinds: {}, certainty: {} };
    expect(loadPriors(() => undefined, () => priors)).toBe(priors);
  });

  it("reports a fault of the read and gives no priors, so each alert goes on", () => {
    const reports: string[] = [];
    const priors = loadPriors(
      (message) => reports.push(message),
      () => {
        throw new Error("The file is not there.");
      },
    );
    expect(priors).toBeUndefined();
    expect(reports).toEqual(["The priors of the shadow score do not load (The file is not there.). The runtime gives no shadow score, and each alert goes on."]);
  });
});
