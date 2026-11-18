import type { TwilioFetch, TwilioMessage } from "@procedures/notify/twilio";
import { describe, expect, it } from "vitest";
import { optInChangeOf, readTwilioReplies, TWILIO_REPLIES_PAGE_LIMIT, type TwilioRepliesOptions } from "./index.ts";

// Fake credentials and fake numbers: the country code +999 has no country. A test looks for the numbers in each failure.
const ACCOUNT = `AC${"0".repeat(32)}`;
const CREDENTIALS = { accountSid: ACCOUNT, secret: "fake-secret" };
const TEXT_FROM = "+99900000003";
const FIRST = "+99900000002";
const SECOND = "+99900000004";
const SINCE = Date.UTC(2026, 10, 17, 21, 30);
const MINUTE = 60_000;

const sid = (n: number): string => `SM${String(n).padStart(32, "0")}`;
const rfc = (at: number): string => new Date(at).toUTCString().replace("GMT", "+0000");

/** One text of a page of the Twilio API, in the form of its JSON. */
const text = (n: number, from: string, body: string, at: number, extra: Record<string, unknown> = {}) => ({
  sid: sid(n),
  from,
  to: TEXT_FROM,
  body,
  direction: "inbound",
  status: "received",
  date_sent: rfc(at),
  ...extra,
});

const NEXT = `/2010-04-01/Accounts/${ACCOUNT}/Messages.json?To=%2B99900000003&PageSize=1000&Page=1&PageToken=PAMQ`;

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

const page = (messages: readonly unknown[], next?: string) => ({ status: 200, body: { messages, next_page_uri: next ?? null } });
const optionsOf = (fake: ReturnType<typeof server>, extra: Partial<TwilioRepliesOptions> = {}): TwilioRepliesOptions => ({
  credentials: CREDENTIALS,
  fetch: fake.fetch,
  to: TEXT_FROM,
  since: SINCE,
  ...extra,
});

const message = (extra: Partial<TwilioMessage> = {}): TwilioMessage => ({
  sid: sid(1),
  from: FIRST,
  to: TEXT_FROM,
  body: "STOP",
  direction: "inbound",
  status: "received",
  dateSent: SINCE + MINUTE,
  ...extra,
});

describe("optInChangeOf", () => {
  it("gives a stop for each opt-out keyword and a start for each opt-in keyword of Twilio", () => {
    for (const body of ["STOP", "stop", " Unsubscribe ", "CANCEL", "END", "QUIT", "STOPALL"]) expect(optInChangeOf(message({ body }))).toEqual({ number: FIRST, kind: "stop", at: SINCE + MINUTE });
    for (const body of ["START", "Unstop", "YES"]) expect(optInChangeOf(message({ body }))?.kind).toBe("start");
  });

  it("gives no change for a help reply, a text that is not only a keyword, an outbound text, or a text with no sender or time", () => {
    for (const body of ["HELP", "INFO", "STOP!", "Stop, that is all", "", "please stop"]) expect(optInChangeOf(message({ body }))).toBeUndefined();
    expect(optInChangeOf(message({ direction: "outbound-api" }))).toBeUndefined();
    expect(optInChangeOf(message({ direction: "outbound-reply" }))).toBeUndefined();
    const { from: _from, ...noSender } = message();
    expect(optInChangeOf(noSender)).toBeUndefined();
    const { dateSent: _sent, ...noTime } = message();
    expect(optInChangeOf(noTime)).toBeUndefined();
  });
});

