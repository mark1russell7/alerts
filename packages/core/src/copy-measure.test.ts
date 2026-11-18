import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { ObservationId, Report, SourceId } from "./contracts.ts";
import { copyMeasure, sentFails, type SentCounts } from "./copy-measure.ts";
import { reportId } from "./ids.ts";
import type { Expectation } from "./lateness.ts";
import type { LinkRule } from "./merge.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const API = "api" as SourceId;
const STREAM = "stream" as SourceId;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const ZERO: SentCounts = { messages: 0, same: 0, shifted: 0, lost: 0, apart: 0, none: 0, censored: 0 };

// The second source carries each actual message of the first source, with the same key.
const EXPECT: Expectation = { id: "api.stream", from: API, to: STREAM, when: { statuses: ["actual"] } };

interface Shape {
  readonly sent: number;
  readonly received: number;
  /** The correlation key. Two reports with one correlation key are in one incident. */
  readonly event?: string;
  readonly fields?: Partial<Report>;
}

// One report of a public place in Kansas (Sedgwick County KS). Each test gives the key, the times and the event.
function report(source: SourceId, key: string, shape: Shape): Report {
  return {
    id: reportId({ source, key, sent: shape.sent }),
    source,
    origin: "nws",
    key,
    references: [],
    correlation: [{ system: "vtec", id: shape.event ?? "event-a" }],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: shape.sent,
    received: shape.received,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: `observation:${source}:${key}:${String(shape.received)}` as ObservationId,
    parameters: {},
    ...shape.fields,
  };
}

describe("copyMeasure: the class of each message", () => {
  it("finds the copy at the same sent time, and gives its delay", () => {
    const result = copyMeasure([report(API, "m1", { sent: 0, received: 30 * SECOND }), report(STREAM, "m1", { sent: 0, received: 50 * SECOND })], EXPECT);
    expect(result.counts).toEqual({ ...ZERO, messages: 1, same: 1 });
    expect(result.checks.map((check) => [check.key, check.class, check.delay])).toEqual([["m1", "same", 20 * SECOND]]);
    expect(result.checks[0]?.copies).toEqual([{ key: "m1", sent: 0 }]);
    expect(result.gaps).toEqual([]);
    expect(sentFails(result.counts)).toBe(false);
  });

  it("gives a delay below 0 when the copy came first", () => {
    const result = copyMeasure([report(API, "m1", { sent: 0, received: 50 * SECOND }), report(STREAM, "m1", { sent: 0, received: 20 * SECOND })], EXPECT);
    expect(result.checks.map((check) => [check.class, check.delay])).toEqual([["same", -30 * SECOND]]);
  });

  it("gives `shifted` to a copy with the key of the message at a different sent time", () => {
    const result = copyMeasure([report(API, "m1", { sent: 0, received: 0 }), report(STREAM, "m1", { sent: SECOND, received: SECOND })], EXPECT);
    expect(result.counts).toEqual({ ...ZERO, messages: 1, shifted: 1 });
    expect(result.gaps.map((gap) => [gap.key, gap.class, gap.match, gap.difference])).toEqual([["m1", "shifted", "id", SECOND]]);
    expect(result.checks[0]?.delay).toBeUndefined();
    expect(sentFails(result.counts)).toBe(true);
  });

  it("gives `lost` when the incident has copies, but not the copy of the message", () => {
    const reports = [
      report(API, "m1", { sent: 0, received: 0 }),
      report(API, "m2", { sent: 10 * MINUTE, received: 10 * MINUTE }),
      report(STREAM, "m1", { sent: 0, received: 0 }),
    ];
    const result = copyMeasure(reports, EXPECT);
    expect(result.counts).toEqual({ ...ZERO, messages: 2, same: 1, lost: 1 });
    expect(result.gaps.map((gap) => [gap.key, gap.class, gap.match, gap.copy.key, gap.difference])).toEqual([["m2", "lost", "nearest", "m1", -10 * MINUTE]]);
    expect(sentFails(result.counts)).toBe(true);
  });

  it("gives `apart` to a copy with the key of the message in a different incident", () => {
    const result = copyMeasure([report(API, "m1", { sent: 0, received: 0 }), report(STREAM, "m1", { sent: 0, received: 0, event: "event-b" })], EXPECT);
    expect(result.counts).toEqual({ ...ZERO, messages: 1, apart: 1 });
    expect(result.gaps.map((gap) => [gap.class, gap.match, gap.difference])).toEqual([["apart", "id", 0]]);
    expect(sentFails(result.counts)).toBe(false);
  });

  it("gives `none` to a message with no copy, and `censored` to a late message with no copy", () => {
    const reports = [report(API, "m1", { sent: 0, received: 0 }), report(API, "m2", { sent: 20 * MINUTE, received: 20 * MINUTE, event: "event-b" })];
    expect(copyMeasure(reports, EXPECT).counts).toEqual({ ...ZERO, messages: 2, none: 2 });
    expect(copyMeasure(reports, EXPECT, { censorAfter: 10 * MINUTE }).counts).toEqual({ ...ZERO, messages: 2, none: 1, censored: 1 });
  });

  it("does not censor a message when its copy came", () => {
    const reports = [report(API, "m1", { sent: 20 * MINUTE, received: 20 * MINUTE }), report(STREAM, "m1", { sent: 20 * MINUTE, received: 20 * MINUTE })];
    expect(copyMeasure(reports, EXPECT, { censorAfter: 10 * MINUTE }).counts).toEqual({ ...ZERO, messages: 1, same: 1 });
  });
});

