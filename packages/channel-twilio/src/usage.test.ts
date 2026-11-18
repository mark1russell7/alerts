import type { TwilioFetch } from "@procedures/notify/twilio";
import { describe, expect, it } from "vitest";
import { readTwilioSpend, TWILIO_RENT_CATEGORY, TWILIO_TOTAL_CATEGORY, type TwilioSpendOptions } from "./index.ts";

// Fake credentials: no account has them.
const ACCOUNT = `AC${"0".repeat(32)}`;
const CREDENTIALS = { accountSid: ACCOUNT, secret: "fake-secret" };
// The start of a month in New York (05:00 in GMT), and a time later in the month.
const FROM = Date.UTC(2026, 10, 1, 4);
const TO = Date.UTC(2026, 10, 17, 21, 30);

/** One usage record of the Twilio API, in the form of its JSON. */
const record = (category: string, price: string, extra: Record<string, unknown> = {}) => ({
  category,
  start_date: "2026-11-01",
  end_date: "2026-11-17",
  price,
  price_unit: "usd",
  usage: price,
  usage_unit: "usd",
  ...extra,
});

type Answer = { status: number; body: unknown } | Error;

/** A fake Twilio server: it records each address and gives the next answer. */
const server = (...answers: Answer[]) => {
  const urls: string[] = [];
  const fetch: TwilioFetch = async (url) => {
    urls.push(url);
    const answer = answers.shift() ?? { status: 500, body: {} };
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => JSON.stringify(answer.body), headers: { get: () => null } };
  };
  return { urls, fetch };
};

const page = (records: readonly unknown[], next?: string) => ({ status: 200, body: { usage_records: records, next_page_uri: next ?? null } });
const optionsOf = (fake: ReturnType<typeof server>, extra: Partial<TwilioSpendOptions> = {}): TwilioSpendOptions => ({ credentials: CREDENTIALS, fetch: fake.fetch, from: FROM, to: TO, ...extra });
const searchOf = (url: string | undefined) => Object.fromEntries(new URL(url ?? "").searchParams);

describe("readTwilioSpend", () => {
  it("gives the total price of the days of the month, less the rent of the numbers", async () => {
    const fake = server(page([record(TWILIO_TOTAL_CATEGORY, "3.4625")]), page([record(TWILIO_RENT_CATEGORY, "2.15")]));
    const read = await readTwilioSpend(optionsOf(fake));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.usedUsd).toBeCloseTo(1.3125, 9);
    expect(fake.urls.map(searchOf)).toEqual([
      { Category: "totalprice", StartDate: "2026-11-01", EndDate: "2026-11-17" },
      { Category: "phonenumbers", StartDate: "2026-11-01", EndDate: "2026-11-17" },
    ]);
    expect(new URL(fake.urls[0] ?? "").pathname).toBe(`/2010-04-01/Accounts/${ACCOUNT}/Usage/Records.json`);
  });

  it("starts at the day of GMT that holds the start of the month", async () => {
    // The month of a zone east of GMT starts on the last day of the month before, in GMT.
    const fake = server(page([]), page([]));
    expect(await readTwilioSpend(optionsOf(fake, { from: Date.UTC(2026, 9, 31, 15), to: Date.UTC(2026, 10, 1, 2) }))).toEqual({ ok: true, usedUsd: 0 });
    expect(searchOf(fake.urls[0])).toMatchObject({ StartDate: "2026-10-31", EndDate: "2026-11-01" });
  });

  it("gives 0 for an account with no usage, and a value below 0 for a rent above the total", async () => {
    expect(await readTwilioSpend(optionsOf(server(page([]), page([]))))).toEqual({ ok: true, usedUsd: 0 });
    const credit = await readTwilioSpend(optionsOf(server(page([record(TWILIO_TOTAL_CATEGORY, "1.00")]), page([record(TWILIO_RENT_CATEGORY, "2.15")]))));
    expect(credit.ok && credit.usedUsd < 0).toBe(true);
  });

  it("gives a failure, and sends no second request, when the total fails", async () => {
    const fake = server({ status: 401, body: { code: 20003, message: "Authenticate" } });
    const read = await readTwilioSpend(optionsOf(fake));
    expect(read).toMatchObject({ ok: false });
    if (!read.ok) expect(read.message).toMatch(/^Twilio did not give the usage totalprice \(auth\)/u);
    expect(fake.urls).toHaveLength(1);
  });

  it("gives a failure when the rent fails, a fetch throws or an answer is broken", async () => {
    const rent = await readTwilioSpend(optionsOf(server(page([record(TWILIO_TOTAL_CATEGORY, "1.00")]), { status: 500, body: { code: 20500, message: "Internal Server Error" } })));
    expect(rent).toMatchObject({ ok: false });
    if (!rent.ok) expect(rent.message).toMatch(/^Twilio did not give the usage phonenumbers \(server\)/u);
    expect(await readTwilioSpend(optionsOf(server(new Error("connect ECONNREFUSED")))).then((read) => read.ok)).toBe(false);
    expect(await readTwilioSpend(optionsOf(server({ status: 200, body: { page: 0 } }))).then((read) => read.ok)).toBe(false);
    expect(await readTwilioSpend(optionsOf(server(page([{ category: "totalprice" }])))).then((read) => read.ok)).toBe(false);
  });

  it("gives a failure for a price in another currency, a record of another category or a second page", async () => {
    expect(await readTwilioSpend(optionsOf(server(page([record(TWILIO_TOTAL_CATEGORY, "1.00", { price_unit: "eur" })]))))).toEqual({ ok: false, message: "The usage totalprice is not in US dollars." });
    expect(await readTwilioSpend(optionsOf(server(page([record("calls", "1.00")]))))).toEqual({ ok: false, message: "The answer of the usage totalprice has a record of another category." });
    const next = `/2010-04-01/Accounts/${ACCOUNT}/Usage/Records.json?Category=totalprice&Page=1&PageToken=PA1`;
    expect(await readTwilioSpend(optionsOf(server(page([record(TWILIO_TOTAL_CATEGORY, "1.00")], next))))).toEqual({ ok: false, message: "The usage totalprice has more than one page." });
  });

  it("gives a failure for a time span that is not valid, and sends no request", async () => {
    const fake = server();
    expect(await readTwilioSpend(optionsOf(fake, { from: TO, to: FROM }))).toEqual({ ok: false, message: "The read of the spend has no valid time span." });
    expect(await readTwilioSpend(optionsOf(fake, { from: Number.NaN }))).toEqual({ ok: false, message: "The read of the spend has no valid time span." });
    expect(fake.urls).toHaveLength(0);
  });

  it("stops at the abort of the signal, and throws the reason of the abort", async () => {
    const fetch: TwilioFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const stop = new AbortController();
    const reading = readTwilioSpend({ credentials: CREDENTIALS, fetch, from: FROM, to: TO }, stop.signal);
    stop.abort();
    await expect(reading).rejects.toThrow(/abort/iu);
  });
});
