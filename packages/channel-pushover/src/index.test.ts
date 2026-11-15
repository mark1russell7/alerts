import type { Level, Message, PersonId, ReportId } from "@mark1russell7/alerts";
import type { PushoverFetch } from "@procedures/notify/pushover";
import { describe, expect, it } from "vitest";
import { createPushoverChannel, cut, isQuotaRefusal, priorityOf, pushoverDescriptor, pushoverMessageOf } from "./index.ts";

// Fake keys: 30 letters and digits, as Pushover keys are. No real key is in this repository.
const TOKEN = "t".repeat(30);
const USER = "u".repeat(30);
const RECEIPT = "r".repeat(30);
const AT = Date.UTC(2026, 10, 15, 3, 0);
const ADDRESS = { user: USER };

const message = (level: Level, extra: Partial<Message> = {}): Message => ({
  key: "k".repeat(64),
  person: "person-1" as PersonId,
  level,
  title: "Tornado warning",
  body: "Take shelter now.",
  incident: "report-1" as ReportId,
  quiet: false,
  ...extra,
});

/** A fake Pushover server: it records each call and gives the next answer. */
const server = (...answers: Array<{ status: number; body: unknown } | Error>) => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetch: PushoverFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("The fake server has no more answers.");
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => JSON.stringify(answer.body), headers: { get: () => null } };
  };
  return { fetch, calls };
};

const fields = (body: string | undefined): Record<string, string> => Object.fromEntries(new URLSearchParams(body ?? ""));

/** The fields of `QuotaError` of `polite-crawler/api` that the channel reads. */
class QuotaError extends Error {
  override readonly name: string = "QuotaError";
  readonly key: string;
  readonly resetAt: number;
  constructor(message: string, resetAt: number, key = "pushover-messages") {
    super(message);
    this.key = key;
    this.resetAt = resetAt;
  }
}

describe("priorityOf", () => {
  it("gives the emergency priority to life-safety, and -1 to a quiet message and to the digest", () => {
    expect(priorityOf("life-safety", false)).toBe(2);
    expect(priorityOf("life-safety", true)).toBe(2);
    expect(priorityOf("urgent", false)).toBe(1);
    expect(priorityOf("urgent", true)).toBe(-1);
    expect(priorityOf("notice", false)).toBe(0);
    expect(priorityOf("notice", true)).toBe(-1);
    expect(priorityOf("digest", false)).toBe(-1);
  });
});

describe("cut", () => {
  it("cuts by code points and ends a cut text with an ellipsis", () => {
    expect(cut("short", 10)).toBe("short");
    expect(cut("abcdef", 4)).toBe("abc…");
    expect(cut("🌪🌪🌪", 2)).toBe("🌪…");
    expect([...cut("🌪".repeat(300), 250)].length).toBe(250);
  });
});

describe("pushoverMessageOf", () => {
  it("makes a life-safety message an emergency that repeats, with the delivery key as its tag", () => {
    const mapped = pushoverMessageOf(message("life-safety", { expires: AT + 3_600_000 }), ADDRESS, AT, { sounds: { "life-safety": "siren" } });
    expect(mapped).toEqual({
      user: USER,
      message: "Take shelter now.",
      title: "Tornado warning",
      priority: 2,
      sound: "siren",
      emergency: { retryMs: 30_000, expireMs: 3_600_000, tags: ["k".repeat(64)] },
    });
  });

  it("stops the repeats at 3 hours, and not before one retry", () => {
    expect(pushoverMessageOf(message("life-safety"), ADDRESS, AT, { expireMs: 99_000_000 })).toMatchObject({ emergency: { expireMs: 10_800_000 } });
    expect(pushoverMessageOf(message("life-safety", { expires: AT + 5_000 }), ADDRESS, AT, { retryMs: 10_000 })).toMatchObject({
      emergency: { retryMs: 30_000, expireMs: 30_000 },
    });
  });

  it("sends a quiet message at -1, with a time to live from its expiry", () => {
    expect(pushoverMessageOf(message("urgent", { quiet: true, expires: AT + 60_000 }), { user: USER, device: "phone" }, AT)).toEqual({
      user: USER,
      message: "Take shelter now.",
      title: "Tornado warning",
      priority: -1,
      devices: ["phone"],
      ttlMs: 60_000,
    });
  });

  it("cuts a long title and body, sends no long URL, and uses the title for an empty body", () => {
    const long = pushoverMessageOf(message("notice", { title: "t".repeat(300), body: "b".repeat(2000), url: `https://example.com/${"x".repeat(600)}` }), ADDRESS, AT);
    expect(long).toMatchObject({ priority: 0 });
    expect(long).not.toHaveProperty("url");
    if ("refused" in long) throw new Error("refused");
    expect([...(long.title ?? "")].length).toBe(250);
    expect([...long.message].length).toBe(1024);
    expect(pushoverMessageOf(message("notice", { body: "  ", url: "https://example.com/a" }), ADDRESS, AT)).toMatchObject({ message: "Tornado warning", url: "https://example.com/a" });
  });

  it("refuses an address with no user key and a message that expired", () => {
    expect(pushoverMessageOf(message("notice"), {}, AT)).toEqual({ refused: "The address has no user key." });
    expect(pushoverMessageOf(message("notice", { expires: AT }), ADDRESS, AT)).toEqual({ refused: "The message expired before the send." });
  });
});

