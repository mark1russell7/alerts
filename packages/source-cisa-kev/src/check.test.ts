import { readFileSync } from "node:fs";
import type { Observation, ObservationId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { checkCanary, RELEASE_MAX_AGE_MS } from "./check.ts";
import { listedAt, readCatalog } from "./fetch.ts";
import { SOURCE_ID } from "./map.ts";

/** The real catalog, with 10 of its entries (`fixtures/README.md`). */
const FIXTURE = readFileSync(new URL("../fixtures/kev-20261117.json", import.meta.url), "utf8");
const FETCHED = Date.parse("2026-11-18T04:02:53Z");
const observationsAt = (fetched: number): Observation[] =>
  listedAt(readCatalog(FIXTURE, FETCHED)!, fetched).map((body, index) => ({ id: `o-${index}` as ObservationId, source: SOURCE_ID, fetched, contentType: "application/json", body, transport: { latency: 0 } }));

describe("checkCanary", () => {
  it("passes when the catalog was released at most 21 days before the fetch", () => {
    expect(RELEASE_MAX_AGE_MS).toBe(21 * 86_400_000);
    expect(checkCanary(observationsAt(FETCHED))).toEqual({ pass: true, reason: "the catalog was released at 2026-11-17T17:53:15.566Z, 0.4 days before the fetch" });
    expect(checkCanary(observationsAt(Date.parse("2026-12-08T17:53:15.566Z"))).pass).toBe(true);
  });

  it("fails when the release is older than 21 days, or when the fetch has no head", () => {
    const late = checkCanary(observationsAt(Date.parse("2026-12-08T17:53:16Z")));
    expect(late.pass).toBe(false);
    expect(late.reason).toMatch(/: the limit is 21 days$/);
    expect(checkCanary([])).toEqual({ pass: false, reason: "the fetch has no head of the catalog with a release time" });
  });
});
