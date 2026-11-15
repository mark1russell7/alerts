/**
 * The facts of the NWS as an authority of the alert system: the origin of its messages, and the
 * office ids of its VTEC strings.
 */

/**
 * The origin of each NWS message, in each source. The NWS API, IPAWS, IEM and the weather radio give
 * copies of the NWS messages. The core counts the copies of one origin as one voice of the event.
 */
export const NWS_ORIGIN = "nws";

/** The VTEC offices that do not have the form `K` and three letters, by their ids of three letters. */
const OWN_OFFICES: Readonly<Record<string, string>> = {
  // Anchorage, Fairbanks and Juneau
  AFC: "PAFC",
  AFG: "PAFG",
  AJK: "PAJK",
  // Honolulu and Guam
  HFO: "PHFO",
  GUM: "PGUM",
  // San Juan
  SJU: "TJSJ",
};

/**
 * This function gives the VTEC office of an office id with three letters, for example `KTOP` for `TOP`.
 * An office of the contiguous states adds `K`. The offices of Alaska, Hawaii, Guam and Puerto Rico have
 * their own VTEC ids. A text that is not three capital letters gives `undefined`.
 */
export function vtecOffice(id: string): string | undefined {
  if (!/^[A-Z]{3}$/.test(id)) return undefined;
  return OWN_OFFICES[id] ?? `K${id}`;
}
