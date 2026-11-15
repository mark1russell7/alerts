/**
 * The states of a watch. A national source with no filter by area keeps only the messages of the
 * watched states. Then the log of an instance holds no message of a different state.
 */

import type { Watch } from "@mark1russell7/alerts";
import { stateOfCode } from "./codes.ts";

/**
 * This function gives the states of a watch as postal codes, from the state, UGC and SAME codes of
 * its places. `undefined` means all states: a place has no code of a known state.
 */
export function statesOf(watch: Watch): ReadonlySet<string> | undefined {
  const states = new Set<string>();
  for (const place of watch.places) {
    const own = new Set<string>();
    for (const code of place.codes) {
      const state = stateOfCode(code);
      if (state !== undefined) own.add(state);
    }
    if (own.size === 0) return undefined;
    for (const state of own) states.add(state);
  }
  return states;
}
