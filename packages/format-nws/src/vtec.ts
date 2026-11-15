/**
 * The Valid Time Event Code of the NWS (P-VTEC, NWS Directive 10-1703). Each warning, watch and
 * advisory of the NWS has one, and each later message about the same event repeats it.
 *
 * The form is `/k.aaa.cccc.pp.s.####.yymmddThhnnZ-yymmddThhnnZ/`: the class, the action, the office,
 * the phenomenon, the significance, the event number, the start and the end.
 */

import type { CorrelationKey, Instant } from "@mark1russell7/alerts";

/** The class of a VTEC string: `O` operational, `T` test, `E` experimental, `X` experimental VTEC. */
export type VtecClass = "O" | "T" | "E" | "X";

/** One VTEC string, in parts. */
export interface Vtec {
  readonly productClass: VtecClass;
  /** The action, for example `NEW`, `CON`, `EXT`, `UPG`, `CAN` or `EXP`. */
  readonly action: string;
  /** The office with four letters, for example `KTOP`. */
  readonly office: string;
  /** The phenomenon with two letters, for example `TO` (tornado). */
  readonly phenomenon: string;
  /** The significance with one letter: `W` warning, `A` watch, `Y` advisory, `S` statement and others. */
  readonly significance: string;
  /** The event number of the office, the phenomenon and the significance in one year. */
  readonly eventNumber: number;
  /** The start of the event. Absent: the event started before the message. */
  readonly start?: Instant;
  /** The end of the event. Absent: the end is not known. */
  readonly end?: Instant;
}

const VTEC = /^\/([OTEX])\.([A-Z]{3})\.([A-Z0-9]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.(\d{6}T\d{4}Z)-(\d{6}T\d{4}Z)\/$/;
const TIME = /^(\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/;

/** The VTEC time of an absent start or end. */
export const NO_TIME = "000000T0000Z";

/** The actions that close an event. A message with only these actions ends its events. */
export const CLOSING_ACTIONS: ReadonlySet<string> = new Set(["CAN", "EXP", "UPG"]);

/**
 * This function reads a VTEC time. The value `000000T0000Z` and a time that is not a real date give
 * `undefined`. A month of 13 is not a real date, but `Date.UTC` moves it into the next year. Thus the
 * function compares each field of the result with the text.
 */
export function vtecTime(text: string): Instant | undefined {
  const match = TIME.exec(text);
  if (match === null || text === NO_TIME) return undefined;
  const [, yy, mo, dd, hh, mi] = match.map(Number) as [number, number, number, number, number, number];
  const time = Date.UTC(2000 + yy, mo - 1, dd, hh, mi);
  const date = new Date(time);
  const real = date.getUTCMonth() === mo - 1 && date.getUTCDate() === dd && date.getUTCHours() === hh && date.getUTCMinutes() === mi;
  return real ? time : undefined;
}

/**
 * This function reads one VTEC string. A text that is not a P-VTEC string gives `undefined`. A
 * time that is not `000000T0000Z` and is not a real date also gives `undefined`.
 */
export function parseVtec(text: string): Vtec | undefined {
  const match = VTEC.exec(text.trim());
  if (match === null) return undefined;
  const [, productClass, action, office, phenomenon, significance, number, startText, endText] = match as unknown as [
    string,
    VtecClass,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const start = vtecTime(startText);
  const end = vtecTime(endText);
  if ((start === undefined && startText !== NO_TIME) || (end === undefined && endText !== NO_TIME)) return undefined;
  return {
    productClass,
    action,
    office,
    phenomenon,
    significance,
    eventNumber: Number(number),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
}

/** This function writes a VTEC time to the minute. An absent time gives `000000T0000Z`. */
export function formatVtecTime(time: Instant | undefined): string {
  if (time === undefined) return NO_TIME;
  const date = new Date(time);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}T${two(date.getUTCHours())}${two(date.getUTCMinutes())}Z`;
}

/**
 * This function writes one VTEC string. For each value that `parseVtec` gives, `parseVtec` of the
 * text gives the value again. The times have minutes and years from 2000 to 2099 only.
 */
export function formatVtec(vtec: Vtec): string {
  const number = String(vtec.eventNumber).padStart(4, "0");
  const parts = [vtec.productClass, vtec.action, vtec.office, vtec.phenomenon, vtec.significance, number];
  return `/${parts.join(".")}.${formatVtecTime(vtec.start)}-${formatVtecTime(vtec.end)}/`;
}

/**
 * This function gives the correlation key of a VTEC event: the office, the phenomenon, the
 * significance, the event number and the year. The event numbers start again each year.
 *
 * The year comes from the start of the event. For an event that already started, the VTEC has no
 * start, so the year comes from the sent time. Near the new year, two messages of one event can
 * thus get two keys. Then the CAP references of the messages still link them.
 */
export function vtecKey(vtec: Vtec, sent: Instant): CorrelationKey {
  const year = new Date(vtec.start ?? sent).getUTCFullYear();
  const number = String(vtec.eventNumber).padStart(4, "0");
  return { system: "vtec", id: `${vtec.office}.${vtec.phenomenon}.${vtec.significance}.${number}.${String(year)}` };
}

/**
 * This function chooses the main VTEC of a message: the first operational VTEC with an action that
 * does not close its event. With no such VTEC, it gives the first operational VTEC.
 */
export function mainVtec(all: readonly Vtec[]): Vtec | undefined {
  const operational = all.filter((vtec) => vtec.productClass === "O");
  return operational.find((vtec) => !CLOSING_ACTIONS.has(vtec.action)) ?? operational[0];
}
