import { describe, expect, it } from "vitest";
import type { PersonId, ReportId, SourceId } from "./contracts.ts";
import { ID_SCHEME, messageKey, observationId, reportId } from "./ids.ts";

const source = "nws-api" as SourceId;
const hex = /^[0-9a-f]{64}$/;

// node:crypto calculated these values, apart from WebCrypto. A change of the id scheme changes them.
const GOLDEN = {
  observation: "f9688516bbc34b989ebea52300ec715d48a472b6865bfd7b1ad2f838541d554b",
  report: "578e21f72458d9724b0ddc9590d8d3a9543aa83ce22fbd28abc1947c119db53c",
  message: "da5ef4709e7f660d91513ce54b933c2c4c1e17e620235d603b07354f0a1fb716",
};

const observation = {
  source,
  contentType: "application/geo+json",
  url: "https://api.weather.gov/alerts/active?area=KS",
  body: '{"features":[]}',
};
const report = { source, key: "urn:oid:2.49.0.1.840.0.example", sent: 1763157600000 };
const message = { incident: "a".repeat(64) as ReportId, level: "life-safety", person: "person-1" as PersonId, step: 0 } as const;

describe("the id scheme", () => {
  it("has a version", () => {
    expect(ID_SCHEME).toBe("alerts-id/1");
  });

  it("gives the golden values", async () => {
    expect(await observationId(observation)).toBe(GOLDEN.observation);
    expect(await reportId(report)).toBe(GOLDEN.report);
    expect(await messageKey(message)).toBe(GOLDEN.message);
  });

  it("gives 64 lowercase hex digits", async () => {
    expect(await observationId(observation)).toMatch(hex);
    expect(await reportId(report)).toMatch(hex);
    expect(await messageKey(message)).toMatch(hex);
  });
});

describe("observationId", () => {
  it("gives the same id to the same content at a different fetch", async () => {
    expect(await observationId({ ...observation })).toBe(await observationId(observation));
  });

  it("changes with each part of the content", async () => {
    const base = await observationId(observation);
    const others = await Promise.all([
      observationId({ ...observation, source: "nws-cap" as SourceId }),
      observationId({ ...observation, contentType: "application/json" }),
      observationId({ ...observation, url: "https://api.weather.gov/alerts/active?area=NE" }),
      observationId({ ...observation, body: '{"features":[{}]}' }),
      observationId({ source, contentType: observation.contentType, body: observation.body }),
    ]);
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});

describe("reportId", () => {
  it("changes with the source, the key and the sent time", async () => {
    const ids = await Promise.all([
      reportId(report),
      reportId({ ...report, source: "nws-cap" as SourceId }),
      reportId({ ...report, key: `${report.key}.2` }),
      reportId({ ...report, sent: report.sent + 1 }),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not mix fields that a separator character can join", async () => {
    const a = await reportId({ source: "a|b" as SourceId, key: "c", sent: 0 });
    const b = await reportId({ source: "a" as SourceId, key: "b|c", sent: 0 });
    expect(a).not.toBe(b);
  });

  it("does not throw for a time that is not finite, because map is total", async () => {
    await expect(reportId({ ...report, sent: Number.NaN })).resolves.toMatch(hex);
  });
});

describe("messageKey", () => {
  it("gives a new key to each step and to each level", async () => {
    const keys = await Promise.all([
      messageKey(message),
      messageKey({ ...message, step: 1 }),
      messageKey({ ...message, level: "urgent" }),
      messageKey({ ...message, person: "person-2" as PersonId }),
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the kinds of id apart", async () => {
    const asReport = await reportId({ source: message.incident as unknown as SourceId, key: message.level, sent: 0 });
    expect(asReport).not.toBe(await messageKey({ ...message, person: "0" as PersonId }));
  });
});
