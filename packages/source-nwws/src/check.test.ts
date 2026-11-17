import { readFileSync } from "node:fs";
import type { Observation } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { createProductBuffer } from "./buffer.ts";
import { checkCanary, keepaliveSent } from "./check.ts";
import { observationOf } from "./fetch.ts";
import { readProduct } from "./product.ts";
import type { RoomProduct } from "./session.ts";

const PRODUCTS: readonly (RoomProduct & { readonly received: number })[] = JSON.parse(readFileSync(new URL("../fixtures/products-20261116T2002Z.json", import.meta.url), "utf8"));
const SENT = Date.parse("2026-11-16T20:04:55-00:00");
const MINUTE = 60_000;

function observations(): Observation[] {
  const buffer = createProductBuffer(10);
  for (const entry of PRODUCTS) {
    const read = readProduct(entry.attributes, entry.text);
    if (read.ok) buffer.add(read.product, entry.received);
  }
  return buffer.read().entries.flatMap((entry) => observationOf(entry, "xmpp:room") ?? []);
}

describe("keepaliveSent", () => {
  it("reads the sent time of the real keepalive, and nothing from an alert or a bad body", () => {
    const [keepalive, ...alerts] = observations();
    expect(keepaliveSent(keepalive!)).toBe(SENT);
    expect(alerts.map(keepaliveSent)).toEqual([undefined, undefined, undefined]);
    expect(keepaliveSent({ ...keepalive!, body: "not xml" })).toBeUndefined();
  });
});

describe("checkCanary", () => {
  it("passes with the real keepalive at its receipt, and fails 15 minutes after its sent time", () => {
    const all = observations();
    expect(checkCanary(all)).toEqual({ pass: true, reason: "the newest keepalive message of the NWS is 0.2 minutes old" });
    const keepalive = all[0]!;
    expect(checkCanary([{ ...keepalive, fetched: SENT + 15 * MINUTE }]).pass).toBe(true);
    expect(checkCanary([{ ...keepalive, fetched: SENT + 15 * MINUTE + 1 }])).toEqual({
      pass: false,
      reason: "the newest keepalive message of the NWS is 15.0 minutes old: the limit is 15 minutes",
    });
  });

  it("fails with no keepalive, and reads the newest keepalive by its sent time", () => {
    const all = observations();
    expect(checkCanary(all.slice(1))).toEqual({ pass: false, reason: "the fetch has no keepalive message of the NWS" });
    expect(checkCanary([])).toMatchObject({ pass: false });
    const keepalive = all[0]!;
    const older = { ...keepalive, body: keepalive.body.replace("<sent>2026-11-16T20:04:55-00:00</sent>", () => "<sent>2026-11-16T19:54:55-00:00</sent>"), fetched: SENT + 20 * MINUTE };
    expect(keepaliveSent(older)).toBe(SENT - 10 * MINUTE);
    expect(checkCanary([older, { ...keepalive, fetched: SENT + 10 * MINUTE }]).pass).toBe(true);
    expect(checkCanary([{ ...keepalive, fetched: SENT + 20 * MINUTE }, older]).pass).toBe(false);
  });
});
