/**
 * This file sends one message from the operator to the person who operates the system, on Pushover (AL-92,
 * `tell-message.ts`). The key of Pushover stays in this process.
 *
 * - `node src/tell.ts --title <title> --message <text> [--url <link>] [--dry-run]` sends the message.
 * - `--dry-run` reads the private files and gives the count of the people who get the message, and sends nothing.
 * - The command reads the private files and checks them as the start of the runtime does.
 * - It sends only to one person. With no person or with more people, it sends nothing.
 * - The quota gate of the runtime does not count this message. The next answer of Pushover gives the gate its count.
 *
 * This path is a stopgap with no throttle and no check for a repeated message. Its end is the intake of events in the runtime (AL-92).
 *
 * The environment gives `ALERTS_HOME`, as for `main.ts`. The output holds no value of a private file, no person and
 * no address. The exit code is 0 for a sent message or a dry run, 1 for a refusal or a failed send, and 2 for a wrong command.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPushoverChannel } from "@mark1russell7/alerts-channel-pushover";
import { countOf, errorMessage } from "@mark1russell7/text";
import { alertsHome, checkTexts, configPath, PARTS_FOLDER, readParts, readText, SECRETS_FILE } from "./config.ts";
import { readCopySettings } from "./copy.ts";
import { daemonCheck, PUSHOVER_TOKEN } from "./instance.ts";
import { linkProblem, tellMessage, tellTargets, type TellInput } from "./tell-message.ts";

const USAGE = "The command is: node src/tell.ts --title <title> --message <text> [--url <link>] [--dry-run]";

/** This function gives the text of the message, or the problem of the command. */
function command(args: readonly string[]): { readonly input: TellInput; readonly dryRun: boolean } | { readonly problem: string } {
  let values: { title?: string; message?: string; url?: string; "dry-run"?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { title: { type: "string" }, message: { type: "string" }, url: { type: "string" }, "dry-run": { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { problem: errorMessage(error) };
  }
  const title = values.title?.trim() ?? "";
  const body = values.message?.trim() ?? "";
  if (title === "" || body === "") return { problem: "The title and the message are necessary." };
  const problem = values.url === undefined ? undefined : linkProblem(values.url);
  if (problem !== undefined) return { problem };
  return { input: { title, body, url: values.url }, dryRun: values["dry-run"] === true };
}

/** This function reads and checks the private files, sends the message, and gives the exit code. */
async function tell(input: TellInput, dryRun: boolean): Promise<number> {
  const home = alertsHome(process.env, process.cwd());
  const copy = await readCopySettings(home);
  if (copy.tag === "err") {
    console.error(`The settings of the copy have ${countOf(copy.error.length, "problem")}. Start \`node src/check.ts\` to see them.`);
    return 1;
  }
  const checked = checkTexts(
    {
      config: await readText(() => readFile(configPath(process.env, process.cwd()), "utf8")),
      secrets: await readText(() => readFile(join(home, SECRETS_FILE), "utf8")),
      parts: await readParts(join(home, PARTS_FOLDER)),
    },
    daemonCheck(copy.value),
  );
  if (checked.tag === "err") {
    console.error(`The private files have ${countOf(checked.error.length, "problem")}. Start \`node src/check.ts\` to see them.`);
    return 1;
  }
  const at = Date.now();
  const targets = tellTargets(checked.value.parsed.recipients, at);
  const quiet = targets.filter((target) => target.quiet).length;
  console.log(`The message goes to ${countOf(targets.length, "person", "people")} on Pushover${quiet > 0 ? `, ${quiet} in the quiet window` : ""}.`);
  const [target] = targets;
  if (targets.length !== 1 || target === undefined) {
    console.error("This command sends only to one person, with no throttle. Thus it sends nothing.");
    return 1;
  }
  if (dryRun) {
    console.log("The dry run sends nothing.");
    return 0;
  }
  const channel = createPushoverChannel({ token: checked.value.keys[PUSHOVER_TOKEN] ?? "", fetch, now: () => Date.now() });
  const outcome = await channel.send({ message: tellMessage(input, target, at), address: target.address });
  if (outcome.ok) {
    console.log("Pushover accepted the message.");
    return 0;
  }
  // The message of a failure can hold the words of Pushover. Only the kind goes to the output.
  console.error(`Pushover did not accept the message: ${outcome.kind}.`);
  return 1;
}

const parsed = command(process.argv.slice(2));
if ("problem" in parsed) {
  console.error(`${parsed.problem}\n${USAGE}`);
  process.exitCode = 2;
} else {
  try {
    process.exitCode = await tell(parsed.input, parsed.dryRun);
  } catch (error) {
    console.error(`The command stopped: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
