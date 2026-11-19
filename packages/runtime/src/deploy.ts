/**
 * This file deploys new code to the live checkout through two slots (AL-89, `slots.ts`). The install does not change
 * the code under the running runtime. Start this file through the live path, thus with the code of the live slot:
 * `node <live>/packages/runtime/src/deploy.ts <command>`.
 *
 * - `status` gives the kind of the live path, the live slot, and the commit and the stage of each slot.
 * - `adopt` makes the checkout at the live path slot `a`, and the live path a link to it. Start it one time.
 *   On Windows, stop the boot task first, because a folder in use cannot move.
 * - `stage <commit> [--page]` checks out the commit in the other slot and installs its dependencies with the lockfile.
 *   Then it checks the private files and the load of the code, with the new code. `--page` also builds the local page.
 *   The live slot does not change.
 * - `swap` points the live path at the staged slot in one step. The runtime takes the new code at its next start.
 *   `node src/install.ts restart` from the live path starts it at once. A second `swap` goes back to the old slot.
 *
 * A swap back to older code is a rollback. Do it only when the new code wrote no new kind of event to the log.
 * When the files of the supervisor change, the stage and the swap tell it. The supervisor takes them only at a restart
 * of the boot task.
 *
 * The environment gives `ALERTS_HOME`, as for `main.ts`, and `PNPM`, the program of pnpm (`slots.ts`, `pnpmCall`).
 * The exit code is 0 for success, 1 for a refusal or a failed step, and 2 for a wrong command. The output holds no value of a private file.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { constants, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "@procedures/fs/files";
import { runCommand, type CommandResult } from "@procedures/shell/command";
import { errorMessage } from "@mark1russell7/text";
import { alertsHome, readText as readFileText } from "./config.ts";
import { hostFolder } from "./host.ts";
import {
  adoptLive,
  checkoutOf,
  DEPLOY_FILE,
  entryRoot,
  installArgs,
  otherSlot,
  parseDeployFile,
  pnpmCall,
  readLive,
  SERVICE_PACKAGE,
  slotsOf,
  STAGE_CHECKS,
  SUPERVISOR_FILES,
  supervisorChanges,
  swapLink,
  swapRefusal,
  textHash,
  withMark,
  type DeployFile,
  type SlotName,
} from "./slots.ts";

const USAGE = "The command is: node src/deploy.ts status | adopt | stage <commit> [--page] | swap";
const STEP_TIMEOUT_MS = 20 * 60_000;

const root = entryRoot(process.argv[1], join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const slots = slotsOf(checkoutOf(root));
const home = alertsHome(process.env, process.cwd());
const deployPath = join(hostFolder(home), DEPLOY_FILE);

const readText = async (path: string): Promise<string | undefined> => {
  const file = await readFileText(() => readFile(path, "utf8"));
  return "text" in file ? file.text : undefined;
};
const readMarks = async (): Promise<DeployFile> => parseDeployFile(await readText(deployPath));
const writeMarks = (file: DeployFile): Promise<void> => writeFileAtomic(deployPath, `${JSON.stringify(file, null, 2)}\n`);

/** This function runs one program to its end. A failure prints the end of its output and throws. */
async function step(name: string, program: string, args: readonly string[], cwd: string, env: Record<string, string> = {}): Promise<CommandResult> {
  const result = await runCommand(program, { args, cwd, env, timeout: STEP_TIMEOUT_MS });
  if (!result.success) {
    const tail = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-12).join("\n");
    throw new Error(`The step "${name}" failed with the code ${result.exitCode}${result.timedOut === true ? " (time-out)" : ""}.\n${tail}`);
  }
  return result;
}

const git = (cwd: string, ...args: string[]): Promise<CommandResult> => step(`git ${args[0] ?? ""}`, "git", args, cwd);

/** This function gives the commit of a slot, or undefined for a slot with no checkout. */
async function headOf(folder: string): Promise<string | undefined> {
  const result = await runCommand("git", { args: ["rev-parse", "HEAD"], cwd: folder, timeout: 60_000 });
  return result.success ? result.stdout.trim() : undefined;
}

/** This function tells if the tree of a slot has no change. */
async function cleanOf(folder: string): Promise<boolean> {
  const result = await runCommand("git", { args: ["status", "--porcelain"], cwd: folder, timeout: 60_000 });
  return result.success && result.stdout.trim() === "";
}

/** This function reads the parts of the supervisor of one slot: its files and the version of the service package. */
async function supervisorParts(folder: string): Promise<Record<string, string | undefined>> {
  const parts: Record<string, string | undefined> = {};
  for (const file of SUPERVISOR_FILES) parts[file] = textHash(await readText(join(folder, file)));
  const manifest = await readText(join(folder, "packages", "runtime", "node_modules", ...SERVICE_PACKAGE.split("/"), "package.json"));
  let version: string | undefined;
  try {
    version = manifest === undefined ? undefined : (JSON.parse(manifest) as { version?: string }).version;
  } catch {
    version = undefined;
  }
  parts[SERVICE_PACKAGE] = version;
  return parts;
}

/** This function prints the parts of the supervisor that change from the live slot to `slot`. */
async function tellSupervisor(live: SlotName, slot: SlotName): Promise<void> {
  const changes = supervisorChanges(await supervisorParts(slots[live]), await supervisorParts(slots[slot]));
  console.log(
    changes.length === 0
      ? "The supervisor does not change."
      : `The supervisor changes: ${changes.join(", ")}. The supervisor takes the change only at a restart of the boot task.`,
  );
}

