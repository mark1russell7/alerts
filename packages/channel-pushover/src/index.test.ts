import { addressProblems, WHY_LIMITS, type Level, type Message, type PersonId, type ReportId } from "@mark1russell7/alerts";
import type { PushoverFetch } from "@procedures/notify/pushover";
import { quotaGate, type QuotaGate } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import { createPushoverChannel, isPushoverKey, priorityOf, PUSHOVER_QUOTA, PUSHOVER_RESERVE_NOTICES, pushoverCost, pushoverDescriptor, pushoverMessageOf } from "./index.ts";

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

/** A fake Pushover server: it records each call and gives the next answer, with its headers. */
const server = (...answers: Array<{ status: number; body: unknown; headers?: Record<string, string> } | Error>) => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetch: PushoverFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("The fake server has no more answers.");
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: async () => JSON.stringify(answer.body), headers: { get: (name: string) => answer.headers?.[name.toLowerCase()] ?? null } };
  };
  return { fetch, calls };
};

const fields = (body: string | undefined): Record<string, string> => Object.fromEntries(new URLSearchParams(body ?? ""));

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

describe("the cut of a long title and body", () => {
  const mapped = (title: string, body: string) => {
    const result = pushoverMessageOf(message("urgent", { title, body }), ADDRESS, AT);
    if ("refused" in result) throw new Error(result.refused);
    return result;
  };

  it("cuts by code points as Pushover counts them, and ends a cut text with an ellipsis", () => {
    expect(mapped("short", "body")).toMatchObject({ title: "short", message: "body" });
    const long = mapped("🌪".repeat(300), "🌪".repeat(1100));
    expect(long.title).toBe(`${"🌪".repeat(249)}…`);
    expect([...long.message]).toHaveLength(1024);
  });

  it("keeps each grapheme whole: a flag of two code points is not split", () => {
    // 124 flags are 248 code points. The next flag does not fit with the ellipsis in 250.
    expect(mapped("🇺🇸".repeat(200), "body").title).toBe(`${"🇺🇸".repeat(124)}…`);
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

  it("puts the why line first in the body, thus the cut of a long body keeps it", () => {
    const why = "Why: Lake cabin is in the area";
    expect(pushoverMessageOf(message("notice", { body: "Take cover.", why }), ADDRESS, AT)).toMatchObject({ message: `${why}\n\nTake cover.` });
    expect(pushoverMessageOf(message("notice", { body: "  ", why }), ADDRESS, AT)).toMatchObject({ title: "Tornado warning", message: why });
    const long = pushoverMessageOf(message("notice", { body: "b".repeat(2000), why }), ADDRESS, AT);
    if ("refused" in long) throw new Error("refused");
    expect(long.message.startsWith(`${why}\n\nbbb`)).toBe(true);
    expect([...long.message].length).toBe(1024);
  });

  it("refuses an address with no user key and a message that expired", () => {
    expect(pushoverMessageOf(message("notice"), {}, AT)).toEqual({ refused: "The address has no user key." });
    expect(pushoverMessageOf(message("notice", { expires: AT }), ADDRESS, AT)).toEqual({ refused: "The message expired before the send.", kind: "expired" });
  });
});

describe("isPushoverKey", () => {
  it("accepts 30 letters and digits, and nothing else", () => {
    expect([TOKEN, USER, "aZ09".repeat(7) + "aZ"].map(isPushoverKey)).toEqual([true, true, true]);
    expect([TOKEN.slice(1), TOKEN + "t", "t".repeat(29) + "-", " " + TOKEN.slice(1), "", undefined, 30].map(isPushoverKey)).toEqual(Array(7).fill(false));
  });
});

describe("the descriptor", () => {
  it("names the push service of the platform, and the resources of the cell", () => {
    expect(pushoverDescriptor("ios").dependsOn).toEqual(["provider:pushover", "provider:apns"]);
    expect(pushoverDescriptor("android").dependsOn).toEqual(["provider:pushover", "provider:fcm"]);
    expect(pushoverDescriptor()).toMatchObject({ id: "pushover", uses: ["internet", "dns", "power"], breaksThrough: true, repeats: true, ack: "poll", maxTitle: 250, maxBody: 1024 });
    // A phone takes many pushes at once, thus each copy sends a life-safety push with no floor.
    expect(pushoverDescriptor().exclusive).toBeUndefined();
    // A push takes the why line of the push limit.
    expect(pushoverDescriptor().why).toEqual(WHY_LIMITS.push);
    const fake = server();
    expect(createPushoverChannel({ token: TOKEN, fetch: fake.fetch, platform: "ios" }).describe().dependsOn).toContain("provider:apns");
  });

  it("checks the user key and the device name of an address, and names no value", () => {
    const descriptor = pushoverDescriptor();
    expect(addressProblems(ADDRESS, descriptor)).toEqual([]);
    expect(addressProblems({ user: USER, device: "iphone-15_pro" }, descriptor)).toEqual([]);
    expect(addressProblems({ user: USER, device: "" }, descriptor)).toEqual([]);
    expect(addressProblems({}, descriptor)).toEqual(["The address on pushover has no field user. The channel needs a key of Pushover: 30 letters and digits."]);
    expect(addressProblems({ user: "bad-user-value" }, descriptor)).toEqual(["The field user of the address on pushover is not a key of Pushover: 30 letters and digits."]);
    expect(addressProblems({ user: USER, device: "my phone" }, descriptor)).toEqual(["The field device of the address on pushover is not a device name of Pushover: up to 25 letters, digits, _ and -."]);
    expect(addressProblems({ user: USER, devise: "phone" }, descriptor)).toEqual(["The address on pushover has the field devise, and the channel reads no such field."]);
    // The form of the user key is the form of each key of Pushover.
    expect(isPushoverKey(USER)).toBe(true);
  });
});

describe("send", () => {
  it("sends a life-safety message at priority 2 and keeps its receipt", async () => {
    const fake = server({ status: 200, body: { status: 1, request: "req-1", receipt: RECEIPT } });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT });
    expect(await channel.send({ message: message("life-safety"), address: ADDRESS })).toEqual({ ok: true, receipt: { request: "req-1", receipt: RECEIPT, tag: "k".repeat(64) }, accepted: AT });
    expect(fake.calls[0]?.url).toBe("https://api.pushover.net/1/messages.json");
    expect(fields(fake.calls[0]?.body)).toMatchObject({ token: TOKEN, user: USER, priority: "2", retry: "30", expire: "10800", tags: "k".repeat(64) });
  });

  it("tags a life-safety message with the delivery key and the copy id, and keeps the delivery key in the receipt", async () => {
    const fake = server({ status: 200, body: { status: 1, request: "req-1", receipt: RECEIPT } });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT });
    const sent = await channel.send({ message: message("life-safety"), address: ADDRESS, copy: "run-1-2" });
    expect(sent).toEqual({ ok: true, receipt: { request: "req-1", receipt: RECEIPT, tag: "k".repeat(64) }, accepted: AT });
    expect(fields(fake.calls[0]?.body)).toMatchObject({ tags: `${"k".repeat(64)},run-1-2` });
  });

  it("sends a quiet notice at -1, and a message below priority 2 has no receipt", async () => {
    const fake = server({ status: 200, body: { status: 1, request: "req-2" } });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT });
    expect(await channel.send({ message: message("notice", { quiet: true }), address: ADDRESS })).toEqual({ ok: true, receipt: { request: "req-2" }, accepted: AT });
    expect(fields(fake.calls[0]?.body)["priority"]).toBe("-1");
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

