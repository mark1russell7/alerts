/**
 * This module holds the log of the runtime: an append-only event log in one SQLite file, on
 * `@mark1russell7/sqlite`. The file is in WAL mode, with `synchronous` at `FULL`, thus an event that
 * the log accepted stays after a power cut.
 */
import { openEventLog, type EventLogFile } from "@mark1russell7/sqlite";
import { parseEvent, type RuntimeEvent } from "./events.ts";

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

/** This function opens the log in a file, and makes the file and its folder when they are not there. */
export function openRuntimeLog(path: string, options: RuntimeLogOptions = {}): RuntimeLog {
  const log: EventLogFile<RuntimeEvent> = openEventLog(path, parseEvent, { makeFolder: true, busyTimeoutMs: options.busyTimeoutMs ?? 5000 });
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
