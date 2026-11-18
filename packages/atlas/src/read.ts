/**
 * The reader of the committed atlas. The data is in seven files of the folder `data`: `classes.json`,
 * `sources.json`, `rounds.json`, `origins.json`, `paths.json`, `regions.json` and `families.json`. A data change is
 * a change of these files, not of the code.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";

import type { Atlas, Family, Origin, PathPart, Region, Round, SignalClass, Source } from "./atlas.ts";

/** The folder of the committed data of the atlas. */
export const DATA_FOLDER: URL = new URL("../data/", import.meta.url);

/** The folder `packages` of the repository. */
export const PACKAGES_FOLDER: URL = new URL("../../", import.meta.url);

/** This function gives the name of each package in the folder `packages`. The gate compares each adapter with them. */
export function workspacePackages(folder: URL = PACKAGES_FOLDER): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const manifest = new URL(`${entry.name}/package.json`, folder);
    if (entry.isDirectory() && existsSync(manifest)) names.add((JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name);
  }
  return names;
}

/** This function reads the atlas from the seven files of a folder. */
export function readAtlas(folder: URL = DATA_FOLDER): Atlas {
  const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, folder), "utf8"));
  return {
    classes: read("classes.json") as SignalClass[],
    sources: read("sources.json") as Source[],
    rounds: read("rounds.json") as Round[],
    origins: read("origins.json") as Origin[],
    paths: read("paths.json") as PathPart[],
    regions: read("regions.json") as Region[],
    families: read("families.json") as Family[],
  };
}
