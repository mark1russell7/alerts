/**
 * This module holds the open of an event log with an integrity check, a quarantine and a salvage.
 *
 * TODO(AL-50): the home of `openCheckedEventLog` is `@mark1russell7/sqlite`, next to `salvageEventLog`. The request
 * went to the owner of that package on 2026-11-16. After its release, the runtime imports it, and this file goes.
 */
import { existsSync } from "node:fs";
import {
  checkIntegrity,
  IntegrityError,
  openDatabase,
  openEventLog,
  quarantine,
  salvageEventLog,
  sqliteFault,
  type EventLogFile,
  type EventLogFileOptions,
  type Integrity,
  type IntegrityOptions,
  type LogRecord,
  type Parse,
  type Quarantined,
  type QuarantineOptions,
  type Salvaged,
  type SqliteFault,
} from "@mark1russell7/sqlite";

/** The options of `openCheckedEventLog`: the options of `openEventLog`, the check and the quarantine. */
export interface CheckedEventLogOptions<E> extends EventLogFileOptions<E> {
  /** This value is the kind of the check and the highest count of problems. The default is `{ quick: true }`. */
  readonly check?: IntegrityOptions;
  /** These values are the folder and the time of the quarantine. */
  readonly quarantine?: QuarantineOptions;
}

/** The result of `openCheckedEventLog`. `quarantined`, `salvaged` and `fault` are there only for a broken file. */
export interface CheckedEventLog<E extends LogRecord> {
  readonly log: EventLogFile<E>;
  /** This value is the result of the check, or `undefined` when the path had no file. */
  readonly integrity: Integrity | undefined;
  readonly quarantined: Quarantined | undefined;
  readonly salvaged: Salvaged | undefined;
  readonly fault: SqliteFault | undefined;
}

/** The files of a database. */
const COMPANIONS = ["", "-wal", "-shm", "-journal"] as const;

/** This function gives the message of an error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * This function opens a log, and it checks the file first. A broken file goes into quarantine. Then a new file gets each
 * event that the salvage reads from the broken file.
 *
 * 1. With no file at the path, the function opens a new log.
 * 2. The function opens the file, checks it with `checkIntegrity`, and closes it.
 * 3. When the check passes, the function opens the log. A broken page that the open reads also starts the recovery.
 * 4. The recovery moves the file into quarantine, opens a new log at the path, and salvages the events into it.
 *
 * A fault that is not a broken file, for example a lock, goes to the caller.
 *
 * @param path - The path of the file.
 * @param parse - The parse of a stored JSON value into an event.
 * @param options - The options of the open, the check and the quarantine.
 */
export function openCheckedEventLog<E extends LogRecord>(path: string, parse: Parse<E>, options: CheckedEventLogOptions<E> = {}): CheckedEventLog<E> {
  if (path === ":memory:" || !COMPANIONS.some((suffix) => existsSync(path + suffix))) {
    return { log: openEventLog(path, parse, options), integrity: undefined, quarantined: undefined, salvaged: undefined, fault: undefined };
  }
  let integrity: Integrity;
  let fault: SqliteFault | undefined;
  try {
    const db = openDatabase(path, options);
    try {
      integrity = checkIntegrity(db, options.check ?? { quick: true });
    } finally {
      db.close();
    }
  } catch (error) {
    fault = sqliteFault(error);
    if (fault?.action !== "quarantine") throw error;
    integrity = { ok: false, problems: [messageOf(error)] };
  }
  if (integrity.ok) {
    try {
      return { log: openEventLog(path, parse, options), integrity, quarantined: undefined, salvaged: undefined, fault: undefined };
    } catch (error) {
      fault = sqliteFault(error);
      if (fault?.action !== "quarantine") throw error;
      integrity = { ok: false, problems: [messageOf(error)] };
    }
  }
  fault ??= sqliteFault(new IntegrityError(integrity.problems));
  const quarantined = quarantine(path, options.quarantine);
  const log = openEventLog(path, parse, options);
  try {
    const salvaged = quarantined.database === undefined ? undefined : salvageEventLog(quarantined.database, log, { parse });
    return { log, integrity, quarantined, salvaged, fault };
  } catch (error) {
    log.close();
    throw error;
  }
}