describe("readTwilioReplies", () => {
  it("reads the replies to the number of the texts from the time of the first opt-in, with the largest page", async () => {
    const fake = server(page([text(2, SECOND, "START", SINCE + 3 * MINUTE), text(1, FIRST, "Stop", SINCE + MINUTE)]));
    expect(await readTwilioReplies(optionsOf(fake))).toEqual({
      ok: true,
      changes: [
        { number: FIRST, kind: "stop", at: SINCE + MINUTE },
        { number: SECOND, kind: "start", at: SINCE + 3 * MINUTE },
      ],
    });
    const search = Object.fromEntries(new URL(fake.urls[0] ?? "").searchParams);
    expect(search).toEqual({ To: TEXT_FROM, "DateSent>": "2026-11-17T21:30:00Z", PageSize: "1000" });
  });

  it("reads each page, and gives the changes of all the pages with the oldest first", async () => {
    const fake = server(page([text(3, FIRST, "START", SINCE + 9 * MINUTE)], NEXT), page([text(2, SECOND, "help", SINCE + 5 * MINUTE), text(1, FIRST, "STOP", SINCE + 2 * MINUTE)]));
    const read = await readTwilioReplies(optionsOf(fake));
    expect(read).toEqual({
      ok: true,
      changes: [
        { number: FIRST, kind: "stop", at: SINCE + 2 * MINUTE },
        { number: FIRST, kind: "start", at: SINCE + 9 * MINUTE },
      ],
    });
    expect(fake.urls[1]).toBe(`https://api.twilio.com${NEXT}`);
  });

  it("leaves out the texts that are not keywords, the outbound texts and a text before the time of the first opt-in", async () => {
    const fake = server(
      page([
        text(4, FIRST, "Thanks", SINCE + 4 * MINUTE),
        text(3, FIRST, "STOP", SINCE + 3 * MINUTE, { direction: "outbound-api", from: TEXT_FROM, to: FIRST }),
        text(2, SECOND, "STOP", SINCE + 2 * MINUTE, { date_sent: null }),
        text(1, SECOND, "STOP", SINCE - 1000),
      ]),
    );
    expect(await readTwilioReplies(optionsOf(fake))).toEqual({ ok: true, changes: [] });
  });

  it("gives an empty list for an account with no replies", async () => {
    expect(await readTwilioReplies(optionsOf(server(page([]))))).toEqual({ ok: true, changes: [] });
  });

  it("gives a failure, and no part of the list, when a page fails", async () => {
    const fake = server(page([text(2, FIRST, "STOP", SINCE + MINUTE)], NEXT), { status: 500, body: { code: 20500, message: "Internal Server Error" } });
    const read = await readTwilioReplies(optionsOf(fake));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.message).toMatch(/^Twilio did not give page 2 of the replies \(server\)/u);
  });

  it("gives a failure for a refused key, a broken answer and a fetch that throws", async () => {
    const refused = await readTwilioReplies(optionsOf(server({ status: 401, body: { code: 20003, message: "Authenticate" } })));
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.message).toContain("(auth)");
    expect(await readTwilioReplies(optionsOf(server({ status: 200, body: { page: 0 } }))).then((read) => read.ok)).toBe(false);
    expect(await readTwilioReplies(optionsOf(server(new Error("connect ECONNREFUSED")))).then((read) => read.ok)).toBe(false);
  });

  it("puts a mark in place of the number of the texts in a failure", async () => {
    const answer = { status: 400, body: { code: 21211, message: `The 'To' number ${TEXT_FROM} is not valid. Also ${TEXT_FROM.slice(1)}.` } };
    const read = await readTwilioReplies(optionsOf(server(answer)));
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.message).toContain("[number]");
      expect(read.message).not.toContain(TEXT_FROM.slice(1));
    }
  });

  it("gives a failure, and no part of the list, past the page limit", async () => {
    expect(TWILIO_REPLIES_PAGE_LIMIT).toBe(20);
    const fake = server(page([], NEXT), page([], NEXT), page([], NEXT));
    const read = await readTwilioReplies(optionsOf(fake, { pageLimit: 2 }));
    expect(read).toEqual({ ok: false, message: "The replies have more than 2 pages. The read gives no part of the list." });
    expect(fake.urls).toHaveLength(2);
  });

  it("gives a failure for a next page that is not in the Twilio API, and sends no request to it", async () => {
    const fake = server(page([], "https://example.invalid/2010-04-01/Accounts/x/Messages.json"));
    const read = await readTwilioReplies(optionsOf(fake));
    expect(read).toMatchObject({ ok: false });
    expect(fake.urls).toHaveLength(1);
  });

  it("gives a failure for a number of the texts that is not in E.164 form, and sends no request", async () => {
    const fake = server();
    expect(await readTwilioReplies(optionsOf(fake, { to: "5550100" }))).toEqual({ ok: false, message: "The read of the replies has no valid request: The recipient is not a phone number in E.164 form." });
    expect(fake.urls).toHaveLength(0);
  });

  it("stops at the abort of the signal, and throws the reason of the abort", async () => {
    const fetch: TwilioFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const stop = new AbortController();
    const reading = readTwilioReplies({ credentials: CREDENTIALS, fetch, to: TEXT_FROM, since: SINCE }, stop.signal);
    stop.abort();
    await expect(reading).rejects.toThrow(/abort/iu);
  });
});
