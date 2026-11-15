/**
 * This module keeps the private files of the runtime current: `config.json` and `secrets.env`. The
 * supervisor does the restart, thus the runtime has one start path.
 *
 * - The start uses `config.json` when it passes the check. Then it writes the file as the last good copy, `config.good.json`.
 * - The start uses the last good copy when `config.json` has problems. Thus a bad edit does not stop the alerts.
 * - At each pass, the hook reads the two files again. A change that passes the check stops the runtime,
 *   and the supervisor starts it again with the new files.
 * - A change with problems gives its problems one time. The runtime keeps the files of its start.
 *
 * No problem and no note holds a value of a file, a value of a key or a path.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "@mark1russell7/optional";
import { checkTexts, ConfigRefused, readText, SECRETS_FILE, type CheckedConfig, type FileText, type InstanceCheck, type PrivateTexts } from "./config.ts";

/** This name is the name of the last good copy of the configuration in the private folder. */
export const GOOD_CONFIG_FILE = "config.good.json";

/** The paths of the private files that the start reads and writes. */
export interface PrivateFiles {
  readonly config: string;
  readonly secrets: string;
  /** The last good copy of the configuration. Only the start writes it. */
  readonly good: string;
}

/** This function gives the paths of the private files: the configuration at `config`, and the other files in the private folder. */
export function privateFiles(home: string, config: string): PrivateFiles {
  return { config, secrets: join(home, SECRETS_FILE), good: join(home, GOOD_CONFIG_FILE) };
}

/** This function reads the texts of `config.json` and `secrets.env`. A file that cannot be read gives the code of the error. */
export async function readPrivateTexts(files: PrivateFiles): Promise<PrivateTexts> {
  const [config, secrets] = await Promise.all([readText(() => readFile(files.config, "utf8")), readText(() => readFile(files.secrets, "utf8"))]);
  return { config, secrets };
}

/** The configuration of the start, and the texts that it came from. */
export interface StartedConfig extends CheckedConfig {
  /** The texts of the two files at the start. The hook compares each later read with them. */
  readonly texts: PrivateTexts;
  /** The problems of `config.json` when the start uses the last good copy. The list is empty when the start uses `config.json`. */
  readonly fallback: readonly string[];
  /** The notes of the start that do not stop it, for example a failed write of the last good copy. */
  readonly notes: readonly string[];
}

/**
 * This function gives the configuration of the start, or it throws `ConfigRefused` when `config.json`
 * and the last good copy both have problems. The function `write` writes a whole file, or it throws.
 */
export async function startConfig(files: PrivateFiles, check: InstanceCheck, write: (path: string, text: string) => Promise<void>): Promise<StartedConfig> {
  const texts = await readPrivateTexts(files);
  const checked = checkTexts(texts, check);
  const good = await readText(() => readFile(files.good, "utf8"));
  if (checked.tag === "ok") {
    const text = "text" in texts.config ? texts.config.text : "";
    const notes = "text" in good && good.text === text ? [] : await writeGood(files, text, write);
    return { ...checked.value, texts, fallback: [], notes };
  }
  const fallback = checkGood(good, texts.secrets, check);
  if (fallback.tag === "err") throw new ConfigRefused([...checked.error, ...fallback.error]);
  return { ...fallback.value, texts, fallback: checked.error, notes: [] };
}

// A failed write of the last good copy does not stop the start. The last good copy stays as it was.
async function writeGood(files: PrivateFiles, text: string, write: (path: string, text: string) => Promise<void>): Promise<readonly string[]> {
  const written = await readText(() => write(files.good, text).then(() => ""));
  return "code" in written ? [`The last good copy ${GOOD_CONFIG_FILE} cannot be written (${written.code}). The old copy stays.`] : [];
}

// The check of the last good copy, with the keys of the start.
function checkGood(good: FileText, secrets: FileText, check: InstanceCheck): Result<CheckedConfig, readonly string[]> {
  if ("code" in good) return err([`The last good copy ${GOOD_CONFIG_FILE} cannot be read (${good.code}).`]);
  const checked = checkTexts({ config: good, secrets }, check, `The last good copy ${GOOD_CONFIG_FILE}`);
  return checked.tag === "ok" ? ok(checked.value) : err(checked.error.map((problem) => `The last good copy ${GOOD_CONFIG_FILE}: ${problem}`));
}

/** The state of the reload: the key of the texts of the start, and the key of the last refused texts. */
export interface ReloadState {
  readonly started: string;
  readonly refused?: string;
}

/** The action of one reload step. */
export type ReloadAction = { readonly kind: "none" } | { readonly kind: "restart" } | { readonly kind: "refused"; readonly problems: readonly string[] };

/** This function gives the key of the texts. Two reads have one key only when each text and each error code is the same. */
export function textsKey(texts: PrivateTexts): string {
  return JSON.stringify([texts.config, texts.secrets]);
}

/**
 * This function gives the next state and the action for a read of the texts. It reads no file and no
 * clock. The texts of the start, or the texts of the last refusal, give no action. Other texts get the check.
 * A return to the texts of the start clears the refusal, thus a repeat of a bad change gives its problems again.
 */
export function reloadStep(state: ReloadState, texts: PrivateTexts, check: InstanceCheck): { readonly state: ReloadState; readonly action: ReloadAction } {
  const key = textsKey(texts);
  if (key === state.started) return { state: { started: state.started }, action: { kind: "none" } };
  if (key === state.refused) return { state, action: { kind: "none" } };
  const checked = checkTexts(texts, check);
  if (checked.tag === "ok") return { state, action: { kind: "restart" } };
  return { state: { started: state.started, refused: key }, action: { kind: "refused", problems: checked.error } };
}

/** The options of the hook of the reload. */
export interface ReloadOptions {
  readonly files: PrivateFiles;
  readonly check: InstanceCheck;
  /** The texts of the start. */
  readonly started: PrivateTexts;
  /** This function stops the runtime. The supervisor starts it again with the new files. The hook uses it one time. */
  readonly restart: () => void;
  /** This function gets the problems of refused texts, one time for each change. */
  readonly onRefused: (problems: readonly string[]) => void;
}

/** The hook of the reload. */
export interface ReloadHook {
  /** This function starts a read of the files and ends at once, thus a slow disk does not hold the pass. One read at a time is in flight. */
  readonly onPass: () => void;
  /** This promise ends when no read is in flight. */
  idle(): Promise<void>;
}

/** This function makes the hook of the reload for the option `onPass` of the runtime. The hook throws no error. */
export function reloadHook(options: ReloadOptions): ReloadHook {
  let state: ReloadState = { started: textsKey(options.started) };
  let restarting = false;
  let flight: Promise<void> | undefined;
  const read = async (): Promise<void> => {
    const step = reloadStep(state, await readPrivateTexts(options.files), options.check);
    state = step.state;
    if (step.action.kind === "restart") {
      restarting = true;
      options.restart();
    } else if (step.action.kind === "refused") {
      options.onRefused(step.action.problems);
    }
  };
  return {
    onPass: () => {
      if (restarting || flight !== undefined) return;
      // The message of an error can quote a file. Thus the problem names only the kind of the error.
      flight = read()
        .catch((error: unknown) => options.onRefused([`The check of the private files failed (${error instanceof Error ? error.name : "no name"}).`]))
        .finally(() => {
          flight = undefined;
        });
    },
    idle: async () => {
      await flight;
    },
  };
}