describe("copyMeasure: the options", () => {
  it("finds the copy of a different key with `copyKey`", () => {
    const reports = [report(API, "m1", { sent: 0, received: 0 }), report(STREAM, "m1.copy", { sent: SECOND, received: SECOND })];
    expect(copyMeasure(reports, EXPECT).counts).toEqual({ ...ZERO, messages: 1, lost: 1 });
    const keyed = copyMeasure(reports, EXPECT, { copyKey: (key) => `${key}.copy` });
    expect(keyed.counts).toEqual({ ...ZERO, messages: 1, shifted: 1 });
    expect(keyed.gaps.map((gap) => [gap.copy.key, gap.match])).toEqual([["m1.copy", "id"]]);
  });

  it("counts the events with `eventOf`, and with the code of the kind by default", () => {
    const reports = [report(API, "m1", { sent: 0, received: 0, fields: { parameters: { code: ["TOR"] } } })];
    expect(copyMeasure(reports, EXPECT).checks.map((check) => check.event)).toEqual(["met.tornado"]);
    expect(copyMeasure(reports, EXPECT, { eventOf: (one) => one.parameters["code"]?.[0] ?? "?" }).checks.map((check) => check.event)).toEqual(["TOR"]);
  });

  it("skips the checks that start before the `since` of the expectation", () => {
    const reports = [
      report(API, "m1", { sent: 0, received: 0 }),
      report(API, "m2", { sent: 10 * MINUTE, received: 10 * MINUTE, event: "event-b" }),
      report(STREAM, "m2", { sent: 10 * MINUTE, received: 10 * MINUTE, event: "event-b" }),
    ];
    expect(copyMeasure(reports, EXPECT).counts).toEqual({ ...ZERO, messages: 2, same: 1, none: 1 });
    expect(copyMeasure(reports, { ...EXPECT, since: 5 * MINUTE }).counts).toEqual({ ...ZERO, messages: 1, same: 1 });
  });

  it("checks only the reports of the filter of the expectation", () => {
    const reports = [report(API, "m1", { sent: 0, received: 0, fields: { status: "test" } })];
    expect(copyMeasure(reports, EXPECT).counts).toEqual(ZERO);
  });

  it("joins the reports of a link rule in one incident", () => {
    // The two reports share no correlation key. The rule links each pair of reports of one kind.
    const rule: LinkRule = { blocks: (one) => [one.kind.code], matches: (a, b) => a.kind.code === b.kind.code };
    const reports = [report(API, "m1", { sent: 0, received: 0 }), report(STREAM, "c1", { sent: 0, received: 0, event: "event-b" })];
    expect(copyMeasure(reports, EXPECT).counts).toEqual({ ...ZERO, messages: 1, none: 1 });
    expect(copyMeasure(reports, EXPECT, { link: rule }).counts).toEqual({ ...ZERO, messages: 1, same: 1 });
  });
});

describe("copyMeasure: the laws", () => {
  const FATES = ["same", "shifted", "missing", "apart"] as const;

  // A set of 10 reports of the source API: each has a sent time, an event and a fate of its copy. A copy can come
  // before its message. Two reports of one event with one sent time are one message of the core (`carriages`).
  function reportsOf(rng: Random): Report[] {
    const reports: Report[] = [];
    for (let index = 0; index < 10; index += 1) {
      const key = `m${String(index)}`;
      const sent = rng.int(0, 60) * MINUTE;
      const event = `event-${String(rng.below(3))}`;
      const fate = FATES[rng.below(FATES.length)]!;
      reports.push(report(API, key, { sent, received: sent, event }));
      if (fate === "missing") continue;
      reports.push(
        report(STREAM, key, {
          sent: fate === "shifted" ? sent + SECOND : sent,
          received: sent + rng.int(-30, 30) * SECOND,
          event: fate === "apart" ? `${event}-apart` : event,
        }),
      );
    }
    return reports;
  }

  for (const seed of SEEDS) {
    it(`does not change with the order of the reports (seed ${String(seed)})`, () => {
      const rng = random(seed);
      const reports = reportsOf(rng);
      const shuffled = [...reports];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const other = rng.below(index + 1);
        [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
      }
      expect(copyMeasure(shuffled, EXPECT)).toEqual(copyMeasure(reports, EXPECT));
    });

    it(`puts each message in one class, and gives a delay only to the class same (seed ${String(seed)})`, () => {
      const reports = reportsOf(random(seed));
      const result = copyMeasure(reports, EXPECT);
      const { messages, ...classes } = result.counts;
      expect(messages).toBe(new Set(reports.filter((one) => one.source === API).map((one) => `${one.correlation[0]?.id ?? ""} ${String(one.sent)}`)).size);
      expect(Object.values(classes).reduce((sum, count) => sum + count, 0)).toBe(messages);
      for (const check of result.checks) expect(check.delay === undefined).toBe(check.class !== "same");
      expect(result.gaps.length).toBe(result.counts.shifted + result.counts.lost + result.counts.apart);
    });
  }
});
