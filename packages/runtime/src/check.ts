/**
 * This file checks a configuration file before the file replaces `config.json`. A bad `config.json`
 * stops the next start of the runtime. Thus a writer of the configuration writes a new file in the
 * private folder and starts this check. It renames the file only when the check passes.
 *
 * - `node src/check.ts <file>` checks the file. Without a file, it checks `config.json` in the private folder.
 * - The check uses the keys of `secrets.env` and the check of the live instance, the profile `daemon`.
 * - It finds each problem that stops the start: the form of a key, a missing key and a place that no source covers.
 * - The exit code is 0 for a valid file, 1 for a file with problems and 2 for a wrong command.
 *
 * The environment gives `ALERTS_HOME`, as for `main.ts`. The output holds no value of the file, no
 * value of a key and no path.
 */
import { resolve } from "node:path";
import { countOf } from "@mark1russell7/text";
import { alertsHome, checkConfig, configPath, fileSource } from "./config.ts";
import { DAEMON_CHECK } from "./instance.ts";

const args = process.argv.slice(2);
const file = args[0];

if (args.length > 1 || file?.startsWith("-") === true) {
  console.error("The command is: node src/check.ts [file]");
  process.exitCode = 2;
} else {
  const path = file === undefined ? configPath(process.env, process.cwd()) : resolve(file);
  const result = await checkConfig(fileSource(path), alertsHome(process.env, process.cwd()), DAEMON_CHECK);
  if (result.tag === "ok") {
    const { places, people, contacts, policies } = result.value.config;
    const counts = [countOf(places.length, "place"), countOf(people.length, "person", "people"), countOf(contacts.length, "contact"), countOf(policies.length, "policy", "policies")];
    console.log(`The configuration is valid: ${counts.join(", ")}.`);
  } else {
    console.error(`The configuration has ${countOf(result.error.length, "problem")}:\n- ${result.error.join("\n- ")}`);
    process.exitCode = 1;
  }
}
