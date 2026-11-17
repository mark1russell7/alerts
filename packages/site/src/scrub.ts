/**
 * The model of the time scrubber of the local page. The scrubber sets the time of the map. Its range ends at the
 * present, and the end of the range shows the live map. Each other time shows the map of that time from the
 * histories. The functions are pure: the page gives the payloads, the state of the scrubber and the text of a time.
 */

import { historyTimes, historyView, type Histories, type MapPayload } from "@mark1russell7/alerts";
import { changeIndex, type Replay, type TimeSpan } from "@mark1russell7/visuals";
import type { ScrubberLabel } from "@mark1russell7/visuals/scrubber";

/** The shortest range of the scrubber, in milliseconds: one hour. A person can then set a time with a pointer. */
export const SHORTEST_RANGE_MS = 3_600_000;

/** The length of a day, in milliseconds. */
const DAY_MS = 86_400_000;

/** The text of the present, in the scrubber and at the end of its axis. */
export const NOW_TEXT = "Now";

/** The range of the scrubber after a read: the range of time, and the sorted times at which the map changed. */
export interface ScrubRange {
  /** The range. Its end is the present: the time of the last pass of the runtime. */
  readonly span: TimeSpan;
  /** The times of the changes, from the oldest. Each time is in the range. */
  readonly times: readonly number[];
}

/**
 * This function gives the range of the scrubber, or `undefined` when the page shows no scrubber. The page shows no
 * scrubber before the first pass of the runtime, and when the histories have no change before the present.
 *
 * The range starts at the oldest change, and it is at least `SHORTEST_RANGE_MS` long. An expiry after the present is
 * not in the times, because the map did not change yet.
 */
export function scrubRange(payload: MapPayload, kept: Histories): ScrubRange | undefined {
  const present = Math.max(payload.at ?? -Infinity, kept.at ?? -Infinity);
  if (!Number.isFinite(present)) return undefined;
  const times = historyTimes(kept).filter((time) => time <= present);
  const first = times[0];
  if (first === undefined) return undefined;
  return { span: { from: Math.min(first, present - SHORTEST_RANGE_MS), to: present }, times };
}

/** This function tells if a scrubber shows the present. With no scrubber, the page shows the present. */
export function atPresent(replay: Replay | undefined): boolean {
  return replay === undefined || replay.at >= replay.span.to;
}

/**
 * This function gives the key of the picture of a scrubber. Two states with one key have one picture, so the page
 * draws again only for a new key. The present has its own key, because the live map also has the coverage of each place.
 */
export function scrubKey(replay: Replay | undefined, times: readonly number[]): number {
  return replay === undefined || atPresent(replay) ? -1 : changeIndex(times, replay.at);
}

/**
 * This function gives the payload that the page draws. The present gives the live payload. A past time gives the
 * payload with the view of that time from the histories, and with that time as its time.
 */
export function scrubPayload(payload: MapPayload, kept: Histories, replay: Replay | undefined): MapPayload {
  if (replay === undefined || atPresent(replay)) return payload;
  return { ...payload, at: replay.at, view: historyView(kept, replay.at, payload.view.places) };
}

/** The form of the text of a time. The clock time is alone, with the day of the week, or with the date. */
export type TimeForm = "time" | "weekday" | "date";

/**
 * This function gives the form of the text of a time for a reader at the present. A time of the day of the present
 * needs only its clock time. A time of the 6 days before needs the day of the week. An older time needs the date.
 * `day` gives the name of the local day of a time.
 */
export function timeForm(at: number, present: number, day: (at: number) => string): TimeForm {
  if (day(at) === day(present)) return "time";
  return Math.abs(present - at) < 6 * DAY_MS ? "weekday" : "date";
}

/** This function gives the text of the time of a scrubber. `clock` gives the text of a past time for a reader at the present. */
export function scrubText(at: number, replay: Replay, clock: (at: number, present: number) => string): string {
  return at >= replay.span.to ? NOW_TEXT : clock(at, replay.span.to);
}

/** This function gives the labels of the axis of the scrubber: the time of its start, and the present. */
export function scrubLabels(span: TimeSpan, clock: (at: number, present: number) => string): readonly ScrubberLabel[] {
  return [
    { at: span.from, text: clock(span.from, span.to) },
    { at: span.to, text: NOW_TEXT },
  ];
}

/** The words of the page for the time of the map. */
export interface ScrubWords {
  /** The heading of the map. */
  readonly map: string;
  /** The heading of the list of the incidents. */
  readonly list: string;
  /** The note below the scrubber for a past time, or `undefined` for the present. */
  readonly past: string | undefined;
}

/**
 * This function gives the words of the page for the time of the map. For a past time, the two headings tell the time,
 * and a note tells that the map is not the live map. A change of the history names no place. Thus the note also tells
 * that a past time has no level for a place.
 */
export function scrubWords(replay: Replay | undefined, clock: (at: number, present: number) => string): ScrubWords {
  if (replay === undefined || atPresent(replay)) return { map: "Map", list: "Live incidents", past: undefined };
  const text = clock(replay.at, replay.span.to);
  return {
    map: `Map at ${text}`,
    list: `Incidents at ${text}`,
    past: `The map shows the incidents, their areas and the level of each place at ${text}. It does not show the coverage of that time.`,
  };
}
