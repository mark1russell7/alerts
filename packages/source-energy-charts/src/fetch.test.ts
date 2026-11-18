import { readFileSync } from "node:fs";
import { observationId, type FetchOutcome, type PlaceId, type Watch } from "@mark1russell7/alerts";
import fc from "fast-check";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { checkCanary } from "./check.ts";
import { createEnergyChartsFetch, queryPath, readAnswer } from "./fetch.ts";
import { ENERGY_CHARTS_LICENSE, mapObservation, minuteBody, minuteText, SECONDS, SOURCE_ID } from "./map.ts";

/** The real bytes of an answer (`fixtures/README.md`). */
const LIVE = readFileSync(new URL("../fixtures/frequency-20261118T0313Z.json", import.meta.url), "utf8");
const LIVE_AT = Date.parse("2026-11-18T03:13:30Z");

/** A place of the tests. The query holds only the region of the meter and times, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "PT" }], at: [-9.14, 38.72], bufferKm: 0 }] };

const BASE = "https://api.energy-charts.test";
const SERIES = `${BASE}/v2/frequency?region=DE-Freiburg`;

const json = (body: string, status = 200): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json" }, body });

interface Answer {
  available_from: string;
  available_until: string;
  data: { timestamp: unknown; values: unknown }[];
  [field: string]: unknown;
}
const live = (): Answer => JSON.parse(LIVE) as Answer;

/** This function makes a fetch at the time `start`, whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly Reply[], start: number) => {
  const sent: Exchange[] = [];
  let index = 0;
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply === undefined) throw new Error("no reply");
    return reply;
  };
  let time = start;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createEnergyChartsFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent };
};
const observationsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations : []);
const minutesOf = (outcome: FetchOutcome) => observationsOf(outcome).map((observation) => (JSON.parse(observation.body) as { minute: unknown }).minute);

describe("queryPath", () => {
  it("asks for the 10 whole minutes before the current minute and the current minute, with the region and times only", () => {
    expect(queryPath(LIVE_AT)).toBe(`/v2/frequency?region=DE-Freiburg&start=${String(Date.parse("2026-11-18T03:03:00Z") / 1000)}&end=${String(Date.parse("2026-11-18T03:13:30Z") / 1000)}`);
    expect(queryPath(Date.parse("2026-11-18T03:14:00.999Z"))).toBe(`/v2/frequency?region=DE-Freiburg&start=${String(Date.parse("2026-11-18T03:04:00Z") / 1000)}&end=${String(Date.parse("2026-11-18T03:14:00Z") / 1000)}`);
  });
});

describe("createEnergyChartsFetch", () => {
  it("asks for the query of the time with no place, and gives each complete minute of a real answer as one observation", async () => {
    const { fetch, sent } = fetchWith([json(LIVE)], LIVE_AT);
    const outcome = await fetch({ watch: WATCH });
    expect(sent.map((exchange) => exchange.url)).toEqual([`${BASE}${queryPath(LIVE_AT)}`]);
    expect(sent[0]?.headers).toMatchObject({ "user-agent": "alerts-tests", accept: "application/json" });
    expect(sent[0]?.headers["if-none-match"]).toBeUndefined();
    expect(outcome).toMatchObject({ ok: true, complete: true });
    expect(outcome.ok && (outcome.cursor ?? outcome.asOf)).toBeUndefined();
    // The answer starts at 03:07:29 and ends at 03:11:51. Thus the minutes 03:07 and 03:11 are parts of minutes.
    expect(minutesOf(outcome)).toEqual(["2026-11-18T03:08:00Z", "2026-11-18T03:09:00Z", "2026-11-18T03:10:00Z"]);
    const observations = observationsOf(outcome);
    expect(observations[0]).toMatchObject({
      id: observationId({ source: SOURCE_ID, contentType: "application/json", url: SERIES, body: observations[0]!.body }),
      source: SOURCE_ID,
      fetched: LIVE_AT,
      contentType: "application/json",
      transport: { url: `${BASE}${queryPath(LIVE_AT)}`, status: 200 },
    });
    const readings = observations.flatMap((observation) => mapObservation(observation).readings ?? []);
    expect(readings.map((reading) => [minuteText(reading.at), reading.measure, reading.value])).toEqual([
      ["2026-11-18T03:08:00Z", "frequency-min", 49.9928],
      ["2026-11-18T03:08:00Z", "frequency-max", 50.0185],
      ["2026-11-18T03:09:00Z", "frequency-min", 49.9922],
      ["2026-11-18T03:09:00Z", "frequency-max", 50.0087],
      ["2026-11-18T03:10:00Z", "frequency-min", 49.9941],
      ["2026-11-18T03:10:00Z", "frequency-max", 50.0103],
    ]);
    expect(checkCanary(observations).pass).toBe(true);
  });

  it("gives one minute one id in two answers, so the runtime keeps it one time", async () => {
    const later = live();
    later.available_until = "2026-11-18T03:12:00+00:00";
    const first = observationsOf(await fetchWith([json(LIVE)], LIVE_AT).fetch({ watch: WATCH }));
    const second = observationsOf(await fetchWith([json(JSON.stringify(later))], LIVE_AT + 60_000).fetch({ watch: WATCH }));
    expect(second.map((observation) => observation.id).slice(0, 3)).toEqual(first.map((observation) => observation.id));
    // The second answer ends at the last second of 03:11. Thus 03:11 is complete, with its 8 missing seconds as null.
    expect(second).toHaveLength(4);
    const last = JSON.parse(second[3]!.body) as { minute: string; frequency: (number | null)[] };
    expect(last.minute).toBe("2026-11-18T03:11:00Z");
    expect(last.frequency.filter((value) => value === null)).toHaveLength(8);
  });

  it("keeps the order of the fields and puts each second at its index", () => {
    const answer = {
      endpoint: "frequency",
      unit: "Hz",
      timezone: "UTC",
      license: ENERGY_CHARTS_LICENSE,
      available_from: "2026-11-18T03:08:00+00:00",
      available_until: "2026-11-18T03:08:59+00:00",
      data: [
        { timestamp: "2026-11-18T03:08:59+00:00", values: { frequency: 50.01 } },
        { timestamp: "2026-11-18T03:08:00+00:00", values: { frequency: 49.99 } },
        { timestamp: "2026-11-18T03:08:30+00:00", values: { frequency: null } },
      ],
    };
    const read = readAnswer(json(JSON.stringify(answer)), "u", SERIES, LIVE_AT, 1);
    const values = Array.from({ length: SECONDS }, (): number | null => null);
    values[0] = 49.99;
    values[59] = 50.01;
    expect(read?.observations.map((observation) => observation.body)).toEqual([minuteBody(Date.parse("2026-11-18T03:08:00Z"), values)]);
    expect(read?.complete).toBe(true);
  });

  it("gives each row that is not valid as one observation, and the answer is not complete", async () => {
    const answer = live();
    answer.data.push({ timestamp: "2026-11-18T03:09:00.500+00:00", values: { frequency: 50 } }, { timestamp: "soon", values: { frequency: 50 } }, { timestamp: "2026-11-18T03:09:01+00:00", values: { frequency: "50" } });
    const outcome = await fetchWith([json(JSON.stringify(answer))], LIVE_AT).fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: false });
    const observations = observationsOf(outcome);
    expect(observations).toHaveLength(6);
    for (const observation of observations.slice(3)) expect(mapObservation(observation).problems.some((problem) => problem.fatal)).toBe(true);
  });

  it("gives an answer that is not the frequency series with its license as one observation of the whole body, and the map tells of the change", async () => {
    const changes: readonly Partial<Answer>[] = [{ endpoint: "load" }, { unit: "mHz" }, { timezone: "Europe/Berlin" }, { license: "CC BY-SA 4.0" }, { data: undefined as never }, { available_from: "soon" }, { available_until: undefined as never }];
    for (const change of changes) {
      const body = JSON.stringify({ ...live(), ...change });
      const outcome = await fetchWith([json(body)], LIVE_AT).fetch({ watch: WATCH });
      expect(outcome).toMatchObject({ ok: true, complete: false });
      expect(observationsOf(outcome).map((observation) => observation.body)).toEqual([body]);
      expect(mapObservation(observationsOf(outcome)[0]!).problems).toMatchObject([{ path: "", fatal: true }]);
    }
  });

  it("fails for a body that does not parse, and for a failure of the server", async () => {
    const cut = await fetchWith([json(LIVE.slice(0, 4000))], LIVE_AT).fetch({ watch: WATCH });
    expect(cut).toEqual({ ok: false, failure: { kind: "network", message: `truncated or malformed body: ${BASE}${queryPath(LIVE_AT)}` } });
    const down = await fetchWith([json("{}", 503)], LIVE_AT).fetch({ watch: WATCH });
    expect(down).toMatchObject({ ok: false, failure: { kind: "server" } });
  });

  it("gives at most one observation for each minute, with no minute outside the answer, for each set of rows", () => {
    const second = fc.integer({ min: 0, max: 10 * SECONDS - 1 });
    const row = fc.record({ at: second, value: fc.oneof(fc.constant(null), fc.double({ min: 49, max: 51, noNaN: true })) });
    const start = Date.parse("2026-11-18T03:00:00Z");
    fc.assert(
      fc.property(fc.array(row, { maxLength: 200 }), second, second, (rows, a, b) => {
        const [from, until] = [start + Math.min(a, b) * 1000, start + Math.max(a, b) * 1000];
        const data = rows.map(({ at, value }) => ({ timestamp: new Date(start + at * 1000).toISOString(), values: { frequency: value } }));
        const answer = { ...live(), available_from: new Date(from).toISOString(), available_until: new Date(until).toISOString(), data };
        const read = readAnswer(json(JSON.stringify(answer)), "u", SERIES, LIVE_AT, 1);
        const minutes = (read?.observations ?? []).map((observation) => (JSON.parse(observation.body) as { minute: string }).minute);
        expect(read?.complete).toBe(true);
        expect(new Set(minutes).size).toBe(minutes.length);
        for (const minute of minutes) {
          const time = Date.parse(minute);
          expect(time >= from && time + 59_000 <= until).toBe(true);
          expect(rows.some(({ at }) => Math.floor(at / SECONDS) * 60_000 + start === time)).toBe(true);
        }
      }),
    );
  });
});

describe("the event of 2025-04-28", () => {
  /** The real bytes of the answer for the minutes of the event (`fixtures/README.md`). */
  const EVENT = readFileSync(new URL("../fixtures/frequency-20250428T1028Z.json", import.meta.url), "utf8");
  const AT = Date.parse("2025-04-28T10:38:30Z");

  it("gives the drop of the frequency at 10:33 UTC as the lowest value of that minute", async () => {
    const outcome = await fetchWith([json(EVENT)], AT).fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: true });
    // The answer ends at 10:38:00, so the minute of 10:38 is a part of a minute.
    expect(minutesOf(outcome)).toHaveLength(10);
    const lowest = observationsOf(outcome).flatMap((observation) => (mapObservation(observation).readings ?? []).filter((reading) => reading.measure === "frequency-min"));
    expect(lowest.map((reading) => [minuteText(reading.at), reading.value])).toEqual([
      ["2025-04-28T10:28:00Z", 49.9953],
      ["2025-04-28T10:29:00Z", 50.0021],
      ["2025-04-28T10:30:00Z", 49.9726],
      ["2025-04-28T10:31:00Z", 49.9656],
      ["2025-04-28T10:32:00Z", 49.9753],
      ["2025-04-28T10:33:00Z", 49.844],
      ["2025-04-28T10:34:00Z", 49.8499],
      ["2025-04-28T10:35:00Z", 49.8815],
      ["2025-04-28T10:36:00Z", 49.9139],
      ["2025-04-28T10:37:00Z", 49.9397],
    ]);
    expect(checkCanary(observationsOf(outcome)).pass).toBe(true);
  });
});
