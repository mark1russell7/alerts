/**
 * The source adapter of the alert system for any CAP feed. A CAP feed is an RSS 2.0 or Atom 1.0 index whose entries
 * link to CAP messages. The WMO Register of Alerting Authorities names the feeds of the world. The package reads the
 * index and each new message through polite-crawler, and gives the procedures of the source contract of
 * `@mark1russell7/alerts`. Each feed is a source of its own, with its config.
 *
 * The terms of each feed are a fact of the feed. The private config of an instance names only the feeds whose terms
 * let the instance read them.
 */

import type { SourceProcedures } from "@mark1russell7/alerts";
import { descriptorOf } from "./descriptor.ts";
import type { CapFeed } from "./feed.ts";
import { createCapFeedFetch, type CapFeedFetchOptions } from "./fetch.ts";
import { mapObservation } from "./map.ts";

export { descriptorOf } from "./descriptor.ts";
export { DEFAULT_INTERVAL, DEFAULT_PER_FETCH, DEFAULT_SLOW_AFTER, feedProblems, httpsBase, type CapFeed } from "./feed.ts";
export { createCapFeedFetch, observationOf, SET_ASIDE_AFTER, type CapFeedFetchInput, type CapFeedFetchOptions } from "./fetch.ts";
export { mapObservation } from "./map.ts";

/**
 * This function makes the procedures of the source of one feed: `describe`, `fetch` and `map`. It throws for a config
 * with problems. The source has no `check`, because a feed has no canary. It has no `locate`: the source asks for no
 * point.
 */
export function createCapFeedSource(options: CapFeedFetchOptions): SourceProcedures {
  const feed: CapFeed = options.feed;
  const fetch = createCapFeedFetch(options);
  const descriptor = descriptorOf(feed);
  return {
    describe: () => descriptor,
    // The signal of the caller stops the fetch at its limit, also in the wait of the pace.
    fetch: (input, signal) => fetch(input, signal),
    map: ({ observation }) => mapObservation(observation, feed),
  };
}
