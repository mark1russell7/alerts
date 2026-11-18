/**
 * The readers of the fields of a parsed JSON body. The formats of the package share them. The move of `isFields` to one
 * home outside the package is open: many source packages have a copy.
 */

import type { Instant } from "@mark1russell7/alerts";

/** An object of fields of a parsed JSON body. */
export type Fields = Readonly<Record<string, unknown>>;

/** This function tells if a value is an object of fields: an object that is not a list. */
export const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);

/** This function gives the text of a field, or `undefined` for an empty or absent text. */
export function textOf(fields: Fields, field: string): string | undefined {
  const value = fields[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** This function gives the time of a field, or `undefined` for an absent value or a value that is not a time. */
export function timeOf(fields: Fields, field: string): Instant | undefined {
  const value = fields[field];
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}
