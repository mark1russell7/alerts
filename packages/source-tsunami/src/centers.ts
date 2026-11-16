/**
 * The two tsunami warning centers of the NWS, and the file of the latest CAP message of each center. Each center has a
 * source of its own, so each center has its own health. One fetch of the two centers can hide a failure of one center.
 */

import type { SourceId } from "@mark1russell7/alerts";

/** One tsunami warning center of the NWS. */
export interface TsunamiCenter {
  /** The id of the source of the center. */
  readonly id: SourceId;
  /** The short name of the center, for example `NTWC`. */
  readonly name: string;
  /** The full name of the center. */
  readonly title: string;
  /** The path of the file of the latest CAP message of the center on `www.tsunami.gov`. */
  readonly path: string;
  /** The countries and territories of the coasts that the center warns, as ISO 3166 codes. */
  readonly coverage: readonly string[];
}

/**
 * The two centers. The National Tsunami Warning Center (NTWC) warns the coasts of the US mainland, Alaska and Canada.
 * The Pacific Tsunami Warning Center (PTWC) warns Hawaii, the US territories of the Pacific, Puerto Rico and the US
 * Virgin Islands.
 */
export const TSUNAMI_CENTERS: { readonly ntwc: TsunamiCenter; readonly ptwc: TsunamiCenter } = {
  ntwc: {
    id: "tsunami-ntwc" as SourceId,
    name: "NTWC",
    title: "National Tsunami Warning Center (NTWC)",
    path: "/events/xml/PAAQCAP.xml",
    coverage: ["US", "CA"],
  },
  ptwc: {
    id: "tsunami-ptwc" as SourceId,
    name: "PTWC",
    title: "Pacific Tsunami Warning Center (PTWC)",
    path: "/events/xml/PHEBCAP.xml",
    coverage: ["US", "GU", "MP", "AS", "PR", "VI"],
  },
};

/** The name of a center in `TSUNAMI_CENTERS`. */
export type CenterName = keyof typeof TSUNAMI_CENTERS;
