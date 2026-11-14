/**
 * The id functions of the alert system. Each id is the SHA-256 of a content, in lowercase hex.
 * So each adapter and each copy of the system gives the same id to the same content, and a
 * duplicate changes nothing.
 *
 * The hash input is a JSON array: the scheme, the kind of id, then the fields. JSON escapes each
 * string, so two different lists of fields do not give the same input. The kind keeps the ids
 * of two kinds apart.
 */
import type { Instant, Level, ObservationId, PersonId, ReportId, SourceId } from "./contracts.ts";

/** The version of the id scheme. A change of the input of an id function raises it. */
export const ID_SCHEME = "alerts-id/1";

/** The input of `observationId`: the parts of an observation that tell its content. */
export interface ObservationIdInput {
  readonly source: SourceId;
  readonly contentType: string;
  readonly body: string;
  /** The URL of the request. The `map` function of an adapter can read it, so it is part of the content. */
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
export async function observationId(input: ObservationIdInput): Promise<ObservationId> {
  const hex = await digest(["observation", input.source, input.contentType, input.url ?? null, input.body]);
  return hex as ObservationId;
}

/**
 * This function gives the id of a report. An update of the source has a new key or a new sent
 * time, so it gets a new id. The merge uses the smallest report id of an incident as its anchor.
 */
export async function reportId(input: ReportIdInput): Promise<ReportId> {
  const hex = await digest(["report", input.source, input.key, input.sent]);
  return hex as ReportId;
}

/**
 * This function gives the key of a message. A channel that can drop a repeated key does so. A
 * repeat of the same step gets the same key, and the next step gets a new key.
 */
export async function messageKey(input: MessageKeyInput): Promise<string> {
  return digest(["message", input.incident, input.level, input.person, input.step]);
}

// The core runs in Node and in browsers, so its compiler settings hold no platform types. These
// two types declare the only platform functions that the core uses: WebCrypto and TextEncoder.
interface Platform {
  readonly crypto: { readonly subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> } };
  readonly TextEncoder: new () => { encode(text: string): Uint8Array };
}
const platform = globalThis as unknown as Platform;
const encoder = new platform.TextEncoder();

// This function is local because no home package has a content hash at this time. It moves to
// the home of content hashes when the map of homes names one.
async function digest(fields: readonly (string | number | null)[]): Promise<string> {
  const bytes = await platform.crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify([ID_SCHEME, ...fields])));
  let hex = "";
  for (const byte of new Uint8Array(bytes)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
