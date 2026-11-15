/**
 * This module holds the loader of the private configuration. The runtime reads the JSON text from a
 * source and parses it with `parseConfig` of the core. A problem stops the start, because a runtime
 * with a wrong place watches the wrong place in silence. No problem holds a value of the configuration,
 * a value of a secret or a path.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConfig, type ChannelDescriptor, type ParsedConfig, type SecretLookup } from "@mark1russell7/alerts";
import { resolvePath } from "@mark1russell7/files";
import { err, ok, tryCatchAsync, type Result } from "@mark1russell7/optional";
import { parseEnvFile } from "@mark1russell7/service/host";
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

/**
 * This variable of the environment gives the private folder of an instance. The folder holds each
 * private file: the configuration, the file of keys and the event log. One variable for all the files
 * keeps a test start with a temporary folder away from the real configuration.
 */
export const HOME_VARIABLE = "ALERTS_HOME";

/** This path is the private folder when the variable `ALERTS_HOME` is not set. */
export const DEFAULT_ALERTS_HOME = "~/.alerts";

/** This name is the name of the configuration file in the private folder. */
export const CONFIG_FILE = "config.json";

/** This name is the name of the file of keys in the private folder. */
export const SECRETS_FILE = "secrets.env";

/**
 * This function gives the private folder from the environment. The path can start with `~`. A relative
 * path is relative to `base`. An empty variable counts as no variable.
 */
export function alertsHome(env: Readonly<Record<string, string | undefined>>, base: string, home: string = homedir()): string {
  const text = env[HOME_VARIABLE];
  return resolvePath(text === undefined || text === "" ? DEFAULT_ALERTS_HOME : text, base, home);
}

/** This function gives the path of the configuration file: `config.json` in the private folder. */
export function configPath(env: Readonly<Record<string, string | undefined>>, base: string, home: string = homedir()): string {
  return join(alertsHome(env, base, home), CONFIG_FILE);
}

/** This function gives a source that reads the file at `path` as UTF-8 text. */
export function fileSource(path: string): ConfigSource {
  return { name: "The configuration file", read: () => readFile(path, "utf8") };
}

/**
 * This function gives a secret store that reads a record of keys. An empty value counts as no value.
 * The entry reads the file of keys with `parseEnvFile` of `@mark1russell7/service/host`. Do not put the
 * keys into `process.env`, because each child process gets that environment.
 */
export function envSecrets(env: Readonly<Record<string, string | undefined>>): SecretLookup {
  return (name) => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };
}

/**
 * This function reads the file of keys `secrets.env` in the private folder. A problem gives the line
 * and the key of a bad line, or the code of a read error. It holds no value and no path.
 */
export async function readSecrets(home: string): Promise<Result<Readonly<Record<string, string>>, readonly string[]>> {
  const text = await tryCatchAsync(
    () => readFile(join(home, SECRETS_FILE), "utf8"),
    (thrown): readonly string[] => [`The file ${SECRETS_FILE} cannot be read (${codeOf(thrown)}).`],
  );
  if (text.tag === "err") return err(text.error);
  const parsed = parseEnvFile(text.value);
  return parsed.problems.length > 0 ? err(parsed.problems.map((problem) => `The file ${SECRETS_FILE}: ${problem}`)) : ok(parsed.env);
}

/**
 * This function checks a configuration with the keys of the private folder, as the start of the runtime
 * does. A writer of the configuration uses it before its new file replaces `config.json`, because a
 * bad `config.json` stops the next start. The check of the instance comes after the check of the format.
 */
export async function checkConfig(source: ConfigSource, home: string, check: InstanceCheck): Promise<Result<ParsedConfig, readonly string[]>> {
  const secrets = await readSecrets(home);
  if (secrets.tag === "err") return err(secrets.error);
  const secret = envSecrets(secrets.value);
  const parsed = await readConfig(source, check.channels, secret);
  if (parsed.tag === "err") return parsed;
  const problems = check.problems(parsed.value, secret);
  return problems.length > 0 ? err(problems) : parsed;
}

/**
 * The check of an instance after the check of the format. The module `instance.ts` gives the check of
 * the live instance. Thus the check of a file finds each problem that stops the start.
 */
export interface InstanceCheck {
  /** The channels of the instance. The loader checks each recipient against them. */
  readonly channels: readonly ChannelDescriptor[];
  /** This function gives the problems of a parsed configuration that stop the start of the instance. */
  problems(parsed: ParsedConfig, secret: SecretLookup): readonly string[];
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
