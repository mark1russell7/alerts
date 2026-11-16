/**
 * The buffer of the products of the stream. The supervisor adds each product that the source keeps, and each fetch
 * reads the products after its position. A product that the buffer has is not added again, so a repeat of the history
 * of the room adds nothing. The buffer is pure state with no clock and no I/O.
 */

import type { Instant } from "@mark1russell7/alerts";
import type { NwwsProduct } from "./product.ts";

/** One product in the buffer. */
export interface BufferEntry {
  /** The sequence number of the entry in this buffer. The first entry has the number 1. */
  readonly seq: number;
  /** The time at which the session got the product. */
  readonly received: Instant;
  readonly product: NwwsProduct;
}

/** A position in the buffer: the sequence number of the last entry that a reader has, and the count of the losses then. */
export interface BufferPosition {
  readonly seq: number;
  readonly losses: number;
}

/** The result of a read of the buffer. */
export interface BufferRead {
  /** The entries after the position of the read, oldest first. */
  readonly entries: readonly BufferEntry[];
  /** The position of the newest entry of the buffer. The sequence number is 0 for an empty buffer. */
  readonly position: BufferPosition;
  /** True: the stream lost one or more products after the position of the read, or the buffer removed some. */
  readonly lost: boolean;
}

/** The buffer of the products of the stream. */
export interface ProductBuffer {
  /** This method adds a product. It gives `false` for a product whose id the buffer has, and adds nothing. */
  add(product: NwwsProduct, received: Instant): boolean;
  /** This method records that the stream lost one or more products. */
  markLoss(): void;
  /** This method gives the entries after the position `after`. Without `after`, it gives each entry and each loss. */
  read(after?: BufferPosition): BufferRead;
  /** The number of entries in the buffer. */
  readonly size: number;
}

/**
 * This function makes an empty buffer. When the buffer has `capacity` entries, a new entry removes the oldest one. A
 * read from a position before the oldest entry then tells the loss.
 */
export function createProductBuffer(capacity: number): ProductBuffer {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`The capacity of the buffer is ${String(capacity)}: it must be a positive integer.`);
  const ring: BufferEntry[] = [];
  const ids = new Set<string>();
  let next = 1;
  let losses = 0;
  return {
    add(product, received) {
      if (ids.has(product.id)) return false;
      ring.push({ seq: next, received, product });
      next += 1;
      ids.add(product.id);
      if (ring.length > capacity) ids.delete(ring.shift()!.product.id);
      return true;
    },
    markLoss() {
      losses += 1;
    },
    read(after) {
      const from = after?.seq ?? 0;
      const entries = ring.filter((entry) => entry.seq > from);
      // The entries after `from` start at `from + 1`. An oldest entry after that number tells that the ring removed some.
      const removed = ring.length > 0 && ring[0]!.seq > from + 1;
      return { entries, position: { seq: next - 1, losses }, lost: removed || losses > (after?.losses ?? 0) };
    },
    get size() {
      return ring.length;
    },
  };
}
