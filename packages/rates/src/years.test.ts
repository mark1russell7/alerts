import { describe, expect, it } from "vitest";

import { COW_YEARS, eachYear, lastFullYear, measureYears, NCEI_YEARS, parseYears } from "./years.ts";

describe("the years of the measures", () => {
  it("gives the last whole year after the lag of the source", () => {
    expect(lastFullYear(Date.UTC(2026, 10, 15), 2)).toBe(2025);
    expect(lastFullYear(Date.UTC(2027, 1, 28), 2)).toBe(2025);
    expect(lastFullYear(Date.UTC(2027, 2, 1), 2)).toBe(2026);
    expect(lastFullYear(Date.UTC(2027, 5, 30), 6)).toBe(2025);
    expect(lastFullYear(Date.UTC(2027, 6, 1), 6)).toBe(2026);
  });

  it("gives 5 years of Cow and 10 years of NCEI", () => {
    const now = Date.UTC(2026, 10, 15);
    expect(measureYears(now, COW_YEARS)).toEqual({ first: 2021, last: 2025 });
    expect(measureYears(now, NCEI_YEARS)).toEqual({ first: 2016, last: 2025 });
  });

  it("reads a range of years and gives each year", () => {
    expect(parseYears("2021-2025")).toEqual({ first: 2021, last: 2025 });
    expect(parseYears(" 2024 ")).toEqual({ first: 2024, last: 2024 });
    expect(() => parseYears("2025-2021")).toThrow(/not in order/);
    expect(() => parseYears("last year")).toThrow(/not in the form/);
    expect(eachYear({ first: 2023, last: 2025 })).toEqual([2023, 2024, 2025]);
  });
});