describe("the quota of the month", () => {
  // Midnight in America/Chicago on 1 December, as Pushover gives the reset: seconds since the epoch.
  const RESET = Date.UTC(2026, 11, 1, 6);
  const limits = (remaining: number) => ({ "x-limit-app-limit": "10000", "x-limit-app-remaining": String(remaining), "x-limit-app-reset": String(RESET / 1000) });
  const gateOf = () => quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", now: () => AT });
  const sent = (request: string, remaining?: number) => ({ status: 200, body: { status: 1, request, receipt: RECEIPT }, ...(remaining === undefined ? {} : { headers: limits(remaining) }) });

  it("costs 1 unit below priority 2 and 0 at priority 2", () => {
    expect([-2, -1, 0, 1, 2].map(pushoverCost)).toEqual([1, 1, 1, 1, 0]);
  });

  it("takes one unit for a message below life-safety and none for life-safety, and the count of Pushover corrects the gate", async () => {
    const local = gateOf();
    const quiet = server(sent("req-1"), sent("req-2"));
    const counting = createPushoverChannel({ token: TOKEN, fetch: quiet.fetch, now: () => AT, quota: local });
    await counting.send({ message: message("urgent"), address: ADDRESS });
    await counting.send({ message: message("life-safety"), address: ADDRESS });
    expect(local.state().used).toBe(1);

    const gate = gateOf();
    const fake = server(sent("req-1", 7_496), sent("req-2", 7_495));
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT, quota: gate });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: true });
    expect(gate.state().used).toBe(2_504);
    expect(await channel.send({ message: message("life-safety"), address: ADDRESS })).toMatchObject({ ok: true });
    expect(gate.state().used).toBe(2_505);
  });

  it("refuses a message below life-safety in the reserve with reserved and the wait to the reset, with no call, and still sends life-safety", async () => {
    const gate = gateOf();
    const fake = server(sent("req-1", 1_000), sent("req-2", 999));
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT, quota: gate });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: true });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toEqual({ ok: false, kind: "reserved", message: expect.stringContaining("Pushover messages"), retryAfter: RESET - AT });
    expect(await channel.send({ message: message("notice"), address: ADDRESS })).toMatchObject({ ok: false, kind: "reserved" });
    expect(fake.calls).toHaveLength(1);
    expect(await channel.send({ message: message("life-safety"), address: ADDRESS })).toMatchObject({ ok: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("sends a life-safety message at 0 left, and gives rate-limited with the reset of Pushover to a message below it", async () => {
    const gate = gateOf();
    gate.note({ remaining: 0, resetAt: RESET });
    const fake = server(sent("req-1"));
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT, quota: gate });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toEqual({ ok: false, kind: "rate-limited", message: expect.stringContaining("Pushover messages"), retryAfter: RESET - AT });
    expect(fake.calls).toEqual([]);
    expect(await channel.send({ message: message("life-safety"), address: ADDRESS })).toMatchObject({ ok: true });
    expect(fake.calls).toHaveLength(1);
  });

  it("notes 0 left from a refusal of Pushover over its limit, thus the next message below life-safety gets no call", async () => {
    const gate = gateOf();
    const fake = server({ status: 429, body: { status: 0, errors: ["application over limit"] }, headers: limits(0) });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT, quota: gate });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: false, kind: "rate-limited" });
    expect(gate.state().blockedUntil).toBe(RESET);
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: false, kind: "rate-limited", retryAfter: RESET - AT });
    expect(fake.calls).toHaveLength(1);
  });

  it("gives back the unit of a message that Pushover refused", async () => {
    const gate = gateOf();
    const fake = server({ status: 400, body: { status: 0, user: "invalid", errors: ["user identifier is invalid"] } });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT, quota: gate });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: false, kind: "refused" });
    expect(gate.state().used).toBe(0);
  });

  const noticesOf = () => quotaGate(PUSHOVER_RESERVE_NOTICES, { key: "pushover:reserve-notices", now: () => AT });

  it("sends the message of the entry into the reserve one time in each window, and stops each other message of the reserve", async () => {
    const gate = gateOf();
    gate.note({ remaining: 1_000 });
    const notices = noticesOf();
    const fake = server(sent("req-1", 999));
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT, quota: gate, reserveNotices: notices });
    const entry = message("notice", { useReserve: true });
    expect(await channel.send({ message: entry, address: ADDRESS })).toMatchObject({ ok: true });
    expect(gate.state().used).toBe(9_001);
    expect(notices.state().used).toBe(1);
    expect(await channel.send({ message: entry, address: ADDRESS })).toMatchObject({ ok: false, kind: "reserved", retryAfter: RESET - AT });
    expect(await channel.send({ message: message("notice"), address: ADDRESS })).toMatchObject({ ok: false, kind: "reserved" });
    expect(fake.calls).toHaveLength(1);
  });

  it("stops the message of the entry with no gate of the notices, and when Pushover refuses each message", async () => {
    const gate = gateOf();
    gate.note({ remaining: 1_000 });
    const fake = server();
    const bare = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT, quota: gate });
    expect(await bare.send({ message: message("notice", { useReserve: true }), address: ADDRESS })).toMatchObject({ ok: false, kind: "reserved" });
    gate.note({ remaining: 0, resetAt: RESET });
    const notices = noticesOf();
    const full = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT, quota: gate, reserveNotices: notices });
    expect(await full.send({ message: message("notice", { useReserve: true }), address: ADDRESS })).toMatchObject({ ok: false, kind: "rate-limited" });
    expect(notices.state().used).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("gives back the notice of a message of the entry that Pushover refused", async () => {
    const gate = gateOf();
    gate.note({ remaining: 1_000 });
    const notices = noticesOf();
    const fake = server({ status: 400, body: { status: 0, user: "invalid", errors: ["user identifier is invalid"] } });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT, quota: gate, reserveNotices: notices });
    expect(await channel.send({ message: message("notice", { useReserve: true }), address: ADDRESS })).toMatchObject({ ok: false, kind: "refused" });
    expect(notices.state().used).toBe(0);
  });

  it("sends with no count when the store of the gate fails, and keeps the outcome when the count fails", async () => {
    const fault = (): never => {
      throw new Error("The disk is full.");
    };
    const broken: QuotaGate = { quota: PUSHOVER_QUOTA, key: "pushover:app", take: fault, note: fault, state: fault };
    const fake = server(sent("req-1", 5_000));
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT, quota: broken });
    expect(await channel.send({ message: message("urgent"), address: ADDRESS })).toMatchObject({ ok: true, receipt: { request: "req-1" } });
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

  it("stops the repeats by the tag of the receipt, thus also a copy whose receipt the log does not have", async () => {
    const fake = server({ status: 200, body: { status: 1, request: "req", canceled: 2 } });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch });
    await channel.cancel({ receipt: { request: "req", receipt: RECEIPT, tag: "k".repeat(64) } });
    expect(fake.calls.map((call) => call.url)).toEqual([`https://api.pushover.net/1/receipts/cancel_by_tag/${"k".repeat(64)}.json`]);
    expect(fields(fake.calls[0]?.body)).toEqual({ token: TOKEN });
  });

  it("stops one copy by its copy id, thus the other copies of the key continue", async () => {
    const fake = server({ status: 200, body: { status: 1, request: "req", canceled: 1 } });
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch });
    // A copy id of the runtime: a UUID, "-" and a count. The path keeps it whole.
    await channel.cancel({ copy: "0b6f3c1e-8f0a-4d1e-9a51-6c2f1d7e9b10-3" });
    expect(fake.calls.map((call) => call.url)).toEqual(["https://api.pushover.net/1/receipts/cancel_by_tag/0b6f3c1e-8f0a-4d1e-9a51-6c2f1d7e9b10-3.json"]);
    expect(fields(fake.calls[0]?.body)).toEqual({ token: TOKEN });
  });

  it("refuses a copy id with a character that the path of a stop cannot have, before a call", async () => {
    const fake = server();
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => AT });
    expect(await channel.send({ message: message("life-safety"), address: ADDRESS, copy: "run.1" })).toEqual({ ok: false, kind: "refused", message: 'The copy id "run.1" has a character that the path of a stop cannot have.' });
    await expect(channel.cancel({ copy: "run/1" })).rejects.toThrow('The copy id "run/1" has a character that the path of a stop cannot have.');
    expect(fake.calls).toEqual([]);
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
