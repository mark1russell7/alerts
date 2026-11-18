/**
 * This module keeps the measured start times of the runtime on one host, and it gives the ready window of the
 * supervisor from them.
 *
 * - A start time is the time from the start of the process to its first good pass. The runtime adds it to the file
 *   `host/start-times.json` after that pass. The file keeps the last `START_TIMES_KEPT` times.
 * - With `MEASURED_STARTS` or more times, the window is the worst time plus the spread of the times. The window is
 *   not shorter than the floor and not longer than `WINDOW_CAP_MS`.
 * - With fewer times, the window is `BOOTSTRAP_WINDOW_MS`. This value ends when the host has its measured starts.
 *
 * A small host with a slow disk can need more than 30 s for a start. A fixed window then stops each start before it
 * is ready, and the supervisor starts it again in a loop.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The file of the start times, in the folder of the host. */
export const START_TIMES_FILE = "start-times.json";

/** The format of the file of the start times. */
export const START_TIMES_FORMAT = "alerts-start-times/1";

/** The count of the start times that the file keeps. */
export const START_TIMES_KEPT = 20;

/** The count of the start times that the window needs. With fewer times, the window is the bootstrap window. */
export const MEASURED_STARTS = 5;

/**
 * The ready window of a host with fewer than `MEASURED_STARTS` measured starts, in milliseconds. A host with 1 GB of
 * memory and a slow disk needed approximately 24 s before its service started, and its window of 35 s stopped most
 * starts. Thus the bootstrap window is more than three times that window.
 */
export const BOOTSTRAP_WINDOW_MS = 120_000;

/** The longest ready window, in milliseconds. A start that is not ready in this time is stopped. */
export const WINDOW_CAP_MS = 600_000;

/** One measured start: its time and the milliseconds from the start of the process to its first good pass. */
export interface StartTime {
  readonly at: string;
  readonly ms: number;
}

/** The ready window of the supervisor, and the count of the measured starts that gave it. */
export interface ReadyWindow {
  readonly ms: number;
  readonly starts: number;
  readonly measured: boolean;
}

/** This function gives the path of the file of the start times in the folder of the host. */
export const startTimesPath = (hostFolder: string): string => join(hostFolder, START_TIMES_FILE);

/** This function gives the text of a file of the host, or `undefined` when the file cannot be read. */
export function hostFileText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const isStartTime = (value: unknown): value is StartTime => {
  if (typeof value !== "object" || value === null) return false;
  const { at, ms } = value as Record<string, unknown>;
  return typeof at === "string" && typeof ms === "number" && Number.isFinite(ms) && ms > 0;
};

/** This function reads the start times of a file. A missing file, a file that is not JSON and an item with a wrong form give no time. */
export function parseStartTimes(text: string | undefined): StartTime[] {
  if (text === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null) return [];
  const { format, starts } = value as Record<string, unknown>;
  if (format !== START_TIMES_FORMAT || !Array.isArray(starts)) return [];
  return starts.filter(isStartTime).slice(-START_TIMES_KEPT);
}

/** This function gives the text of the file with one more start time. The file keeps the last `START_TIMES_KEPT` times. */
export function addStartTime(text: string | undefined, start: StartTime): string {
  const starts = [...parseStartTimes(text), start].slice(-START_TIMES_KEPT);
  return `${JSON.stringify({ format: START_TIMES_FORMAT, starts }, null, 2)}\n`;
}

/**
 * This function gives the ready window from the measured start times. The window is the worst time plus the spread of
 * the times, between `floorMs` and `WINDOW_CAP_MS`. With fewer than `MEASURED_STARTS` times, the window is the
 * bootstrap window.
 */
export function readyWindow(starts: readonly StartTime[], floorMs: number): ReadyWindow {
  const times = starts.map((start) => start.ms);
  if (times.length < MEASURED_STARTS) return { ms: Math.min(WINDOW_CAP_MS, Math.max(floorMs, BOOTSTRAP_WINDOW_MS)), starts: times.length, measured: false };
  const worst = Math.max(...times);
  const best = Math.min(...times);
  return { ms: Math.min(WINDOW_CAP_MS, Math.max(floorMs, Math.ceil(worst + (worst - best)))), starts: times.length, measured: true };
}

/** This function gives the line that tells the ready window. */
export function readyWindowText(window: ReadyWindow): string {
  const seconds = String(Math.ceil(window.ms / 1000));
  return window.measured
    ? `The ready window of the runtime is ${seconds} s, from ${String(window.starts)} measured starts.`
    : `The ready window of the runtime is ${seconds} s. The host has ${String(window.starts)} of the ${String(MEASURED_STARTS)} measured starts that the window needs.`;
}
