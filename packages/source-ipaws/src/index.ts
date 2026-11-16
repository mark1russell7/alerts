/**
 * The source adapter of the alert system for the public feed of FEMA IPAWS (IPAWS-OPEN). The feed
 * has the CAP messages of the NWS for Wireless Emergency Alerts and the messages of the other
 * alerting authorities. The package gives the procedures of the source contract of `@mark1russell7/alerts`.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";
import { IPAWS_DESCRIPTOR } from "./descriptor.ts";
import { createIpawsFetch, type IpawsFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { IPAWS_DESCRIPTOR } from "./descriptor.ts";
export { NWS_API_SOURCE, WEA_EXPECTATION } from "./expectation.ts";
export {
  createIpawsFetch,
  CURSOR_SINCE,
  FEED_NAMESPACE,
  FEED_PATH,
  feedTime,
  IPAWS_BASE_URL,
  keeps,
  LOOKBACK_MS,
  OVERLAP_MS,
  readAnswer,
  sinceOf,
  WINDOW_MS,
} from "./fetch.ts";
export type { IpawsFetchInput, IpawsFetchOptions, Since } from "./fetch.ts";
export { mapObservation, NWS_SENDER, ORIGINS, originOf, SOURCE_ID } from "./map.ts";
export { COPY_SUFFIX, eventOf, sentFails, sentMeasure } from "./sent-measure.ts";
export type { CopyTime, SentCheck, SentClass, SentCounts, SentGap, SentMeasure, SentMeasureOptions } from "./sent-measure.ts";

/** The options of the IPAWS source. */
export interface IpawsSourceOptions extends IpawsFetchOptions {
  /** The languages of the reports, in order. The default is `en-US`. */
  readonly languages?: readonly string[];
}

/**
 * This function makes the procedures of the IPAWS source: `describe`, `fetch` and `map`. The source
 * has no `check`, because the feed has no canary. It has no `locate`: the feed has no lookup.
 */
export function createIpawsSource(options: IpawsSourceOptions): SourceProcedures {
  const fetch = createIpawsFetch(options);
  const languages = options.languages;
  return {
    describe: () => IPAWS_DESCRIPTOR,
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation, languages),
  };
}
