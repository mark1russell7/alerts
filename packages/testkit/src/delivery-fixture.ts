/**
 * The fixture of the cases of a channel. It has one source with one tornado warning for Sedgwick County KS, and
 * one person with a `life-safety` policy on Pushover. The token and the user key are test values.
 */
import {
  type ChannelId,
  type EscalationPolicy,
  type Observation,
  type ObservationId,
  type PersonId,
  type PlaceId,
  type Recipient,
  type Report,
  reportId,
  type SourceId,
  type SourceProcedures,
  type WatchedPlace,
} from "@mark1russell7/alerts";
import type { RuntimeLog, RuntimeOptions } from "@mark1russell7/alerts-runtime";

const MINUTE = 60_000;

/** The id of the Pushover channel. */
export const PUSHOVER = "pushover" as ChannelId;

/** A public place in Kansas: Sedgwick County KS. */
export const FIXTURE_PLACE: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };

/** The fixture of one case. */
export interface DeliveryFixture {
  readonly source: SourceId;
  /** The API token: 30 letters and digits. The Pushover fake does not examine it. */
  readonly token: string;
  readonly recipient: Recipient;
  readonly view: RuntimeOptions["view"];
  /** This function gives the source of the case. Its warning has the time `sent`, and it lasts 45 minutes. */
  readonly sourceOf: (sent: number) => SourceProcedures;
}

/** This function gives a test value of 30 letters and digits: the word, then zeros. */
export function testKey(word: string): string {
  if (!/^[a-z]{1,30}$/.test(word)) throw new RangeError(`The word "${word}" is not 1 to 30 small letters.`);
  return word + "0".repeat(30 - word.length);
}

/**
 * This function gives the fixture of a case. The source has the id `source`. The token and the user key start with
 * `word`, for example `casefour`.
 */
export function deliveryFixture(source: string, word: string): DeliveryFixture {
  const id = source as SourceId;
  const policy: EscalationPolicy = { level: "life-safety", steps: [{ channel: PUSHOVER, at: 0 }], exhaustedAfter: 20 * MINUTE };
  const recipient: Recipient = {
    watch: { person: "person-1" as PersonId, places: [FIXTURE_PLACE.id], rules: [] },
    policies: [policy],
    addresses: { pushover: { user: testKey(`${word}user`) } },
  };
  const warningOf = (seen: Observation, sent: number): Report => ({
    id: reportId({ source: id, key: "w1", sent }),
    source: id,
    origin: "nws",
    key: "w1",
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent,
    received: seen.fetched,
    expires: sent + 45 * MINUTE,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: source,
    headline: "Tornado Warning for Sedgwick County KS",
    instruction: "TAKE COVER NOW!",
    observation: seen.id,
    parameters: {},
  });
  // The interval of the source is longer than an arm, thus it fetches one time.
  const sourceOf = (sent: number): SourceProcedures => ({
    describe: () => ({
      id,
      title: `The source of ${source}`,
      origins: ["nws"],
      dependsOn: [`provider:${source}`],
      uses: ["internet", "dns", "power"],
      kinds: ["met"],
      coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
      transport: "poll",
      interval: 60 * MINUTE,
      slowAfter: 10_000,
      auth: "none",
    }),
    fetch: async () => ({
      ok: true,
      observations: [{ id: `${source}:w1` as ObservationId, source: id, fetched: sent, contentType: "application/json", body: "{}", transport: { latency: 0 } }],
      complete: true,
    }),
    map: ({ observation }) => ({ reports: [warningOf(observation, sent)], problems: [] }),
  });
  return {
    source: id,
    token: testKey(`${word}token`),
    recipient,
    view: { places: [FIXTURE_PLACE], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } },
    sourceOf,
  };
}

/** A failed call of one pass, as the delivery step gives it. */
export interface CallFailure {
  readonly call: string;
  readonly kind: string;
  readonly message: string;
}

/** What the log of the runtime holds at the end of an arm. */
export interface LogSummary {
  /** The key, the time of the accept and the Pushover receipt of each delivery. */
  readonly deliveries: readonly { readonly key: string; readonly at: number; readonly receipt?: string }[];
  readonly acknowledgments: number;
  /** The delivery keys of the cancels. */
  readonly cancelled: readonly string[];
}

/** This function reads the deliveries, the acknowledgments and the cancels of a log. */
export function logSummaryOf(log: Pick<RuntimeLog, "read">): LogSummary {
  const events = [...log.read()];
  return {
    deliveries: events.flatMap((event) => {
      if (event.type !== "delivery") return [];
      const receipt = event.delivery.receipt?.["receipt"];
      return [{ key: event.delivery.key, at: event.delivery.at, ...(receipt === undefined ? {} : { receipt }) }];
    }),
    acknowledgments: events.filter((event) => event.type === "acknowledgment").length,
    cancelled: events.flatMap((event) => (event.type === "cancelled" ? [event.delivery] : [])),
  };
}
