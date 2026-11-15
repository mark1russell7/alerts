/**
 * The id functions of the alert system. Each id is the SHA-256 of a content, in lowercase hex.
 * So each adapter and each copy of the system gives the same id to the same content, and a
 * duplicate changes nothing.
 *
 * The hash input is the canonical JSON of an array: the scheme, the kind of id, then the fields.
 * JSON escapes each string, so two different lists of fields do not give the same input. The kind
 * keeps the ids of two kinds apart. The hash comes from `@mark1russell7/rigor-generators`, the home
 * of content hashes. It is pure JavaScript, so the ids are synchronous in Node and in browsers.
 */
import { canonicalHash } from "@mark1russell7/rigor-generators";
import type { Instant, Level, ObservationId, PersonId, ReportId, SourceId } from "./contracts.ts";

/** The version of the id scheme. A change of the input of an id function raises it. */
export const ID_SCHEME = "alerts-id/1";

/** The input of `observationId`: the parts of an observation that tell its content. */
export interface ObservationIdInput {
  readonly source: SourceId;
  readonly contentType: string;
  readonly body: string;
  /**
   * The part of the URL of the request that the `map` function of the adapter reads. The `map` function
   * can read the URL, so it is part of the content. A part that `map` does not read, for example the time
   * of a poll, is not in it. Then a poll with no change gives the same id.
   */
  readonly url?: string;
}

/** The input of `reportId`: the source, the key that the source gives and the sent time. */
export interface ReportIdInput {
  readonly source: SourceId;
  readonly key: string;
  readonly sent: Instant;
}

/** The input of `messageKey`: one step of the escalation of one level of one incident to one person. */
export interface MessageKeyInput {
  readonly incident: ReportId;
  readonly level: Level;
  readonly person: PersonId;
  /** The index of the step in the escalation of the person, from 0. */
  readonly step: number;
}

/**
 * This function gives the id of an observation. A poll that gets the same body from the same
 * request gives the same id, so the log keeps the observation one time. The fetch time and the
 * other facts of the transport are not part of the id.
 */
export function observationId(input: ObservationIdInput): ObservationId {
  return digest(["observation", input.source, input.contentType, input.url ?? null, input.body]) as ObservationId;
}

/**
 * This function gives the id of a report. An update of the source has a new key or a new sent
 * time, so it gets a new id. The merge uses the smallest report id of an incident as its anchor.
 */
export function reportId(input: ReportIdInput): ReportId {
  return digest(["report", input.source, input.key, input.sent]) as ReportId;
}

/**
 * This function gives the key of a message. A channel that can drop a repeated key does so. A
 * repeat of the same step gets the same key, and the next step gets a new key.
 */
export function messageKey(input: MessageKeyInput): string {
  return digest(["message", input.incident, input.level, input.person, input.step]);
}

// The form "json" writes NaN and an infinite number as null, and escapes a lone surrogate. So the
// id functions do not throw, and `map` stays total.
function digest(fields: readonly (string | number | null)[]): string {
  return canonicalHash([ID_SCHEME, ...fields], { form: "json" });
}
