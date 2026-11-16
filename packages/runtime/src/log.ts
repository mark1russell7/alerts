/**
 * This module holds the log of the runtime: an append-only event log in one SQLite file, on
 * `@mark1russell7/sqlite`. The file is in WAL mode, with `synchronous` at `FULL`, thus an event that
 * the log accepted stays after a power cut.
 */
import { basename } from "node:path";
import type { Instant } from "@mark1russell7/alerts";
import { openEventLog, type EventLogFile } from "@mark1russell7/sqlite";
import { openCheckedEventLog } from "./checked-log.ts";
import { envelope, parseEvent, type RecoveredEvent, type RuntimeEvent } from "./events.ts";

/** The log of the runtime. */
export interface RuntimeLog {
  /** This function gives the events of the log, in their order. */
  read(): Iterable<RuntimeEvent>;
  /** This function tells if the log has an event with an id. */
  has(id: string): boolean;
  /**
   * This function appends events in one transaction. `accept` gets each new event before the write,
   * in order. An event with an id that the log has changes nothing, and `accept` does not get it.
   * The function gives the ids of the events that are different from the event of the log with the same
   * id. The log keeps its own event, and it writes the other events of the call. When a write fails, the
   * function throws, and nothing changed.
   */
  appendAll(events: readonly RuntimeEvent[], accept: (event: RuntimeEvent) => void): readonly string[];
  close(): void;
}

/** The options of the file. */
export interface RuntimeLogOptions {
  /** The milliseconds that a write waits for a lock of another connection. The default is 5000. */
  readonly busyTimeoutMs?: number;
}

/** The count of the problems of the check and of the salvage that a `recovered` event keeps. */
export const RECOVERY_PROBLEMS = 10;

/** This function opens the log in a file, and makes the file and its folder when they are not there. */
export function openRuntimeLog(path: string, options: RuntimeLogOptions = {}): RuntimeLog {
  return runtimeLog(openEventLog(path, parseEvent, fileOptions(options)));
}

/** The options of `openCheckedRuntimeLog`. */
export interface CheckedLogOptions extends RuntimeLogOptions {
  /** This clock gives the time of the `recovered` event and of the name of the quarantine folder. */
  readonly now: () => Instant;
}

/** The result of `openCheckedRuntimeLog`. */
export interface CheckedLog {
  readonly log: RuntimeLog;
  /** This value is the event of the recovery, or `undefined` when the file passed its check. */
  readonly recovered: RecoveredEvent | undefined;
}

/**
 * This function opens the log at the boot of the runtime. It checks the file with `PRAGMA quick_check` first. A broken
 * file goes into a quarantine folder `<name>.broken-<time>` next to it. Then a new file gets each event that the
 * salvage reads, and one `recovered` event. The fold of that event gives a system report that names the quarantine.
 *
 * A fault that is not a broken file, for example a lock, goes to the caller. The broken file does not change.
 *
 * @param path - The path of the log file.
 * @param options - The clock of the recovery and the options of the file.
 */
export function openCheckedRuntimeLog(path: string, options: CheckedLogOptions): CheckedLog {
  const opened = openCheckedEventLog(path, parseEvent, { ...fileOptions(options), quarantine: { now: new Date(options.now()) } });
  const log = runtimeLog(opened.log);
  if (opened.quarantined === undefined) return { log, recovered: undefined };
  const quarantine = basename(opened.quarantined.folder);
  const { salvaged } = opened;
  const recovered: RecoveredEvent = {
    ...envelope("recovered", `recovered:${quarantine}`, options.now()),
    quarantine,
    fault: opened.fault?.kind ?? "corrupt",
    read: salvaged?.read ?? 0,
    added: salvaged?.added ?? 0,
    lost: salvaged?.lost ?? 0,
    whole: salvaged !== undefined && salvaged.problems.length === 0 && salvaged.lost === 0,
    problems: [...(opened.integrity?.problems ?? []), ...(salvaged?.problems ?? [])].slice(0, RECOVERY_PROBLEMS),
  };
  try {
    log.appendAll([recovered], () => undefined);
  } catch (error) {
    log.close();
    throw error;
  }
  return { log, recovered };
}

// The options of the file of the log: a new folder when it is not there, and a wait for the lock of another connection.
function fileOptions(options: RuntimeLogOptions): { readonly makeFolder: true; readonly busyTimeoutMs: number } {
  return { makeFolder: true, busyTimeoutMs: options.busyTimeoutMs ?? 5000 };
}

// The log of the runtime on an event log file.
function runtimeLog(log: EventLogFile<RuntimeEvent>): RuntimeLog {
  return {
    read: () => log.read(),
    has: (id) => log.get(id) !== undefined,
    appendAll(events, accept) {
      let results;
      try {
        results = log.appendAll(events, (event) => {
          accept(event);
          return undefined;
        });
      } catch (error) {
        // The transaction rolled back. The log is usable again after `recover`, and the caller keeps its old state.
        log.recover();
        throw error;
      }
      return results.flatMap((result, at) => (result.kind === "conflict" ? [events[at]!.id] : []));
    },
    close: () => log.close(),
  };
}
