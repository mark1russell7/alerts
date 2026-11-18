import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASELINE, type BaselinePolicy, type IndicatorArea, type MeasureDeclaration, type ObservationId, type Reading, type SourceDescriptor, type SourceId } from "@mark1russell7/alerts";
import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { afterEach, describe, expect, it } from "vitest";
import { openReadingStore, READINGS_FILE, type FileReadingStore, type ReadingStore } from "./readings.ts";
import { readSignals, seriesReads, type SeriesReadOptions } from "./series-reads.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const MINUTE = 60_000;
const SOURCE_ID = "test-indicators" as SourceId;

// One measure of each baseline. The measure `level` is stale 10 minutes after its latest reading.
const LEVEL: MeasureDeclaration = { id: "level", dimension: "river-levels", title: "River level", unit: "m", area: "point", moves: "rise", baseline: "none", cadence: 5 * MINUTE };
const LOAD: MeasureDeclaration = { id: "load", dimension: "power-demand", title: "Load", unit: "%", area: "point", moves: "both", baseline: "expected" };
const SLOW: MeasureDeclaration = { id: "slow", dimension: "road-traffic", title: "Slow roads", unit: "%", area: "point", moves: "rise", baseline: "flag", cadence: 10 * MINUTE, delay: 5 * MINUTE };
const SOURCE: SourceDescriptor = {
  id: SOURCE_ID,
  title: "Test indicators",
  origins: ["test"],
  dependsOn: ["provider:test"],
  uses: ["internet", "dns", "power"],
  kinds: [],
  coverage: "global",
  transport: "poll",
  interval: MINUTE,
  slowAfter: 10_000,
  auth: "none",
  measures: [LEVEL, LOAD, SLOW],
};
// A short baseline with no season. Thus a few readings give a read.
const POLICY: BaselinePolicy = { ...DEFAULT_BASELINE, window: 60 * MINUTE, season: "none", slack: 0, samples: 3, staleCadences: 2, staleAfter: 30 * MINUTE };

// Two points in Kansas: Topeka and Wichita.
const NEAR: IndicatorArea = { type: "point", at: [-95.68, 39.05] };
const FAR: IndicatorArea = { type: "point", at: [-97.34, 37.69] };

let folders: string[] = [];
const stores: FileReadingStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  folders = [];
});

function openStore(): FileReadingStore {
  const folder = mkdtempSync(join(tmpdir(), "alerts-series-reads-"));
  folders.push(folder);
  const store = openReadingStore(join(folder, READINGS_FILE));
  stores.push(store);
  return store;
}

const level = (series: string, at: number, value: number, observation: string): Reading => ({
  source: SOURCE_ID,
  measure: LEVEL.id,
  series,
  at,
  value,
  area: NEAR,
  observation: observation as ObservationId,
});

// Six readings of one station, 5 minutes apart, with the latest at `T0`.
const history = (series: string): Reading[] => Array.from({ length: 6 }, (_, step) => level(series, T0 - step * 5 * MINUTE, 1 + step / 10, `${series}-${step}`));

// A seeded reading of a measure of the source, or of the measure `ghost` that no descriptor declares. Some readings
// are later than the time of the read.
function seededReading(r: Random, now: number, made: number): Reading {
  const measure = r.pick(["level", "load", "slow", "ghost"]);
  return {
    source: SOURCE_ID,
    measure,
    series: r.pick(["station-1", "station-2", "station-3"]),
    ...(r.chance(0.2) ? { version: "v2" } : {}),
    at: now + r.int(-90 * MINUTE, 20 * MINUTE),
    value: r.chance(0.1) ? 100 : r.range(0, 10),
    area: r.pick([NEAR, FAR]),
    ...(r.chance(0.2) ? { cadence: 2 * MINUTE } : {}),
    ...(measure === "load" && r.chance(0.7) ? { expected: r.range(0, 10) } : {}),
    ...(measure === "slow" ? { flagged: r.chance(0.3) } : {}),
    observation: `obs-${made}` as ObservationId,
  };
}

