/**
 * The audience of a report or an incident (AL-92). A report with no `addresses` is public: the CAP scope `Public`.
 * A report with `addresses` is private: the CAP scope `Private`. It reaches only the persons of its addresses.
 *
 * The merge puts reports in one incident only when their audiences are the same. Thus the text of a private report
 * does not reach a person outside its addresses through an incident, and a public report does not lose its persons.
 */
import { compareCodeUnits } from "@mark1russell7/text/order";
import type { PersonId } from "./contracts.ts";

/** The part of a report or an incident that gives its audience. */
export interface Audience {
  /** The persons of a private item. A public item has no such field. */
  readonly addresses?: readonly PersonId[] | undefined;
}

/** This function tells if a report or an incident is private. */
export function isPrivate(item: Audience): boolean {
  return item.addresses !== undefined;
}

/** This function gives the addresses of a private item in one order, with no repeat. */
export function audienceOf(addresses: readonly PersonId[]): readonly PersonId[] {
  return [...new Set(addresses)].sort(compareCodeUnits);
}

/** This function gives the key of the audience of an item: `public`, or the addresses of a private item in one order. */
export function audienceKey(item: Audience): string {
  return item.addresses === undefined ? "public" : JSON.stringify(audienceOf(item.addresses));
}

/** This function tells if a person is in the audience of an item. A public item has each person. */
export function inAudience(item: Audience, person: PersonId): boolean {
  return item.addresses === undefined || item.addresses.includes(person);
}
