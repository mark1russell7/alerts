/**
 * The ids of observations and reports: a stub with the signatures of the core.
 *
 * TODO(AL-5): The core gives `observationId` and `reportId` (SHA-256 from WebCrypto) in pull request
 * mark1russell7/alerts#3. When it merges, this file goes away, and the adapter imports them from
 * `@mark1russell7/alerts`. The stub ids are deterministic and unique, but they are not the ids of the core.
 */

import type { Instant, ObservationId, ReportId, SourceId } from "@mark1russell7/alerts";

/** The input of `observationId`, as the core gives it. */
export interface ObservationIdInput {
  readonly source: SourceId;
  readonly contentType: string;
  readonly body: string;
  readonly url?: string;
}

/** The input of `reportId`, as the core gives it. */
export interface ReportIdInput {
  readonly source: SourceId;
  readonly key: string;
  readonly sent: Instant;
}

/** This stub gives the id of an observation from its content. */
export async function observationId(input: ObservationIdInput): Promise<ObservationId> {
  return `stub:${JSON.stringify(["observation", input.source, input.contentType, input.url ?? null, input.body])}` as ObservationId;
}

/** This stub gives the id of a report from the source id, the source key and the sent time. */
export async function reportId(input: ReportIdInput): Promise<ReportId> {
  return `stub:${JSON.stringify(["report", input.source, input.key, input.sent])}` as ReportId;
}
