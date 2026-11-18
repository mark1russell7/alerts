import type { CanaryResult, FetchRecord, Observation, ObservationId, SourceId, SourceProcedures } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { fetchEvents } from "./fetch.ts";

const SOURCE = "stream" as SourceId;
const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);

const observation: Observation = {
  id: "observation-1" as ObservationId,
  source: SOURCE,
  fetched: T0,
  contentType: "text/plain",
  body: "a product",
  transport: { latency: 0 },
};

function recordOf(check: SourceProcedures["check"]): FetchRecord {
  const events = fetchEvents({
    source: SOURCE,
    procedures: { map: () => ({ reports: [], problems: [] }), ...(check === undefined ? {} : { check }) },
    started: T0,
    ended: T0 + 100,
    outcome: { ok: true, observations: [observation], complete: true },
    known: () => false,
  });
  const fetch = events.at(-1);
  if (fetch?.type !== "fetch") throw new Error("The last event is not the fetch event.");
  return fetch.record;
}

describe("the canary of a fetch", () => {
  it("keeps the result of a check that decides", () => {
    const pass: CanaryResult = { pass: true, reason: "the keepalive is fresh" };
    const fail: CanaryResult = { pass: false, reason: "the keepalive is old" };
    expect(recordOf(() => pass).canary).toEqual(pass);
    expect(recordOf(() => fail).canary).toEqual(fail);
  });

  it("gives no canary for a source with no check, and for a check with no read", () => {
    // A check that gives `undefined` cannot decide yet: the health then gets no canary event.
    expect(recordOf(undefined)).not.toHaveProperty("canary");
    expect(recordOf(() => undefined)).not.toHaveProperty("canary");
  });

  it("tells a check that throws as a failed canary", () => {
    const record = recordOf(() => {
      throw new Error("no clock");
    });
    expect(record.canary).toEqual({ pass: false, reason: "The canary check threw: no clock" });
  });
});