describe("the reads of the series between the passes", () => {
  it("give the list of a read of each series at each time (seeded)", () => {
    for (const seed of SEEDS) {
      const r = random(`series-reads:${seed}`);
      const store = openStore();
      const options: SeriesReadOptions = { store, sources: [SOURCE], policy: POLICY };
      const reads = seriesReads(options);
      let now = T0;
      let made = 0;
      for (let step = 0; step < 80; step += 1) {
        const action = r.int(0, 9);
        if (action <= 3) {
          const readings = Array.from({ length: r.int(1, 6) }, () => seededReading(r, now, made++));
          store.add(readings);
          reads.note(readings);
        } else if (action <= 6) {
          now += r.int(0, 40 * MINUTE);
        } else if (action <= 8) {
          const before = now - r.int(20 * MINUTE, 120 * MINUTE);
          store.prune(before);
          reads.pruned(before);
        } else {
          now -= r.int(1, 30 * MINUTE);
        }
        if (r.chance(0.7)) expect(reads.signals(now), `seed ${r.seed}, step ${step}`).toEqual(readSignals(options, now));
      }
    }
  });

  it("read from the store only the changed series", () => {
    const store = openStore();
    const seen: string[] = [];
    const counted: ReadingStore = {
      ...store,
      series: (ref, since) => {
        seen.push(ref.series);
        return store.series(ref, since);
      },
    };
    store.add([...history("station-1"), ...history("station-2"), level("station-2", T0 - 3 * 60 * MINUTE, 1, "station-2-old")]);
    const reads = seriesReads({ store: counted, sources: [SOURCE], policy: POLICY });
    const kinds = (now: number): string[] => reads.signals(now).map((signal) => signal.read.kind);

    expect(kinds(T0)).toEqual(["score", "score"]);
    expect(seen).toEqual(["station-1", "station-2"]);
    // The stale time of the latest reading is 10 minutes. The reads change only after it.
    expect(kinds(T0 + 10 * MINUTE)).toEqual(["score", "score"]);
    expect(seen).toHaveLength(2);
    expect(kinds(T0 + 10 * MINUTE + 1)).toEqual(["no-read", "no-read"]);
    expect(seen).toHaveLength(4);
    // A new reading changes the read of its series only. A stale read stays stale with no new reading.
    const late = level("station-1", T0 + 11 * MINUTE, 1.2, "station-1-late");
    store.add([late]);
    reads.note([late]);
    expect(kinds(T0 + 12 * MINUTE)).toEqual(["score", "no-read"]);
    expect(seen.slice(4)).toEqual(["station-1"]);
    // A delete before the window of each read changes no read. A delete in the window of a read reads its series again.
    store.prune(T0 - 2 * 60 * MINUTE);
    reads.pruned(T0 - 2 * 60 * MINUTE);
    expect(kinds(T0 + 12 * MINUTE)).toEqual(["score", "no-read"]);
    expect(seen).toHaveLength(5);
    store.prune(T0 - 12 * MINUTE);
    reads.pruned(T0 - 12 * MINUTE);
    expect(kinds(T0 + 12 * MINUTE)).toEqual(["score", "no-read"]);
    expect(seen.slice(5)).toEqual(["station-1", "station-2"]);
    // A time before the time of the last read reads each series again: the wall clock moved back. After the deletes,
    // each history at T0 has too few samples.
    expect(kinds(T0)).toEqual(["no-read", "no-read"]);
    expect(seen.slice(7)).toEqual(["station-1", "station-2"]);
  });

  it("give the key, the dimension and the area of the latest reading, and no read of an undeclared measure", () => {
    const store = openStore();
    store.add([...history("station-1"), { ...level("station-1", T0 - MINUTE, 1, "station-1-far"), area: FAR }, { ...level("station-1", T0, 9, "ghost-0"), measure: "ghost" }]);
    const signals = seriesReads({ store, sources: [SOURCE], policy: POLICY }).signals(T0 - MINUTE);
    expect(signals).toEqual([{ series: JSON.stringify([SOURCE_ID, "level", "station-1"]), dimension: "river-levels", area: FAR, read: expect.objectContaining({ kind: "score" }) }]);
    expect(readSignals({ store, sources: [], policy: POLICY }, T0)).toEqual([]);
  });

  it("throw when the store throws, and read the series again at the next call", () => {
    const store = openStore();
    store.add(history("station-1"));
    let broken = true;
    const failing: ReadingStore = {
      ...store,
      series: (ref, since) => {
        if (broken) throw new Error("The disk is full.");
        return store.series(ref, since);
      },
    };
    const reads = seriesReads({ store: failing, sources: [SOURCE], policy: POLICY });
    expect(() => reads.signals(T0)).toThrow("The disk is full.");
    broken = false;
    expect(reads.signals(T0).map((signal) => signal.read.kind)).toEqual(["score"]);
  });
});
