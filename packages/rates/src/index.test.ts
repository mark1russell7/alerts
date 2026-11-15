import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("exports the readers, the measures, the gate and the summary", () => {
    for (const name of ["readCow", "tallyCow", "sumDetails", "detailsFiles", "ratesFile", "checkRates", "ratesSummary", "measureYears"] as const) {
      expect(entry[name], name).toBeTypeOf("function");
    }
  });
});
