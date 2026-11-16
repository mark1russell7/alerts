/**
 * The bundles of the three outage Functions. esbuild makes one CommonJS file for each Function, with
 * each module that it imports. The Functions runtime of Twilio gives only the Node built-ins and the
 * helper library of Twilio, so a bundle imports nothing else.
 *
 * The module `index.ts` does not export this module. Thus the runtime of the instance loads esbuild
 * only for a deploy.
 */

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { OUTAGE_PATHS } from "./outage.ts";

/**
 * The Node runtime of the Functions on the server of Twilio. Node 24 is the Active LTS runtime of
 * Twilio Functions, and Node 22 is in maintenance.
 */
export const FUNCTION_RUNTIME = "node24";

/**
 * The npm packages of the build, each with an exact version. Twilio refuses a range for the runtime
 * handler. On Node 24 the platform keeps the handler at 2.1.2 or later.
 */
export const FUNCTION_DEPENDENCIES: Readonly<Record<string, string>> = { "@twilio/runtime-handler": "2.1.2" };

/** The bundle of one Function. */
export interface FunctionBundle {
  /** The path of the Function on the domain of the service. */
  readonly path: (typeof OUTAGE_PATHS)[keyof typeof OUTAGE_PATHS];
  /** The entry is public, and it checks its own token. Twilio signs each request to a protected Function. */
  readonly visibility: "public" | "protected";
  /** The CommonJS code of the bundle. */
  readonly code: string;
}

// The source file of each Function, by its path.
const SOURCES = [
  { path: OUTAGE_PATHS.entry, visibility: "public", file: "./functions/outage.ts" },
  { path: OUTAGE_PATHS.press, visibility: "protected", file: "./functions/press.ts" },
  { path: OUTAGE_PATHS.ended, visibility: "protected", file: "./functions/ended.ts" },
] as const;

/** This function makes the bundle of each Function. The same sources and the same esbuild give the same code. */
export async function bundleFunctions(): Promise<FunctionBundle[]> {
  return Promise.all(
    SOURCES.map(async (source) => {
      const result = await build({
        entryPoints: [fileURLToPath(new URL(source.file, import.meta.url))],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: FUNCTION_RUNTIME,
        write: false,
        sourcemap: false,
        legalComments: "none",
        charset: "utf8",
        logLevel: "silent",
      });
      const [file] = result.outputFiles;
      if (file === undefined || result.outputFiles.length !== 1) throw new Error(`The bundle of ${source.path} is not one file.`);
      return { path: source.path, visibility: source.visibility, code: file.text };
    }),
  );
}
