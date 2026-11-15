/**
 * This script starts the cases of the fault suite (AL-13) and writes their records.
 * Usage: node packages/testkit/scripts/fault-cases.ts [--out <folder>]
 *
 * The script writes `<folder>/case-1.json` and a table to `GITHUB_STEP_SUMMARY`. When a gate fails, or a case
 * cannot read, the script writes an `::error::` line and sets the exit code 1.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMINGS } from "@mark1russell7/rigor-testkit/http";
import { runCutInBody } from "../src/cut-in-body.ts";

const at = process.argv.indexOf("--out");
const out = at === -1 ? "fault-records" : (process.argv[at + 1] ?? "fault-records");
mkdirSync(out, { recursive: true });

const run = await runCutInBody();
writeFileSync(join(out, "case-1.json"), `${JSON.stringify({ ...run, node: process.version, at: new Date().toISOString() }, null, 2)}\n`);

const { verdict } = run;
const yes = (value: boolean): string => (value ? "yes" : "no");
const lines = [
  `## ${run.id}: a cut in the body of the main reply`,
  "",
  `The body has ${String(run.bodyBytes)} bytes. The seed is \`${run.seed}\`.`,
  "",
  "| Framing | Cuts | Network failures | Ok and complete | Other outcomes |",
  "| --- | --- | --- | --- | --- |",
  ...FRAMINGS.map((framing) => {
    const of = run.records.filter((r) => r.framing === framing);
    const network = of.filter((r) => !r.outcome.ok && r.outcome.kind === "network").length;
    const whole = of.filter((r) => r.outcome.ok && r.outcome.complete).length;
    return `| ${framing} | ${String(of.length)} | ${String(network)} | ${String(whole)} | ${String(of.length - network - whole)} |`;
  }),
  "",
  `Read: ${yes(verdict.read)}. Never ok and complete: ${yes(verdict.neverWhole)}. Pass: **${yes(verdict.pass)}**.`,
  ...(verdict.problems.length === 0 ? [] : ["", ...verdict.problems.map((problem) => `- ${problem}`)]),
  "",
];
const text = lines.join("\n");
console.log(text);
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary !== undefined) appendFileSync(summary, text);
if (!verdict.pass) {
  console.log(`::error::${run.id}: ${verdict.read ? "the gate failed" : "the case cannot read (no read is not a pass)"}. ${String(verdict.problems.length)} problems.`);
  process.exitCode = 1;
}
