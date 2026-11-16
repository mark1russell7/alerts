/**
 * The settings of the copy of this runtime: the file `copy.json` of the private folder. The design is in the section
 * "The copies of the system" of `docs/CONTRACTS.md`.
 *
 * Each copy has its own file. Without the file, the runtime is the only copy, `ONLY_COPY`, with rank 0. A change of
 * the file needs `install.ts restart`, because the reload hook watches only `config.json` and `secrets.env`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ONLY_COPY, parseCopySettings, type CopySettings, type Duration } from "@mark1russell7/alerts";
import { err, ok, type Result } from "@mark1russell7/optional";
import { readText, type FileText } from "./config.ts";

/** The name of the file of the settings of the copy in the private folder. */
export const COPY_FILE = "copy.json";

/** The name of the key of `secrets.env` that holds the token of the exchange. The copies have the same token. */
export const COPY_TOKEN_KEY = "COPY_TOKEN";

/** A copy reads the log of each other copy at this interval. */
export const EXCHANGE_EVERY: Duration = 5_000;

/** The time limit of one read of the log of another copy. */
export const EXCHANGE_LIMIT: Duration = 3_000;

/** The largest difference of the clocks of two copies with no system line. A larger difference makes a line. */
export const CLOCK_SKEW_LIMIT: Duration = 2_000;

/**
 * This function gives the settings of the copy from the text of `copy.json`. A missing file gives `ONLY_COPY`. Each
 * other read error and each problem of the text stop the start. A problem holds no address, no URL and no path.
 */
export function copySettings(file: FileText): Result<CopySettings, readonly string[]> {
  if ("code" in file) return file.code === "ENOENT" ? ok(ONLY_COPY) : err([`The file ${COPY_FILE} cannot be read (${file.code}).`]);
  const parsed = parseCopySettings(file.text);
  return parsed.tag === "ok" ? parsed : err(parsed.error.map((problem) => `The file ${COPY_FILE}: ${problem}`));
}

/** This function reads `copy.json` of the private folder `home`, and gives the settings of the copy as `copySettings` does. */
export async function readCopySettings(home: string): Promise<Result<CopySettings, readonly string[]>> {
  return copySettings(await readText(() => readFile(join(home, COPY_FILE), "utf8")));
}
