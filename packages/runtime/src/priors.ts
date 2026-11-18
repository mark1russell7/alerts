/**
 * The priors of the shadow score for the runtime. The score decides no level. Thus a fault of the priors stops only
 * the score, and each alert goes on.
 */
import type { ScorePriors } from "@mark1russell7/alerts";
import { committedPriors } from "@mark1russell7/alerts-rates";
import { errorMessage } from "@mark1russell7/text";

/**
 * This function gives the committed priors of the package `rates`. When the read fails, it gives the message to
 * `report` and gives `undefined`. Then the runtime operates with no shadow score.
 */
export function loadPriors(report: (message: string) => void, read: () => ScorePriors = committedPriors): ScorePriors | undefined {
  try {
    return read();
  } catch (error) {
    report(`The priors of the shadow score do not load (${errorMessage(error)}). The runtime gives no shadow score, and each alert goes on.`);
    return undefined;
  }
}