describe("the descriptor", () => {
  it("names the push service of the platform, and the resources of the cell", () => {
    expect(pushoverDescriptor("ios").dependsOn).toEqual(["provider:pushover", "provider:apns"]);
    expect(pushoverDescriptor("android").dependsOn).toEqual(["provider:pushover", "provider:fcm"]);
    expect(pushoverDescriptor()).toMatchObject({ id: "pushover", uses: ["internet", "power"], breaksThrough: true, repeats: true, ack: "poll", maxTitle: 250, maxBody: 1024 });
    const fake = server();
    expect(createPushoverChannel({ token: TOKEN, fetch: fake.fetch, platform: "ios" }).describe().dependsOn).toContain("provider:apns");
  });
});

describe("send", () => {
  it("sends a life-safety message at priority 2 and keeps its receipt", async () => {
    const fake = server({ status: 200, body: { status: 1, request: "req-1", receipt: RECEIPT } });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT });
    expect(await channel.send({ message: message("life-safety"), address: ADDRESS })).toEqual({ ok: true, receipt: { request: "req-1", receipt: RECEIPT }, accepted: AT });
    expect(fake.calls[0]?.url).toBe("https://api.pushover.net/1/messages.json");
    expect(fields(fake.calls[0]?.body)).toMatchObject({ token: TOKEN, user: USER, priority: "2", retry: "30", expire: "10800", tags: "k".repeat(64) });
  });

  it("sends a quiet notice at -1, and a message below priority 2 has no receipt", async () => {
    const fake = server({ status: 200, body: { status: 1, request: "req-2" } });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT });
    expect(await channel.send({ message: message("notice", { quiet: true }), address: ADDRESS })).toEqual({ ok: true, receipt: { request: "req-2" }, accepted: AT });
    expect(fields(fake.calls[0]?.body)["priority"]).toBe("-1");
  });

  it("gives a refusal of the quota as rate-limited, with the wait to the reset, and Pushover gets no call", async () => {
    const fake = server(new QuotaError("The quota Pushover messages is used until 2026-12-01.", AT + 60_000));
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toEqual({
      ok: false,
      kind: "rate-limited",
      message: "The quota Pushover messages is used until 2026-12-01.",
      retryAfter: 60_000,
    });
  });

  it("gives the failures of Pushover and of the network", async () => {
    const fake = server({ status: 429, body: { status: 0, errors: ["limit"] } }, new TypeError("fetch failed"), { status: 400, body: { status: 0, user: "invalid", errors: ["user identifier is invalid"] } });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: false, kind: "rate-limited" });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: false, kind: "network", retryAfter: 5_000 });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: false, kind: "refused", message: "user identifier is invalid" });
  });

  it("refuses a bad token, a bad sound and a bad address before a call", async () => {
    const fake = server();
    expect(await createPushoverChannel({ token: "short", fetch: fake.fetch }).send({ message: message("notice"), address: ADDRESS })).toMatchObject({ ok: false, kind: "auth" });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, sounds: { notice: "not a sound!" } });
    expect(await channel.send({ message: message("notice"), address: ADDRESS })).toMatchObject({ ok: false, kind: "refused", message: '"not a sound!" is not the name of a sound.' });
    expect(await channel.send({ message: message("urgent"), address: { user: "nope" } })).toMatchObject({ ok: false, kind: "refused" });
    expect(await channel.send({ message: message("urgent"), address: {} })).toEqual({ ok: false, kind: "refused", message: "The address has no user key." });
    expect(fake.calls).toEqual([]);
  });
});

