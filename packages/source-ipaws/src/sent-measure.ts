/**
 * The measure of the sent times of the WEA copies (AL-8). The IPAWS copy of an NWS message has the id of the message
 * and then `COPY_SUFFIX`. The function `copyMeasure` of the core gives the class of each check.
 *
 * The function is pure. It reads no clock and no network. The script `scripts/measure.ts` gives it the reports of
 * the two sources.
 */

import { copyMeasure, type Expectation, type Instant, type Report, type SentMeasure } from "@mark1russell7/alerts";
import { nwsEvent } from "@mark1russell7/alerts-format-nws";
import { WEA_EXPECTATION } from "./expectation.ts";

/** The end of the id of an IPAWS copy. The copy has the id of the NWS message and then this text. */
export const COPY_SUFFIX = ".IPAWS";

/** The options of the measure. */
export interface SentMeasureOptions {
  /** The expectation. The default is `WEA_EXPECTATION`. */
  readonly expectation?: Expectation;
  /**
   * The censor time. A message with a later sent time and no copy at its sent time is censored,
   * because its copy can come after the data. With no censor time, no message is censored.
   */
  readonly censorAfter?: Instant;
}

/**
 * This function measures the sent times of the IPAWS copies over the reports of the two sources, with `copyMeasure`.
 * The key of the copy is the key of the message and then `COPY_SUFFIX`. The event of a check is its NWS event code.
 */
export function sentMeasure(reports: readonly Report[], options: SentMeasureOptions = {}): SentMeasure {
  return copyMeasure(reports, options.expectation ?? WEA_EXPECTATION, {
    copyKey: (key) => `${key}${COPY_SUFFIX}`,
    eventOf: nwsEvent,
    ...(options.censorAfter === undefined ? {} : { censorAfter: options.censorAfter }),
  });
}
