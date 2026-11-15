import { Problems, type Severity } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { CAP_SEVERITY, CAP_STATUS, capList, capTime, capValue } from "./values.ts";

const sink = (): Problems => new Problems();

describe("the readers of the CAP values", () => {
  it("reads a value in lower case", () => {
    const problems = sink();
    expect(capValue<Severity>(" Severe ", CAP_SEVERITY, "unknown", "severity", problems)).toBe("severe");
    expect(problems.list).toEqual([]);
  });

  it("gives the fallback and a problem for an unknown value", () => {
    const problems = sink();
    expect(capValue<Severity>("Awful", CAP_SEVERITY, "unknown", "severity", problems)).toBe("unknown");
    expect(problems.list).toEqual([{ path: "severity", message: 'the value "Awful" is not known: the map uses unknown', fatal: false, lossy: true }]);
  });

  it("gives the fallback and a lossy problem for an absent value, because CAP requires each value", () => {
    const problems = sink();
    expect(capValue<Severity>(undefined, CAP_SEVERITY, "unknown", "severity", problems)).toBe("unknown");
    expect(capValue(null, CAP_SEVERITY, "unknown", "severity", problems)).toBe("unknown");
    expect(capValue(" ", CAP_SEVERITY, "unknown", "severity", problems)).toBe("unknown");
    expect(capValue("", CAP_STATUS, "actual", "status", problems)).toBe("actual");
    const absent = (path: string, fallback: string) => ({ path, message: `the value is absent: the map uses ${fallback}`, fatal: false, lossy: true });
    expect(problems.list).toEqual([absent("severity", "unknown"), absent("severity", "unknown"), absent("severity", "unknown"), absent("status", "actual")]);
  });

  it("reads the times of CAP, and the times with Z and parts of a second", () => {
    const problems = sink();
    expect(capTime("2026-11-08T13:23:00-06:00", "sent", problems)).toBe(Date.parse("2026-11-08T19:23:00Z"));
    expect(capTime("2026-11-08T19:23:00.500Z", "sent", problems)).toBe(Date.parse("2026-11-08T19:23:00.500Z"));
    expect(capTime(undefined, "sent", problems)).toBeUndefined();
    expect(problems.list).toEqual([]);
  });

  it("gives a problem for a time with no zone or a bad time", () => {
    for (const text of ["2026-11-08T13:23:00", "2026-11-08", "2026-13-40T99:99:00Z", "soon"]) {
      const problems = sink();
      expect(capTime(text, "sent", problems), text).toBeUndefined();
      expect([problems.list.length, problems.lossy], text).toEqual([1, 1]);
    }
  });

  it("splits a list at spaces, with quotes for an item with spaces", () => {
    expect(capList(undefined)).toEqual([]);
    expect(capList("  a  b\tc ")).toEqual(["a", "b", "c"]);
    expect(capList('a "b c" d')).toEqual(["a", "b c", "d"]);
    expect(capList('a "" "open quote')).toEqual(["a", "open quote"]);
  });
});