describe("status", () => {
  const receipt = (extra: Record<string, unknown>) => ({ status: 200, body: { status: 1, request: "req", expires_at: 1_800_000_000, expired: 0, acknowledged: 0, called_back: 0, ...extra } });

  it("gives acknowledged only for an acknowledgment, not for a repeat", async () => {
    const fake = server(receipt({ last_delivered_at: 1_700_000_100 }), receipt({ acknowledged: 1, acknowledged_at: 1_700_000_200, acknowledged_by_device: "phone" }), receipt({ expired: 1 }));
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT });
    expect(await channel.status({ receipt: { request: "req", receipt: RECEIPT } })).toEqual({ state: "accepted", at: AT });
    expect(await channel.status({ receipt: { request: "req", receipt: RECEIPT } })).toEqual({ state: "acknowledged", at: 1_700_000_200_000, by: "phone" });
    expect(await channel.status({ receipt: { request: "req", receipt: RECEIPT } })).toMatchObject({ state: "expired", at: 1_800_000_000_000 });
    expect(fake.calls[0]?.url).toContain(`/receipts/${RECEIPT}.json`);
  });

  it("keeps accepted for a message with no receipt, a bad receipt and a read that failed", async () => {
    const fake = server(new TypeError("fetch failed"));
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT });
    expect(await channel.status({ receipt: { request: "req" } })).toMatchObject({ state: "accepted", at: AT });
    expect(await channel.status({ receipt: { receipt: "bad" } })).toMatchObject({ state: "accepted", reason: "The receipt is not 30 letters and digits." });
    expect(await channel.status({ receipt: { receipt: RECEIPT } })).toMatchObject({ state: "accepted", reason: "The receipt was not read: The request did not reach Pushover." });
  });
});

describe("cancel", () => {
  it("stops the repeats of a receipt, does nothing without one, and throws when Pushover does not stop them", async () => {
    const fake = server({ status: 200, body: { status: 1, request: "req" } }, { status: 500, body: {} });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch });
    await channel.cancel({ receipt: { request: "req" } });
    expect(fake.calls).toEqual([]);
    await channel.cancel({ receipt: { receipt: RECEIPT } });
    expect(fake.calls[0]?.url).toContain(`/receipts/${RECEIPT}/cancel.json`);
    await expect(channel.cancel({ receipt: { receipt: RECEIPT } })).rejects.toThrow(/Pushover did not stop the repeats \(server\)/);
  });

  it("is idempotent: a cancel of a receipt that Pushover does not know returns after one call", async () => {
    const fake = server(
      { status: 400, body: { status: 0, receipt: "not found", errors: ["receipt not found; may be invalid or expired"] } },
      { status: 200, body: { status: 0, errors: ["the receipt is not active"] } },
    );
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch });
    await expect(channel.cancel({ receipt: { receipt: RECEIPT } })).resolves.toBeUndefined();
    await expect(channel.cancel({ receipt: { receipt: RECEIPT } })).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(2);
  });

  it("throws when the token, the network or the time limit stops the cancel", async () => {
    const fake = server({ status: 401, body: { status: 0, token: "invalid", errors: ["application token is invalid"] } }, new TypeError("fetch failed"));
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch });
    await expect(channel.cancel({ receipt: { receipt: RECEIPT } })).rejects.toThrow(/\(auth\)/);
    await expect(channel.cancel({ receipt: { receipt: RECEIPT } })).rejects.toThrow(/\(network\)/);
  });
});

describe("isQuotaRefusal", () => {
  it("reads the name, the key and the reset of the error", () => {
    expect(isQuotaRefusal(new QuotaError("used", 1))).toBe(true);
    expect(isQuotaRefusal(new Error("other"))).toBe(false);
    expect(isQuotaRefusal({ name: "QuotaError", key: "k", resetAt: 1 })).toBe(false);
    expect(isQuotaRefusal(new QuotaError("used", Number.NaN))).toBe(false);
    expect(isQuotaRefusal(Object.assign(new QuotaError("used", 1), { key: 7 }))).toBe(false);
  });
});
