/**
 * The committed priors of the shadow score: the file `data/priors.json` of this package. The runtime reads them at
 * its start. A test holds the file equal to the priors of `data/rates.json`.
 */
import { readFileSync } from "node:fs";
import { scorePriorsSchema, type ScorePriors } from "@mark1russell7/alerts";

/** The URL of the file of the committed priors. */
export const PRIORS_URL: URL = new URL("../data/priors.json", import.meta.url);

/** This function reads the committed priors and checks them with the schema of the core. It throws when the file does not pass. */
export function committedPriors(): ScorePriors {
  return scorePriorsSchema.parse(JSON.parse(readFileSync(PRIORS_URL, "utf8")));
}
