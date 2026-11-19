import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import type { PersonId, Recipient, SubjectWatch } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { linkProblem, TELL_SUBJECT, tellMessage, tellTargets, type TellTarget } from "./tell-message.ts";

// Fake keys: 30 letters and digits, as Pushover keys are. No real key is in this repository.
const TOKEN = "t".repeat(30);
const USER = "u".repeat(30);
// 2026-11-19 03:00 UTC is 21:00 in Chicago, in the quiet window 20:00 to 07:00 below.
const NIGHT = Date.UTC(2026, 10, 19, 3, 0);
const DAY = Date.UTC(2026, 10, 19, 18, 0);

const recipient = (person: string, subjects: readonly SubjectWatch[] | undefined, pushover: boolean): Recipient => ({
  watch: { person: person as PersonId, places: [], rules: [], ...(subjects === undefined ? {} : { subjects }), quiet: { zone: "America/Chicago", start: "20:00", end: "07:00" } },
  policies: [],
  addresses: pushover ? { pushover: { user: USER } } : {},
});

type Fetch = Parameters<typeof createPushoverChannel>[0]["fetch"];

/** A fake Pushover server: it records each call and accepts it. */
const server = () => {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, body: init.body });
    return { status: 200, text: async () => JSON.stringify({ status: 1, request: "req-1" }), headers: { get: () => null } };
  };
  return { fetch, calls };
};

describe("the people who get a message of the operator (AL-92)", () => {
  it("gives each person who watches each source and has a contact on Pushover", () => {
    const people = [
      recipient("operator", [{ system: "alerts.source" }, { system: "alerts.channel" }], true),
      recipient("places-only", undefined, true),
      recipient("one-source", [{ system: "alerts.source", id: "nws" }], true),
      recipient("no-pushover", [{ system: "alerts.source" }], false),
    ];
    expect(tellTargets(people, DAY)).toEqual([{ person: "operator", address: { user: USER }, quiet: false }]);
  });

  it("sends in the silent mode in the quiet window of the person", () => {
    expect(tellTargets([recipient("operator", [{ system: "alerts.source" }], true)], NIGHT)).toEqual([expect.objectContaining({ quiet: true })]);
  });

  it("has a subject that only a watch of each source matches", () => {
    expect(TELL_SUBJECT.system).toBe("alerts.source");
  });
});

describe("the message of the operator (AL-92)", () => {
  const target: TellTarget = { person: "operator" as PersonId, address: { user: USER }, quiet: false };

  it("is a notice with the text, the link and an end after one day", () => {
    const message = tellMessage({ title: "A guest can open the graph", body: "The link opens it.", url: "https://example.com/a/graph/" }, target, DAY);
    expect(message).toMatchObject({ level: "notice", title: "A guest can open the graph", body: "The link opens it.", url: "https://example.com/a/graph/", quiet: false, expires: DAY + 86_400_000 });
    expect(message.key).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("gets a new key at each send time, and the same key for the same time", () => {
    const input = { title: "Done", body: "The item is live." };
    expect(tellMessage(input, target, DAY).key).toBe(tellMessage(input, target, DAY).key);
    expect(tellMessage(input, target, DAY + 1).key).not.toBe(tellMessage(input, target, DAY).key);
    expect(tellMessage(input, target, DAY)).not.toHaveProperty("url");
  });

  it("accepts only an absolute link with https or http", () => {
    expect(linkProblem("https://example.com/a/graph/")).toBeUndefined();
    expect(linkProblem("http://127.0.0.1:4731/a/graph/")).toBeUndefined();
    expect(linkProblem("/a/graph/")).toContain("absolute");
    expect(linkProblem("javascript:alert(1)")).toContain("https");
  });

  it("goes through the channel as one call with the token, the user and the priority of a notice", async () => {
    const fake = server();
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => DAY });
    const outcome = await channel.send({ message: tellMessage({ title: "Done", body: "The item is live.", url: "https://example.com/x" }, target, DAY), address: target.address });
    expect(outcome.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const fields = Object.fromEntries(new URLSearchParams(fake.calls[0]?.body ?? ""));
    expect(fields).toMatchObject({ token: TOKEN, user: USER, title: "Done", message: "The item is live.", url: "https://example.com/x" });
    // Pushover takes no priority field as the priority 0.
    expect(fields["priority"] ?? "0").toBe("0");
  });

  it("goes with the priority of the silent mode in the quiet window", async () => {
    const fake = server();
    const channel = createPushoverChannel({ token: TOKEN, fetch: fake.fetch, now: () => NIGHT });
    await channel.send({ message: tellMessage({ title: "Done", body: "Late news." }, { ...target, quiet: true }, NIGHT), address: target.address });
    expect(Object.fromEntries(new URLSearchParams(fake.calls[0]?.body ?? ""))).toMatchObject({ priority: "-1" });
  });
});
