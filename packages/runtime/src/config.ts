/**
 * This module holds the loader of the private configuration. The runtime reads the JSON text from a
 * source and parses it with `parseConfig` of the core. A problem stops the start, because a runtime
 * with a wrong place watches the wrong place in silence. No problem holds a value of the configuration,
 * a value of a secret or a path.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseConfig, type ChannelDescriptor, type ParsedConfig, type SecretLookup } from "@mark1russell7/alerts";
import { resolvePath } from "@mark1russell7/files";
import { err, tryCatchAsync, type Result } from "@mark1russell7/optional";
import { countOf } from "@mark1russell7/text";

/**
 * A source gives the JSON text of the configuration. Today the source is a private file. A procedure
 * that gives the configuration replaces the file later, with the same interface.
 */
export interface ConfigSource {
  /** This text names the source at the start of a problem, for example "The configuration file". It holds no path. */
  readonly name: string;
  /** This function gives the JSON text of the configuration. */
  read(): Promise<string>;
}

/** This variable of the environment gives the path of the configuration file. */
export const CONFIG_PATH_VARIABLE = "ALERTS_CONFIG";

/** This path is the path of the configuration file when the variable `ALERTS_CONFIG` is not set. */
export const DEFAULT_CONFIG_PATH = "~/.alerts/config.json";

/**
 * This function gives the path of the configuration file from the environment. The path can start
 * with `~`. A relative path is relative to `base`. An empty variable counts as no variable.
 */
export function configPath(env: Readonly<Record<string, string | undefined>>, base: string, home: string = homedir()): string {
  const text = env[CONFIG_PATH_VARIABLE];
  return resolvePath(text === undefined || text === "" ? DEFAULT_CONFIG_PATH : text, base, home);
}

/** This function gives a source that reads the file at `path` as UTF-8 text. */
export function fileSource(path: string): ConfigSource {
  return { name: "The configuration file", read: () => readFile(path, "utf8") };
}

/**
 * This function gives a secret store that reads the environment. An empty value counts as no value.
 * To put a private file of keys into the environment, start Node.js with `--env-file=<file>`.
 */
export function envSecrets(env: Readonly<Record<string, string | undefined>>): SecretLookup {
  return (name) => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };
}

/**
 * This function reads and parses the configuration. When the source fails, the problem gives only the
 * code of the error. The message of a file error holds the path, and the path can hold a user name.
 */
export async function readConfig(source: ConfigSource, channels: readonly ChannelDescriptor[], secret: SecretLookup): Promise<Result<ParsedConfig, readonly string[]>> {
  const text = await tryCatchAsync(
    () => source.read(),
    (thrown): readonly string[] => [`${source.name} cannot be read (${codeOf(thrown)}).`],
  );
  if (text.tag === "err") return err(text.error);
  return parseConfig(text.value, channels, secret);
}

/** This error stops the start of the runtime. Its message lists each problem of the configuration. */
export class ConfigRefused extends Error {
  /** These are the problems of the configuration. They hold no private value. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The runtime does not start. The configuration has ${countOf(problems.length, "problem")}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "ConfigRefused";
    this.problems = problems;
  }
}

/**
 * This function gives the parsed configuration, or it throws `ConfigRefused`. The entry of the process
 * uses it before the start of the service.
 */
export async function requireConfig(source: ConfigSource, channels: readonly ChannelDescriptor[], secret: SecretLookup): Promise<ParsedConfig> {
  const parsed = await readConfig(source, channels, secret);
  if (parsed.tag === "err") throw new ConfigRefused(parsed.error);
  return parsed.value;
}

/** The code of a thrown value, for example `ENOENT`, or `no code` when the value has no text code. */
function codeOf(thrown: unknown): string {
  const code = typeof thrown === "object" && thrown !== null && "code" in thrown ? thrown.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "no code";
}
