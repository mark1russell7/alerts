/**
 * The read of the spend of the Twilio account in the month of the cap (AL-57). The gates of the cap count only the sends
 * of the channels. Twilio also bills other usage: the calls of the outage Functions, the replies, the fees. The watch of
 * the spend gives the gates the spend of this read when it is larger.
 *
 * - The spend is the usage record `totalprice` less the record `phonenumbers`. The rent of the numbers is in the fixed
 *   costs of the cap.
 * - Twilio counts the usage in days of GMT. The read starts at the day of GMT that holds the start of the month. Thus it
 *   can count some hours of the month before. The cap can then stop a send early, but not late.
 * - Twilio adds the usage to the records after a delay. The read can miss the usage of that delay.
 * - No failure holds a key or a number.
 */

import type { Instant } from "@mark1russell7/alerts";
import { errorMessage } from "@mark1russell7/text";
import {
  callTwilio,
  extractTwilioUsageRecords,
  twilioUsageRecordsRequest,
  type TwilioCredentials,
  type TwilioFetch,
  type TwilioRequest,
} from "@procedures/notify/twilio";

/** The usage category of Twilio with all the usage of the account. */
export const TWILIO_TOTAL_CATEGORY = "totalprice";

/** The usage category of Twilio with the rent of the phone numbers. */
export const TWILIO_RENT_CATEGORY = "phonenumbers";

/** The time limit of each request of the read of the spend. */
export const TWILIO_USAGE_TIMEOUT_MS = 10_000;

/** The options of the read of the spend. */
export interface TwilioSpendOptions {
  readonly credentials: TwilioCredentials;
  readonly fetch: TwilioFetch;
  /** The start of the month of the cap. The first day of the read is the day of GMT that holds it. */
  readonly from: Instant;
  /** The time of the read. The last day of the read is the day of GMT that holds it. */
  readonly to: Instant;
  /** The time limit of each request. The default is `TWILIO_USAGE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The result of a read of the spend: the spend in US dollars, or the reason of the failure. */
export type TwilioSpendReading = { readonly ok: true; readonly usedUsd: number } | { readonly ok: false; readonly message: string };

/** This function gives the day of GMT of an instant, in the form `YYYY-MM-DD`. */
function gmtDay(at: Instant): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * This function reads the spend of the Twilio account from the time `from` to the time `to`, in US dollars. The spend
 * does not include the rent of the numbers. At the abort of the signal, it stops and throws.
 */
export async function readTwilioSpend(options: TwilioSpendOptions, signal?: AbortSignal): Promise<TwilioSpendReading> {
  if (!Number.isFinite(options.from) || !Number.isFinite(options.to) || options.from > options.to) {
    return { ok: false, message: "The read of the spend has no valid time span." };
  }
  const days = { startDate: gmtDay(options.from), endDate: gmtDay(options.to) };
  const timeoutMs = options.timeoutMs ?? TWILIO_USAGE_TIMEOUT_MS;
  const sum = async (category: string): Promise<{ readonly ok: true; readonly usd: number } | { readonly ok: false; readonly message: string }> => {
    let request: TwilioRequest;
    try {
      request = twilioUsageRecordsRequest(options.credentials, { category, ...days });
    } catch (error) {
      return { ok: false, message: `The read of the usage ${category} has no valid request: ${errorMessage(error)}` };
    }
    const result = await callTwilio(options.fetch, request, extractTwilioUsageRecords, signal === undefined ? { timeoutMs } : { timeoutMs, signal });
    if (!result.ok) return { ok: false, message: `Twilio did not give the usage ${category} (${result.kind}): ${result.errors.join(" ")}` };
    // A category filter gives one record for the days of the filter. A second page is not an answer of that query.
    if (result.nextPageUri !== undefined) return { ok: false, message: `The usage ${category} has more than one page.` };
    let usd = 0;
    for (const record of result.records) {
      if (record.category !== category) return { ok: false, message: `The answer of the usage ${category} has a record of another category.` };
      if (record.priceUnit.toLowerCase() !== "usd") return { ok: false, message: `The usage ${category} is not in US dollars.` };
      if (!Number.isFinite(record.price)) return { ok: false, message: `The usage ${category} has no finite price.` };
      usd += record.price;
    }
    return { ok: true, usd };
  };
  const total = await sum(TWILIO_TOTAL_CATEGORY);
  if (!total.ok) return total;
  const rent = await sum(TWILIO_RENT_CATEGORY);
  if (!rent.ok) return rent;
  return { ok: true, usedUsd: total.usd - rent.usd };
}
