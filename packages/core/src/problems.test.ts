import { describe, expect, it } from "vitest";
import { Problems, type ProblemSink } from "./problems.ts";

describe("Problems", () => {
  it("puts the prefix before each path", () => {
    const problems = new Problems("features[3]");
    problems.add("properties.onset", "a bad time");
    problems.add("", "no report", true);
    expect(problems.list).toEqual([
      { path: "features[3].properties.onset", message: "a bad time", fatal: false },
      { path: "features[3]", message: "no report", fatal: true },
    ]);
  });

  it("keeps each path as it is when it has no prefix", () => {
    const problems = new Problems();
    problems.add("alert.info[0].severity", "an unknown value");
    problems.add("", "an empty path");
    expect(problems.list.map((problem) => problem.path)).toEqual(["alert.info[0].severity", ""]);
  });

  it("keeps the order of the problems and counts the fatal problems", () => {
    const problems = new Problems("m");
    for (const [index, fatal] of [false, true, false, true, true].entries()) problems.add(String(index), "p", fatal);
    expect(problems.list.map((problem) => problem.path)).toEqual(["m.0", "m.1", "m.2", "m.3", "m.4"]);
    expect(problems.fatal).toBe(3);
  });

  it("is a problem sink for a reader", () => {
    const read = (sink: ProblemSink): void => sink.add("x", "from a reader");
    const problems = new Problems("doc");
    read(problems);
    expect(problems.list).toEqual([{ path: "doc.x", message: "from a reader", fatal: false }]);
  });
});
