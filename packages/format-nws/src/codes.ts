/**
 * The forms of the two region codes of the US warning system. A UGC code of the NWS has the letters of
 * a state, the letter C (a county) or Z (a zone), and three digits, for example `KSZ001`. A SAME code
 * has six digits, for example `020001`. The first digit is a part of the county, and 0 is all of it.
 */

const UGC = /^[A-Z]{2}[CZ]\d{3}$/;
const SAME = /^\d{6}$/;

/** This function tells if a text has the form of a UGC code, for example `KSZ001`. The letters are capitals. */
export const isUgcCode = (text: string): boolean => UGC.test(text);

/** This function tells if a text has the form of a SAME code, for example `020001`. */
export const isSameCode = (text: string): boolean => SAME.test(text);
