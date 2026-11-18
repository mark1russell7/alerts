/**
 * This module holds the check of the private files: the configuration and the keys. The check parses
 * the configuration with `parseConfig` of the core. A runtime does not start with a bad configuration,
 * because a runtime with a wrong place watches the wrong place in silence. The module `reload.ts` gives
 * the start its last good set of the private files. No problem holds a value of the configuration, a value of a secret or a path.
 *
 * The folder `parts` of the private folder holds the parts of the configuration: one file `<name>.json` for each writer.
 * The check merges them into `config.json` with `parseConfig` of the core.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConfig, partLabel, type ChannelDescriptor, type ContactServices, type ParsedConfig, type PartText, type SecretLookup } from "@mark1russell7/alerts";
import { resolvePath } from "@mark1russell7/files";
import { err, ok, tryCatchAsync, type Result } from "@mark1russell7/optional";
import { parseEnvFile } from "@mark1russell7/service/host";
import { countOf } from "@mark1russell7/text";
import { compareCodeUnits } from "@mark1russell7/text/order";

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

/** This name is the name of the folder of the parts of the configuration in the private folder. */
export const PARTS_FOLDER = "parts";

/** The end of the name of each file of a part. The folder `parts` ignores each other file, for example a new file before its check. */
export const PART_FILE_END = ".json";

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

/** The text of one file of the folder `parts`, with the name of its part: the name of the file with no `.json`. */
export interface PartFileText {
  readonly name: string;
  readonly file: FileText;
}

/** The texts of the files of the folder `parts` in the order of the names. A read error of the folder gives its code. */
export type PartsTexts = { readonly files: readonly PartFileText[] } | { readonly code: string };

/** The texts of a folder `parts` with no files. A missing folder gives this value. */
export const NO_PARTS: PartsTexts = { files: [] };

/** This function gives true if the texts of the parts are the texts of a folder with no files. */
export function noParts(parts: PartsTexts | undefined): boolean {
  return parts === undefined || ("files" in parts && parts.files.length === 0);
}

/** The texts of the private files that the start reads: `config.json`, `secrets.env` and the folder `parts`. */
export interface PrivateTexts {
  readonly config: FileText;
  readonly secrets: FileText;
  /** The texts of the parts of the configuration. When it is absent, the configuration has no parts. */
  readonly parts?: PartsTexts;
}

/**
 * This function reads the folder of the parts: each file whose name ends with `.json`, in the order of the names.
 * A missing folder gives `NO_PARTS`. Another error of the read of the folder gives its code.
 */
export async function readParts(folder: string): Promise<PartsTexts> {
  const names = await tryCatchAsync(() => readdir(folder), codeOf);
  if (names.tag === "err") return names.error === "ENOENT" ? NO_PARTS : { code: names.error };
  const parts = names.value.filter((name) => name.endsWith(PART_FILE_END)).sort(compareCodeUnits);
  const files = await Promise.all(
    parts.map(async (name): Promise<PartFileText> => ({ name: name.slice(0, -PART_FILE_END.length), file: await readText(() => readFile(join(folder, name), "utf8")) })),
  );
  return { files };
}

// The texts of the parts for the parse, or the problems of their reads. A problem gives the code of the error, not a path.
function partTexts(parts: PartsTexts): Result<readonly PartText[], readonly string[]> {
  if ("code" in parts) return err([`The folder ${PARTS_FOLDER} cannot be read (${parts.code}).`]);
  const texts: PartText[] = [];
  const problems: string[] = [];
  parts.files.forEach(({ name, file }, index) => {
    if ("code" in file) problems.push(`${partLabel(name, index)} cannot be read (${file.code}).`);
    else texts.push({ name, text: file.text });
  });
  return problems.length > 0 ? err(problems) : ok(texts);
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
 * This function checks the texts of the private files, as the start of the runtime does. It reads no file.
 * The problems of `secrets.env` come first, then the read errors of the parts. The check of the instance comes
 * after the check of the format. The text `name` names the configuration at the start of a problem.
 */
export function checkTexts(texts: PrivateTexts, check: InstanceCheck, name = "The configuration file"): Result<CheckedConfig, readonly string[]> {
  const keys = parseSecrets(texts.secrets);
  if (keys.tag === "err") return keys;
  if ("code" in texts.config) return err([`${name} cannot be read (${texts.config.code}).`]);
  const parts = partTexts(texts.parts ?? NO_PARTS);
  if (parts.tag === "err") return parts;
  const secret = envSecrets(keys.value);
  const parsed = parseConfig(texts.config.text, check.channels, secret, parts.value, check.services);
  if (parsed.tag === "err") return parsed;
  const problems = check.problems(parsed.value, secret);
  return problems.length > 0 ? err(problems) : ok({ parsed: parsed.value, keys: keys.value });
}

/** A new text of one part for `checkConfig`. The check uses it in place of the file of the part, or as a new part. */
export interface PartSource {
  readonly name: string;
  readonly source: ConfigSource;
}

/** This function puts `part` in place of the file with its name. With no such file, the new part goes in the order of the names. */
export function withPart(parts: PartsTexts, part: PartFileText): PartsTexts {
  if ("code" in parts) return parts;
  return { files: [...parts.files.filter(({ name }) => name !== part.name), part].sort((a, b) => compareCodeUnits(a.name, b.name)) };
}

/**
 * This function checks a configuration with the keys and the parts of the private folder, as the start of the runtime
 * does. A writer of the configuration uses it before its new file replaces `config.json`, because a bad `config.json`
 * stops the next start. It reads the source only when `secrets.env` has no problem.
 *
 * With `part`, the check uses the new text of that part in place of its file. Thus a writer of a part checks its new
 * file before the file replaces the old part.
 */
export async function checkConfig(source: ConfigSource, home: string, check: InstanceCheck, part?: PartSource): Promise<Result<ParsedConfig, readonly string[]>> {
  const secrets = await readText(() => readFile(join(home, SECRETS_FILE), "utf8"));
  const keys = parseSecrets(secrets);
  if (keys.tag === "err") return keys;
  const folder = await readParts(join(home, PARTS_FOLDER));
  const parts = part === undefined ? folder : withPart(folder, { name: part.name, file: await readText(() => part.source.read()) });
  const checked = checkTexts({ config: await readText(() => source.read()), secrets, parts }, check, source.name);
  return checked.tag === "ok" ? ok(checked.value.parsed) : checked;
}

/**
 * The check of an instance after the check of the format. The module `instance.ts` gives the check of
 * the live instance. Thus the check of a file finds each problem that stops the start.
 */
export interface InstanceCheck {
  /** The channels of the instance. The loader checks each recipient against them. */
  readonly channels: readonly ChannelDescriptor[];
  /** The services of the contacts, from the channels (`ContactServices`). The layer `delivery` of each person takes them. */
  readonly services?: ContactServices;
  /** This function gives the problems of a parsed configuration that stop the start of the instance. */
  problems(parsed: ParsedConfig, secret: SecretLookup): readonly string[];
}

/** This function gives the check with one more problem when the file of keys has no value for `key`. The text `reason` ends the problem. */
export function requireKey(check: InstanceCheck, key: string, reason: string): InstanceCheck {
  return {
    ...check,
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

/** This function gives the code of a thrown value, for example `ENOENT`, or `no code` when the value has no text code. */
export function codeOf(thrown: unknown): string {
  const code = typeof thrown === "object" && thrown !== null && "code" in thrown ? thrown.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "no code";
}