/** This function reads the live slot, or throws when the live path is not a link to a slot. */
async function liveSlot(): Promise<SlotName> {
  const live = await readLive(slots);
  if (live.kind !== "link" || live.slot === undefined) throw new Error("The live path is not a link to a slot. Start `deploy.ts adopt` first.");
  return live.slot;
}

async function status(): Promise<void> {
  const live = await readLive(slots);
  console.log(live.kind === "link" ? `The live path is a link to slot ${live.slot ?? "(no slot)"}.` : `The live path is ${live.kind === "folder" ? "a folder: start adopt" : "missing"}.`);
  const marks = await readMarks();
  for (const name of ["a", "b"] as const) {
    const head = await headOf(slots[name]);
    const mark = marks.marks[name];
    const stage = mark === undefined ? "no stage" : `staged ${mark.sha.slice(0, 7)} at ${mark.at}, checks ${mark.checks.join(" ")}${mark.sha === head ? "" : " (not the commit of the slot)"}`;
    console.log(`slot ${name}: ${head === undefined ? "no checkout" : head.slice(0, 7)}, ${stage}`);
  }
}

async function stage(commit: string, page: boolean): Promise<void> {
  const live = await liveSlot();
  // The stage and each program that it starts run at the lowest priority of the processor. Thus they do not take the processor from the live runtime.
  setPriority(constants.priority.PRIORITY_LOW);
  const slot = otherSlot(live);
  const folder = slots[slot];
  const call = pnpmCall(process.env, process.execPath);
  if ("refused" in call) throw new Error(call.refused);
  // The old mark goes first: a stage that stops in its middle leaves no mark, thus no swap.
  await writeMarks(withMark(await readMarks(), slot, undefined));
  if ((await headOf(folder)) === undefined) {
    await git(slots[live], "clone", "--quiet", slots[live], folder);
    const origin = await git(slots[live], "remote", "get-url", "origin");
    await git(folder, "remote", "set-url", "origin", origin.stdout.trim());
  } else if (!(await cleanOf(folder))) {
    throw new Error(`Slot ${slot} has changes. Look at them, and clean the slot first.`);
  }
  await git(folder, "fetch", "--quiet", "origin");
  await git(folder, "checkout", "--quiet", "--detach", commit);
  const sha = (await headOf(folder)) ?? "";
  console.log(`Slot ${slot} has the commit ${sha.slice(0, 7)}.`);
  const env = { CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  await step("install", call.program, [...call.prefix, ...installArgs(page)], folder, env);
  if (page) await step("page", call.program, [...call.prefix, "--filter", "./packages/site", "build"], folder, env);
  const runtime = join(folder, "packages", "runtime");
  const config = await step("config", process.execPath, [join(runtime, "src", "check.ts")], runtime);
  console.log(config.stdout.trim());
  // The load needs no private file. An empty home keeps each write of a module away from the live home.
  const scratch = await mkdtemp(join(tmpdir(), "alerts-load-"));
  try {
    await step("load", process.execPath, [join(runtime, "src", "main.ts"), "load"], runtime, { ALERTS_HOME: scratch });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await writeMarks(withMark(await readMarks(), slot, { sha, at: new Date().toISOString(), checks: [...STAGE_CHECKS] }));
  console.log(`Slot ${slot} is staged at ${sha.slice(0, 7)}: ${STAGE_CHECKS.join(", ")} passed.`);
  await tellSupervisor(live, slot);
  console.log("Start `deploy.ts swap` to put it live.");
}

async function swap(): Promise<void> {
  const live = await readLive(slots);
  const from = live.kind === "link" ? live.slot : undefined;
  const slot = from === undefined ? undefined : otherSlot(from);
  const head = slot === undefined ? undefined : await headOf(slots[slot]);
  const mark = slot === undefined ? undefined : (await readMarks()).marks[slot];
  const clean = slot !== undefined && (await cleanOf(slots[slot]));
  const refusal = swapRefusal({ live, mark, head, clean });
  if (refusal !== undefined) throw new Error(refusal);
  if (from === undefined || slot === undefined) throw new Error("The live path is not a link to a slot.");
  await swapLink(slots.live, slots[slot]);
  console.log(`The live path is a link to slot ${slot} (${(head ?? "").slice(0, 7)}) now. Slot ${from} stays for a rollback.`);
  await tellSupervisor(from, slot);
  console.log("The runtime takes the new code at its next start. `node src/install.ts restart` from the live path starts it now.");
}

const [command, ...rest] = process.argv.slice(2);
let code = 0;
try {
  if (command === "status" && rest.length === 0) await status();
  else if (command === "adopt" && rest.length === 0) {
    await adoptLive(slots);
    console.log("The checkout is slot a now, and the live path is a link to it.");
  } else if (command === "stage" && rest.length >= 1 && rest.length <= 2 && (rest[1] === undefined || rest[1] === "--page") && rest[0] !== "--page") {
    await stage(rest[0] ?? "", rest[1] === "--page");
  } else if (command === "swap" && rest.length === 0) await swap();
  else {
    console.error(USAGE);
    code = 2;
  }
} catch (error) {
  console.error(errorMessage(error));
  code = 1;
}
process.exitCode = code;
