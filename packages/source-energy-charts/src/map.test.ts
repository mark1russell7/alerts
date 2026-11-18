import { checkWith, observationId, readingProblems, readingSchema, type Observation } from "@mark1russell7/alerts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ENERGY_CHARTS_DESCRIPTOR } from "./descriptor.ts";
import { ENERGY_CHARTS_LICENSE, FREQUENCY_MAX, FREQUENCY_MIN, FREQUENCY_REGION, mapObservation, minuteBody, minuteStart, minuteText, SECONDS, SOURCE_ID, SYNCHRONOUS_AREA } from "./map.ts";

const MINUTE = Date.parse("2026-11-18T03:07:00Z");
const URL_OF_SERIES = "https://api.energy-charts.test/v2/frequency?region=DE-Freiburg";

/** This function gives the observation of a body, as the fetch gives it. */
const observe = (body: string): Observation => ({
  id: observationId({ source: SOURCE_ID, contentType: "application/json", url: URL_OF_SERIES, body }),
  source: SOURCE_ID,
  fetched: MINUTE + 150_000,
  contentType: "application/json",
  body,
  transport: { url: URL_OF_SERIES, status: 200, latency: 30 },
});

/** The 60 values of a calm minute near 50 Hz, with one low and one high second. */
const CALM = Array.from({ length: SECONDS }, (_, second) => 50 + ((second % 7) - 3) / 1000);
const withValues = (values: readonly (number | null)[]): (number | null)[] => [...values];

describe("minuteStart and minuteText", () => {
  it("read and write the start of a minute in UTC, and refuse each other text", () => {
    expect(minuteText(MINUTE)).toBe("2026-11-18T03:07:00Z");
    expect(minuteStart("2026-11-18T03:07:00Z")).toBe(MINUTE);
    for (const text of ["2026-11-18T03:07:30Z", "2026-11-18T03:07:00+00:00", "2026-11-18T03:07:00.000Z", "2026-02-30T03:07:00Z", 1, null]) expect(minuteStart(text)).toBeUndefined();
  });
});

describe("mapObservation", () => {
  it("gives the lowest and the highest value of a minute as two readings, and no report", () => {
    const observation = observe(minuteBody(MINUTE, CALM));
    const result = mapObservation(observation);
    expect(result.reports).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.readings).toEqual([
      { source: SOURCE_ID, measure: FREQUENCY_MIN, series: FREQUENCY_REGION, at: MINUTE, value: 49.997, area: SYNCHRONOUS_AREA, observation: observation.id },
      { source: SOURCE_ID, measure: FREQUENCY_MAX, series: FREQUENCY_REGION, at: MINUTE, value: 50.003, area: SYNCHRONOUS_AREA, observation: observation.id },
    ]);
  });

  it("gives readings that pass the schema and the declarations of the descriptor, as the runtime checks them", () => {
    for (const reading of mapObservation(observe(minuteBody(MINUTE, CALM))).readings ?? []) {
      expect(checkWith(readingSchema, reading).tag).toBe("ok");
      expect(readingProblems(reading, ENERGY_CHARTS_DESCRIPTOR)).toEqual([]);
    }
  });

  it("uses the seconds with a value when the minute has seconds with no value", () => {
    const values = withValues(CALM);
    values[0] = null;
    values[3] = null;
    values[59] = null;
    const readings = mapObservation(observe(minuteBody(MINUTE, values))).readings ?? [];
    expect(readings.map((reading) => reading.value)).toEqual([49.997, 50.003]);
  });

  it("gives a note and no reading for a minute with no value", () => {
    const result = mapObservation(observe(minuteBody(MINUTE, Array.from({ length: SECONDS }, () => null))));
    expect(result.readings).toBeUndefined();
    expect(result.problems).toEqual([{ path: "frequency", message: "the minute has no value: the map gives no reading", fatal: false }]);
  });

  it("gives a lossy problem for a value that is not a frequency above 0, and does not use it", () => {
    const body = JSON.parse(minuteBody(MINUTE, CALM)) as { frequency: unknown[] };
    body.frequency[1] = 0;
    body.frequency[2] = "50.1";
    body.frequency[4] = -50;
    const result = mapObservation(observe(JSON.stringify(body)));
    expect(result.problems.map((problem) => [problem.path, problem.lossy])).toEqual([
      ["frequency[1]", true],
      ["frequency[2]", true],
      ["frequency[4]", true],
    ]);
    expect(result.readings?.map((reading) => reading.value)).toEqual([49.997, 50.003]);
  });

  it("gives a fatal problem and no reading for a body that is not one minute of the series", () => {
    const fatal = (body: string) => {
      const result = mapObservation(observe(body));
      expect(result.readings).toBeUndefined();
      expect(result.reports).toEqual([]);
      return result.problems.filter((problem) => problem.fatal).map((problem) => problem.path);
    };
    const minute = JSON.parse(minuteBody(MINUTE, CALM)) as Record<string, unknown>;
    const changed = (field: string, value: unknown) => JSON.stringify({ ...minute, [field]: value });
    expect(fatal("{")).toEqual([""]);
    expect(fatal(JSON.stringify({ endpoint: "frequency", data: [] }))).toEqual([""]);
    expect(fatal(changed("minute", "2026-11-18T03:07:30Z"))).toEqual(["minute"]);
    expect(fatal(changed("region", ""))).toEqual(["region"]);
    expect(fatal(changed("unit", "mHz"))).toEqual(["unit"]);
    expect(fatal(changed("license", `${ENERGY_CHARTS_LICENSE} (changed)`))).toEqual(["license"]);
    expect(fatal(changed("frequency", CALM.slice(1)))).toEqual(["frequency"]);
  });

  it("gives the least and the largest value of the seconds with a value, for each minute", () => {
    const second = fc.oneof(fc.constant(null), fc.double({ min: 45, max: 55, noNaN: true }));
    fc.assert(
      fc.property(fc.array(second, { minLength: SECONDS, maxLength: SECONDS }), (values) => {
        const present = values.filter((value): value is number => value !== null);
        const result = mapObservation(observe(minuteBody(MINUTE, values)));
        expect(result.problems.filter((problem) => problem.fatal || problem.lossy === true)).toEqual([]);
        expect(result.readings?.map((reading) => reading.value)).toEqual(present.length === 0 ? undefined : [Math.min(...present), Math.max(...present)]);
      }),
    );
  });

  it("does not throw for any body", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (body) => {
        const result = mapObservation(observe(body));
        expect(result.reports).toEqual([]);
        expect(result.readings === undefined || result.readings.length === 2).toBe(true);
      }),
    );
  });
});
