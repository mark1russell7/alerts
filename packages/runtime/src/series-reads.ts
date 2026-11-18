/**
 * This module keeps the read of each indicator series of the store between the passes (AL-59). The read of a series
 * changes only at these events:
 *
 * - The series gets readings.
 * - The store deletes a reading that the read holds.
 * - The time passes the stale time of the latest reading, or the time of a later reading.
 *
 * Thus a pass reads from the store only the series of these events. The list of the reads is the list of `readSignals`,
 * which reads each series at each time. A seeded test holds this.
 */
import { DEFAULT_BASELINE, readSeries, staleTime, type BaselinePolicy, type Instant, type MeasureDeclaration, type Reading, type SeriesSignal, type SourceDescriptor } from "@mark1russell7/alerts";
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { ReadingStore, SeriesRef } from "./readings.ts";

/** The parts of the configuration that a read of the series needs. */
export interface SeriesReadOptions {
  readonly store: ReadingStore;
  /** The descriptors of the sources. A series of a measure that no descriptor declares has no read. */
  readonly sources: readonly SourceDescriptor[];
  /** The policy of the baseline. The default is `DEFAULT_BASELINE`. */
  readonly policy?: BaselinePolicy;
}

/** The reads of the series between the passes. */
export interface SeriesReads {
  /** This function marks the series of the readings as changed. The next read gets them from the store. */
  note(readings: readonly Reading[]): void;
  /** This function tells that the store deleted each reading before `before`. It marks each series with a changed read. */
  pruned(before: Instant): void;
  /**
   * This function gives the read of each series of the store at `now`, in the order of the keys. It reads only the changed
   * series from the store. When the store throws, the function throws, and the next call reads the series again.
   */
  signals(now: Instant): SeriesSignal[];
}

// The read of one series, with the times that end it.
interface Entry {
  readonly ref: SeriesRef;
  readonly signal: SeriesSignal;
  /** The first time at which the read can change with no change of the store. */
  readonly until: Instant;
  /** The time of the oldest reading of the series in the store, or an earlier time. */
  first: Instant;
  /** The oldest time of a reading that the read holds. A delete before this time does not change the read. */
  readonly from: Instant;
}

// The key of a series: its source, its measure and its series. The read of a series holds each version.
const keyOf = (ref: SeriesRef): string => JSON.stringify([ref.source, ref.measure, ref.series]);
const refOf = (reading: Reading): SeriesRef => ({ source: reading.source, measure: reading.measure, series: reading.series });
const bySeries = (a: SeriesSignal, b: SeriesSignal): number => compareCodeUnits(a.series, b.series);

// The latest reading at `now` or before, as `readSeries` finds it: the latest time, and then the smallest observation id.
function latestOf(readings: readonly Reading[], now: Instant): Reading | undefined {
  let latest: Reading | undefined;
  for (const reading of readings) {
    if (reading.at > now) continue;
    if (latest === undefined || reading.at > latest.at || (reading.at === latest.at && compareCodeUnits(reading.observation, latest.observation) < 0)) latest = reading;
  }
  return latest;
}

// The measures of the descriptors, by the key of the source and the measure.
function measuresOf(sources: readonly SourceDescriptor[]): ReadonlyMap<string, MeasureDeclaration> {
  return new Map(sources.flatMap((source) => (source.measures ?? []).map((measure) => [JSON.stringify([source.id, measure.id]), measure] as const)));
}

// This function reads one series of the store at `now`. It gives `undefined` for a series with no reading or no measure.
function readOne(store: ReadingStore, ref: SeriesRef, measures: ReadonlyMap<string, MeasureDeclaration>, now: Instant, policy: BaselinePolicy): Entry | undefined {
  const measure = measures.get(JSON.stringify([ref.source, ref.measure]));
  if (measure === undefined) return undefined;
  const readings = store.series(ref, Number.MIN_SAFE_INTEGER);
  if (readings.length === 0) return undefined;
  const read = readSeries(readings, measure, now, policy);
  // The latest reading of the read. A measure with the baseline `expected` reads only the readings with an expected value.
  const latest = latestOf(
    readings.filter((reading) => measure.baseline !== "expected" || reading.expected !== undefined),
    now,
  );
  const ends: Instant[] = [];
  if (latest !== undefined) {
    const stale = latest.at + staleTime(latest, measure, policy);
    if (now <= stale) ends.push(stale + 1);
  }
  // The first reading is a reading of the oldest time. A loop, not a spread: a series can hold many readings.
  let oldest = readings[0]!;
  let later = Number.POSITIVE_INFINITY;
  for (const reading of readings) {
    if (reading.at < oldest.at) oldest = reading;
    if (reading.at > now && reading.at < later) later = reading.at;
  }
  ends.push(later);
  // The area of the series is the area of its latest reading, or of its first reading when each reading is later.
  const shown = latestOf(readings, now) ?? oldest;
  return {
    ref,
    signal: { series: keyOf(ref), dimension: measure.dimension, area: shown.area, read },
    until: Math.min(...ends),
    first: oldest.at,
    from: latest === undefined ? Number.NEGATIVE_INFINITY : latest.at - policy.window,
  };
}

/**
 * This function reads each series of the store at `now`, in the order of the keys. A series of a measure that no
 * descriptor declares has no read. The reads of `seriesReads` give the same list with fewer reads of the store.
 */
export function readSignals(options: SeriesReadOptions, now: Instant): SeriesSignal[] {
  const measures = measuresOf(options.sources);
  const policy = options.policy ?? DEFAULT_BASELINE;
  return options.store
    .refs()
    .flatMap((ref) => readOne(options.store, ref, measures, now, policy)?.signal ?? [])
    .sort(bySeries);
}

/**
 * This function makes the reads of the series between the passes. The function `signals` reads each series of the store
 * at its first use. A time before the time of its last use also reads each series again: the wall clock moved back.
 */
export function seriesReads(options: SeriesReadOptions): SeriesReads {
  const { store } = options;
  const measures = measuresOf(options.sources);
  const policy = options.policy ?? DEFAULT_BASELINE;
  const entries = new Map<string, Entry>();
  const changed = new Map<string, SeriesRef>();
  let listed = false;
  let last: Instant | undefined;
  return {
    note(readings) {
      for (const reading of readings) changed.set(keyOf(reading), refOf(reading));
    },
    pruned(before) {
      for (const [key, entry] of entries) {
        if (entry.first >= before) continue;
        // The delete holds only readings before `before`. A read with no reading before it keeps its value.
        if (before > entry.from) changed.set(key, entry.ref);
        else entry.first = before;
      }
    },
    signals(now) {
      if (last !== undefined && now < last) listed = false;
      if (!listed) {
        for (const ref of store.refs()) changed.set(keyOf(ref), ref);
        for (const [key, entry] of entries) changed.set(key, entry.ref);
        listed = true;
      }
      for (const [key, entry] of entries) if (now >= entry.until) changed.set(key, entry.ref);
      // A series leaves the list of the changes only after its read. Thus a throw leaves the rest for the next call.
      for (const [key, ref] of changed) {
        const entry = readOne(store, ref, measures, now, policy);
        if (entry === undefined) entries.delete(key);
        else entries.set(key, entry);
        changed.delete(key);
      }
      last = now;
      return [...entries.values()].map((entry) => entry.signal).sort(bySeries);
    },
  };
}
