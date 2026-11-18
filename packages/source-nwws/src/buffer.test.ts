import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createProductBuffer } from "./buffer.ts";
import type { NwwsProduct } from "./product.ts";

function product(serial: number): NwwsProduct {
  return { id: `nwws_processor.${String(serial)}`, processor: "nwws_processor", serial, issue: 0, ttaaii: "XOUS55", cccc: "KWBC", awipsid: "CAPWBC", text: "" };
}

describe("createProductBuffer", () => {
  it("gives the entries after a position, oldest first", () => {
    const buffer = createProductBuffer(10);
    expect(buffer.read()).toEqual({ entries: [], position: { seq: 0, losses: 0 }, lost: false });
    expect([1, 2, 3].map((serial) => buffer.add(product(serial), serial * 1000))).toEqual([true, true, true]);
    const all = buffer.read();
    expect(all.entries.map((entry) => [entry.seq, entry.product.serial, entry.received])).toEqual([
      [1, 1, 1000],
      [2, 2, 2000],
      [3, 3, 3000],
    ]);
    expect(all.position).toEqual({ seq: 3, losses: 0 });
    expect(buffer.read({ seq: 2, losses: 0 }).entries.map((entry) => entry.seq)).toEqual([3]);
    expect(buffer.read({ seq: 3, losses: 0 })).toEqual({ entries: [], position: { seq: 3, losses: 0 }, lost: false });
  });

  it("adds a product once: a repeat of the history adds nothing", () => {
    const buffer = createProductBuffer(10);
    expect(buffer.add(product(1), 0)).toBe(true);
    expect(buffer.add(product(1), 5)).toBe(false);
    expect(buffer.size).toBe(1);
  });

  it("tells a loss of the stream to each read from a position before it, one time", () => {
    const buffer = createProductBuffer(10);
    buffer.add(product(1), 0);
    const before = buffer.read().position;
    buffer.markLoss();
    // The loss tells at once, also with no entry after it.
    const first = buffer.read(before);
    expect(first).toEqual({ entries: [], position: { seq: 1, losses: 1 }, lost: true });
    buffer.add(product(5), 0);
    expect(buffer.read(first.position).lost).toBe(false);
    expect(buffer.read(before).lost).toBe(true);
    expect(buffer.read().lost).toBe(true);
  });

  it("removes the oldest entry at the capacity, and tells the loss to a read from before it", () => {
    const buffer = createProductBuffer(2);
    for (const serial of [1, 2, 3]) buffer.add(product(serial), 0);
    expect(buffer.size).toBe(2);
    expect(buffer.read({ seq: 0, losses: 0 })).toMatchObject({ lost: true, position: { seq: 3, losses: 0 } });
    expect(buffer.read({ seq: 1, losses: 0 }).lost).toBe(false);
    // The ring forgets the id of a removed entry, so the same product adds again.
    expect(buffer.add(product(1), 0)).toBe(true);
  });

  it("refuses a capacity that is not a positive integer", () => {
    expect(() => createProductBuffer(0)).toThrow("The capacity of the buffer is 0: it must be a positive integer.");
    expect(() => createProductBuffer(1.5)).toThrow("The capacity of the buffer is 1.5: it must be a positive integer.");
  });

  it("gives each entry to a reader exactly once, and tells a loss exactly when the ring removed an entry before the read", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.array(fc.constantFrom("read" as const, "add" as const, "repeat" as const), { maxLength: 60 }), (capacity, steps) => {
        const buffer = createProductBuffer(capacity);
        let position = buffer.read().position;
        const seen: number[] = [];
        const added: number[] = [];
        let next = 1;
        for (const step of steps) {
          if (step === "read") {
            const read = buffer.read(position);
            const expected = added.filter((serial) => !seen.includes(serial));
            expect(read.entries.length).toBe(Math.min(expected.length, capacity));
            const removed = expected.length > read.entries.length;
            expect(read.lost).toBe(removed);
            expect(read.entries.map((entry) => entry.product.serial)).toEqual(expected.slice(expected.length - read.entries.length));
            seen.push(...expected);
            position = read.position;
          } else if (step === "add") {
            expect(buffer.add(product(next), 0)).toBe(true);
            added.push(next);
            next += 1;
          } else if (next > 1) {
            // The newest product is always in the ring, so a repeat of it adds nothing.
            expect(buffer.add(product(next - 1), 0)).toBe(false);
          }
        }
      }),
    );
  });
});
