/**
 * The forms of the two region codes of the US warning system. A UGC code of the NWS has the letters of
 * a state, the letter C (a county) or Z (a zone), and three digits, for example `KSZ001`. A SAME code
 * has six digits, for example `020001`. The first digit is a part of the county, and 0 is all of it.
 *
 * A SAME location code (47 CFR 11.31) is `PSSCCC`. `P` is the part of the county. `SS` is the FIPS
 * code of the state, and `CCC` is the FIPS code of the county. `000` is the full state. A UGC code
 * starts with the postal code of its state. Thus a source finds the state of an area from its codes.
 */

const UGC = /^[A-Z]{2}[CZ]\d{3}$/;
const SAME = /^\d{6}$/;

/** This function tells if a text has the form of a UGC code, for example `KSZ001`. The letters are capitals. */
export const isUgcCode = (text: string): boolean => UGC.test(text);

/** This function tells if a text has the form of a SAME code, for example `020001`. */
export const isSameCode = (text: string): boolean => SAME.test(text);

/** The FIPS codes of the states, the District of Columbia and the territories, by their postal codes. */
export const STATE_FIPS: Readonly<Record<string, string>> = {
  AL: "01",
  AK: "02",
  AZ: "04",
  AR: "05",
  CA: "06",
  CO: "08",
  CT: "09",
  DE: "10",
  DC: "11",
  FL: "12",
  GA: "13",
  HI: "15",
  ID: "16",
  IL: "17",
  IN: "18",
  IA: "19",
  KS: "20",
  KY: "21",
  LA: "22",
  ME: "23",
  MD: "24",
  MA: "25",
  MI: "26",
  MN: "27",
  MS: "28",
  MO: "29",
  MT: "30",
  NE: "31",
  NV: "32",
  NH: "33",
  NJ: "34",
  NM: "35",
  NY: "36",
  NC: "37",
  ND: "38",
  OH: "39",
  OK: "40",
  OR: "41",
  PA: "42",
  RI: "44",
  SC: "45",
  SD: "46",
  TN: "47",
  TX: "48",
  UT: "49",
  VT: "50",
  VA: "51",
  WA: "53",
  WV: "54",
  WI: "55",
  WY: "56",
  AS: "60",
  GU: "66",
  MP: "69",
  PR: "72",
  UM: "74",
  VI: "78",
};

/** The postal codes of the states and the territories, by their FIPS codes. */
export const STATE_POSTAL: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(STATE_FIPS).map(([postal, fips]) => [fips, postal]));

/** The parts of one SAME location code. */
export interface SameLocation {
  /** The part of the county: `0` is the full county, `1` to `9` are its parts. */
  readonly part: string;
  /** The FIPS code of the state, two digits. */
  readonly state: string;
  /** The FIPS code of the county, three digits. `000` is the full state. */
  readonly county: string;
}

/** This function reads a SAME location code. It removes the spaces at the ends. A text that is not six digits gives `undefined`. */
export function parseSameLocation(code: string): SameLocation | undefined {
  const text = code.trim();
  if (!isSameCode(text)) return undefined;
  return { part: text.slice(0, 1), state: text.slice(1, 3), county: text.slice(3) };
}

/**
 * This function gives the postal code of the state of a UGC code, in capitals or not. A marine zone
 * (`GMZ`, `ANZ`) has no state, and a text that is not a UGC code gives `undefined`.
 */
export function stateOfUgc(code: string): string | undefined {
  const text = code.trim().toUpperCase();
  if (!isUgcCode(text)) return undefined;
  const prefix = text.slice(0, 2);
  return prefix in STATE_FIPS ? prefix : undefined;
}

/**
 * This function gives the SAME code of a county UGC code, for example `020173` for `KSC173`. The number
 * of a county UGC code is the FIPS code of the county. A zone code, or a code with no state, gives `undefined`.
 */
export function sameOfCountyUgc(code: string): string | undefined {
  const text = code.trim().toUpperCase();
  if (!isUgcCode(text) || text[2] !== "C") return undefined;
  const state = STATE_FIPS[text.slice(0, 2)];
  return state === undefined ? undefined : `0${state}${text.slice(3)}`;
}

/** This function gives the postal code of the state of a SAME location code, or `undefined`. */
export function stateOfSame(code: string): string | undefined {
  const location = parseSameLocation(code);
  return location === undefined ? undefined : STATE_POSTAL[location.state];
}
