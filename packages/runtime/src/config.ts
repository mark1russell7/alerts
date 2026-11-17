/**
 * This module holds the check of the private files: the configuration and the keys. The check parses
 * the configuration with `parseConfig` of the core. A runtime does not start with a bad configuration,
 * because a runtime with a wrong place watches the wrong place in silence. The module `reload.ts` gives
 * the start its last good set of the private files. No problem holds a value of the configuration, a value of a secret or a path.
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

/** The text of a file, or the code of the error of its read. The code holds no path. */
export type FileText = { readonly text: string } | { readonly code: string };

/** The texts of the two private files that the start reads: `config.json` and `secrets.env`. */
export interface PrivateTexts {
  readonly config: FileText;
  readonly secrets: FileText;
}

/** This function gives the text of a read, or the code of its error. */
export async function readText(read: () => Promise<string>): Promise<FileText> {
  const text = await tryCatchAsync(read, codeOf);
  return text.tag === "ok" ? { text: text.value } : { code: text.error };
}

/**
 * This function parses the text of the file of keys `secrets.env`. A problem gives the line and the key
 * of a bad line, or the code of a read error. It holds no value and no path.
 */
export function parseSecrets(file: FileText): Result<Readonly<Record<string, string>>, readonly string[]> {
  if ("code" in file) return err([`The file ${SECRETS_FILE} cannot be read (${file.code}).`]);
  const parsed = parseEnvFile(file.text);
  return parsed.problems.length > 0 ? err(parsed.problems.map((problem) => `The file ${SECRETS_FILE}: ${problem}`)) : ok(parsed.env);
}

/** The configuration that passed the check, with the keys of `secrets.env` that it was checked with. */
export interface CheckedConfig {
  readonly parsed: ParsedConfig;
  readonly keys: Readonly<Record<string, string>>;
}

/**
 * This function checks the texts of the two private files, as the start of the runtime does. It reads no
 * file. The problems of `secrets.env` come first, and the check of the instance comes after the check of
 * the format. The text `name` names the configuration at the start of a problem.
 */
export function checkTexts(texts: PrivateTexts, check: InstanceCheck, name = "The configuration file"): Result<CheckedConfig, readonly string[]> {
  const keys = parseSecrets(texts.secrets);
  if (keys.tag === "err") return keys;
  if ("code" in texts.config) return err([`${name} cannot be read (${texts.config.code}).`]);
  const secret = envSecrets(keys.value);
  const parsed = parseConfig(texts.config.text, check.channels, secret);
  if (parsed.tag === "err") return parsed;
  const problems = check.problems(parsed.value, secret);
  return problems.length > 0 ? err(problems) : ok({ parsed: parsed.value, keys: keys.value });
}

/**
 * This function checks a configuration with the keys of the private folder, as the start of the runtime
 * does. A writer of the configuration uses it before its new file replaces `config.json`, because a
 * bad `config.json` stops the next start. It reads the source only when `secrets.env` has no problem.
 */
export async function checkConfig(source: ConfigSource, home: string, check: InstanceCheck): Promise<Result<ParsedConfig, readonly string[]>> {
  const secrets = await readText(() => readFile(join(home, SECRETS_FILE), "utf8"));
  const keys = parseSecrets(secrets);
  if (keys.tag === "err") return keys;
  const checked = checkTexts({ config: await readText(() => source.read()), secrets }, check, source.name);
  return checked.tag === "ok" ? ok(checked.value.parsed) : checked;
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

/** This function gives the check with one more problem when the file of keys has no value for `key`. The text `reason` ends the problem. */
export function requireKey(check: InstanceCheck, key: string, reason: string): InstanceCheck {
  return {
    channels: check.channels,
    problems: (parsed, secret) => [...check.problems(parsed, secret), ...(secret(key) === undefined ? [`The file ${SECRETS_FILE} has no ${key}. ${reason}`] : [])],
  };
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

/** The code of a thrown value, for example `ENOENT`, or `no code` when the value has no text code. */
function codeOf(thrown: unknown): string {
  const code = typeof thrown === "object" && thrown !== null && "code" in thrown ? thrown.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "no code";
}
