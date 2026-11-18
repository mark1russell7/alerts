/**
 * The look of each status of an incident. An incident with the status `actual` is a real alert. Each other status has
 * a word and an edge of its own, so a test does not look like a real alert. The flat map, the globe, the legend and
 * the lists read this one table.
 */

import type { MapView, Status } from "@mark1russell7/alerts";

/** A status that is not `actual`: a test, an exercise, a draft or a report of the system. */
export type OtherStatus = Exclude<Status, "actual">;

/** The look of the incidents of one status. */
export interface StatusLook {
  /** The word of the status: the text on the area of an incident, in the legend and in the lists. */
  readonly word: string;
  /** The lengths of a dash and of a gap of the edge of an area, in CSS pixels. */
  readonly dash: readonly [dash: number, gap: number];
}

/**
 * The look of each status other than `actual`, in the order of the legend. The area of such an incident has no fill.
 * Its color stays the color of its level, because the level tells what each person gets.
 */
export const STATUS_LOOKS: Readonly<Record<OtherStatus, StatusLook>> = {
  test: { word: "Test", dash: [6, 4] },
  exercise: { word: "Exercise", dash: [14, 5] },
  draft: { word: "Draft", dash: [2, 3] },
  system: { word: "System", dash: [3, 9] },
};

/** The statuses other than `actual`, in the order of the legend. The type of `STATUS_LOOKS` keeps the list complete. */
export const OTHER_STATUSES = Object.keys(STATUS_LOOKS) as readonly OtherStatus[];

/** This function gives the look of a status, or `undefined` for the status `actual`. */
export const statusLook = (status: Status): StatusLook | undefined => (status === "actual" ? undefined : STATUS_LOOKS[status]);

/** This function gives the dash of a status as the value of the SVG attribute `stroke-dasharray`. */
export const dashText = (look: StatusLook): string => look.dash.join(" ");

/**
 * This function gives the statuses other than `actual` that the map of a view shows, in the order of the legend.
 * The map shows an incident only when it has a shape.
 */
export function shownStatuses(view: MapView): OtherStatus[] {
  const found = new Set<Status>(view.incidents.filter((incident) => incident.shapes.length > 0).map((incident) => incident.status));
  return OTHER_STATUSES.filter((status) => found.has(status));
}
