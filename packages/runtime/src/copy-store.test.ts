import { reportId, type Expectation, type ObservationId, type Report, type SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { copySummaries } from "./copy-store.ts";

const API = "api" as SourceId;
const STREAM = "stream" as SourceId;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const EXPECT: Expectation = { id: "api.stream", from: API, to: STREAM, when: { statuses: ["actual"] } };
const OPTIONS = { censor: 10 * MINUTE, eventOf: (one: Report): string => one.parameters["code"]?.[0] ?? "?" };

// One report of a public place in Kansas (Sedgwick County KS), with its event code and its correlation key.
function report(source: SourceId, key: string, sent: number, received: number, code = "TOR", event = key): Report {
  return {
    id: reportId({ source, key, sent }),
    source,
    origin: "nws",
    key,
    references: [],
    correlation: [{ system: "vtec", id: event }],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent,
    received,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: `observation:${source}:${key}` as ObservationId,
    parameters: { code: [code] },
  };
}

// The messages m1 to m4 of the source API at the minutes 10 to 40. The stream starts at the minute 15.
const REPORTS: readonly Report[] = [
  report(API, "m0", 0, 0, "FFW"),
  report(API, "m1", 10 * MINUTE, 10 * MINUTE),
  report(STREAM, "m1", 10 * MINUTE, 15 * MINUTE),
  report(API, "m2", 20 * MINUTE, 20 * MINUTE),
  report(STREAM, "m2", 20 * MINUTE, 20 * MINUTE + 10 * SECOND),
  report(API, "m3", 30 * MINUTE, 30 * MINUTE),
  report(STREAM, "m3", 30 * MINUTE, 30 * MINUTE - 20 * SECOND),
  report(API, "m4", 40 * MINUTE, 40 * MINUTE, "SVR"),
  report(API, "m5", 55 * MINUTE, 55 * MINUTE, "SVR"),
];
const END = 60 * MINUTE;

describe("copySummaries", () => {
  it("starts at the first receipt of the source `to`, censors the late messages and counts the events of each class", () => {
    const [summary] = copySummaries(REPORTS, END, [{ expectation: EXPECT }], OPTIONS);
    expect(summary).toMatchObject({ id: "api.stream", from: API, to: STREAM, since: 15 * MINUTE });
    expect(summary?.counts).toEqual({ messages: 4, same: 2, shifted: 0, lost: 0, apart: 0, none: 1, censored: 1 });
    expect(summary?.events).toEqual({ none: { SVR: 1 }, censored: { SVR: 1 } });
  });

  it("gives the quantiles of the delays, with a copy that came first below 0", () => {
    const [summary] = copySummaries(REPORTS, END, [{ expectation: { ...EXPECT, since: 0 } }], OPTIONS);
    expect(summary?.since).toBe(0);
    expect(summary?.delays).toEqual({ count: 3, min: -20 * SECOND, median: 10 * SECOND, p90: 4 * MINUTE + 2 * SECOND, max: 5 * MINUTE });
    expect(summary?.events).toEqual({ none: { FFW: 1, SVR: 1 }, censored: { SVR: 1 } });
  });

  it("finds the copies by the key of each candidate", () => {
    const keyed = REPORTS.map((one) => (one.source === STREAM ? report(STREAM, `${one.key}.copy`, one.sent, one.received, "TOR", one.key) : one));
    const [plain, withKey] = copySummaries(keyed, END, [{ expectation: EXPECT }, { expectation: EXPECT, copyKey: (key) => `${key}.copy` }], OPTIONS);
    expect(plain?.counts.same).toBe(2);
    expect(withKey?.counts.same).toBe(2);
    const shifted = keyed.map((one) => (one.source === STREAM && one.key === "m2.copy" ? report(STREAM, one.key, one.sent + SECOND, one.received, "TOR", "m2") : one));
    const [lost, found] = copySummaries(shifted, END, [{ expectation: EXPECT }, { expectation: EXPECT, copyKey: (key) => `${key}.copy` }], OPTIONS);
    expect(lost?.events).toMatchObject({ lost: { TOR: 1 } });
    expect(found?.events).toMatchObject({ shifted: { TOR: 1 } });
  });

  it("gives counts of 0 and no start when the log has no report of the source `to`", () => {
    const [summary] = copySummaries(REPORTS.filter((one) => one.source === API), END, [{ expectation: EXPECT }], OPTIONS);
    expect(summary).toEqual({ id: "api.stream", from: API, to: STREAM, counts: { messages: 0, same: 0, shifted: 0, lost: 0, apart: 0, none: 0, censored: 0 }, events: {} });
  });
});
