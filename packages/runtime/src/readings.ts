/**
 * This module holds the store of the indicator readings: one SQLite file in the home folder, next to the event log. The
 * event log holds no reading. Thus a series with a short cadence does not make the log larger. The store deletes each
 * reading that is older than the window of a baseline.
 *
 * A broken file goes into quarantine, and the store starts empty. A source does not give its old readings again. Thus
 * each series then has no read until its history has enough values again.
 */
import type { DatabaseSync } from "node:sqlite";
import { checkWith, DEFAULT_BASELINE, readingSchema, type Duration, type Instant, type Reading, type SourceId } from "@mark1russell7/alerts";
import { migrate, openDatabase, openOrQuarantine, transaction, type Migration } from "@mark1russell7/sqlite";

/** The name of the file of the store in the home folder of the instance. */
export const READINGS_FILE = "readings.sqlite";

/** The time that the store keeps a reading after the window of the default baseline: one day. */
export const READING_SLACK: Duration = 86_400_000;

/** The age of the oldest reading that the store keeps by default: the window of `DEFAULT_BASELINE` and `READING_SLACK`. */
export const READING_RETENTION: Duration = DEFAULT_BASELINE.window + READING_SLACK;

/** The id of one series in the store: a source, a measure and a series. The read of a series gives each version. */
export interface SeriesRef {
  readonly source: SourceId;
  readonly measure: string;
  readonly series: string;
}

/** The store of the indicator readings. */
export interface ReadingStore {
  /**
   * This function adds readings in one transaction, and gives the count of the new readings. The key of a reading is its
   * source, measure, series, version, time and observation. A reading with the key of a stored reading changes nothing.
   * When the write fails, the function throws, and nothing changed.
   */
  add(readings: readonly Reading[]): number;
  /**
   * This function gives the readings of one series at `since` or later, of each version, in the order of their times.
   * The function `readSeries` of the core takes this list. A row that fails the schema of a reading gives no reading.
   */
  series(ref: SeriesRef, since: Instant): Reading[];
  /** This function deletes each reading before `before`, and gives the count of the deleted readings. */
  prune(before: Instant): number;
  /** This function gives the count of the readings in the store. */
  count(): number;
  close(): void;
}

/** The store of the readings in a SQLite file. */
export interface FileReadingStore extends ReadingStore {
  /** The quarantine folder of a broken file, or `undefined` when the file opened. */
  readonly quarantined: string | undefined;
}

// The version of a reading with no version is the empty text, thus the key has no NULL column.
const MIGRATIONS: readonly Migration<DatabaseSync>[] = [
  `CREATE TABLE readings (
    source TEXT NOT NULL,
    measure TEXT NOT NULL,
    series TEXT NOT NULL,
    version TEXT NOT NULL,
    at INTEGER NOT NULL,
    observation TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (source, measure, series, version, at, observation)
  ) WITHOUT ROWID;
  CREATE INDEX readings_at ON readings (at);`,
];

// The body of a row, or `undefined` for a row with a problem. A later build can change the form of a reading.
function readingOf(body: unknown): Reading | undefined {
  if (typeof body !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  const checked = checkWith(readingSchema, value);
  return checked.tag === "ok" ? checked.value : undefined;
}

/**
 * This function opens the store in a SQLite file, and makes its folder. A file that does not open goes into quarantine,
 * and the store starts empty. The file is in WAL mode with `synchronous` at `NORMAL`. Thus a crash can lose the last
 * writes: a gap in a series, not a wrong value.
 */
export function openReadingStore(path: string): FileReadingStore {
  const open = (file: string): DatabaseSync => {
    const db = openDatabase(file, { wal: true, synchronous: "NORMAL", busyTimeoutMs: 5000, makeFolder: true });
    try {
      migrate(db, MIGRATIONS);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  const { value: db, quarantined } = openOrQuarantine(path, open);
  const put = db.prepare(
    `INSERT INTO readings (source, measure, series, version, at, observation, body) VALUES ($source, $measure, $series, $version, $at, $observation, $body)
     ON CONFLICT DO NOTHING`,
  );
  const read = db.prepare("SELECT body FROM readings WHERE source = $source AND measure = $measure AND series = $series AND at >= $since ORDER BY at, observation, version");
  const drop = db.prepare("DELETE FROM readings WHERE at < $before");
  const total = db.prepare("SELECT count(*) AS n FROM readings");
  return {
    quarantined: quarantined?.folder,
    add: (readings) =>
      transaction(db, () => {
        let added = 0;
        for (const reading of readings) {
          const { source, measure, series, at, observation } = reading;
          const result = put.run({ source, measure, series, version: reading.version ?? "", at, observation, body: JSON.stringify(reading) });
          added += Number(result.changes);
        }
        return added;
      }),
    series: (ref, since) =>
      read.all({ source: ref.source, measure: ref.measure, series: ref.series, since }).flatMap((row) => readingOf(row["body"]) ?? []),
    prune: (before) => Number(drop.run({ before }).changes),
    count: () => Number(total.get()?.["n"] ?? 0),
    close: () => db.close(),
  };
}
