/**
 * The looks of the health states of a source. The table has the word and the tone of each state, and the sequence of
 * the states in a list. The demo and the local page share this table. Thus a state has one word and one tone on each page.
 * This module does not import the made-up data of the demo, so the bundle of the local page does not hold it.
 */

import { DOWN_STATES, type HealthState } from "@mark1russell7/alerts";

/** The tone of a fact of the health. Each tone has one color and one sign. Thus the color is not the only cue. */
export type Tone = "good" | "warn" | "bad" | "quiet";

/** The look of one health state. */
export interface HealthLook {
  /** The word of the state on a page. */
  readonly word: string;
  /** The tone of the state. */
  readonly tone: Tone;
}

/** The look of each health state of a source. */
export const HEALTH_LOOKS: Readonly<Record<HealthState, HealthLook>> = {
  unknown: { word: "Unknown", tone: "quiet" },
  healthy: { word: "Healthy", tone: "good" },
  slow: { word: "Slow", tone: "warn" },
  failing: { word: "Failing", tone: "bad" },
  silent: { word: "Silent", tone: "bad" },
  changed: { word: "Changed", tone: "bad" },
};

/** The health states from the worst: the states of a source that is down, then a source with no read, then the others. */
export const STATE_ORDER: readonly HealthState[] = [...DOWN_STATES, "unknown", "slow", "healthy"];
