/**
 * This script starts the cases of the fault suite (AL-13) and writes their records.
 * Usage: node packages/testkit/scripts/fault-cases.ts [--out <folder>]
 *
 * The script writes `<folder>/case-<n>.json` for each case, and a table to `GITHUB_STEP_SUMMARY`. When a gate fails, or a
 * case cannot read, the script writes an `::error::` line and sets the exit code 1.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMINGS } from "@mark1russell7/rigor-testkit/http";
import { runCutInBody } from "../src/cut-in-body.ts";
import { changesOf, runChangedFormat } from "../src/changed-format.ts";
import { ACCEPT_ARMS, ACCEPT_GATES, runLateAccept } from "../src/late-accept.ts";
import { runSlowSource, SLOW_ARMS, trickleMs } from "../src/slow-source.ts";
import { DOWN_ARMS, runSourceDown } from "../src/source-down.ts";
import { OLD_LISTS, R2_FROM, R3_UNTIL, runStaleList, STALE_ARMS, STALE_GATES } from "../src/stale-list.ts";

const at = process.argv.indexOf("--out");
const out = at === -1 ? "fault-records" : (process.argv[at + 1] ?? "fault-records");
mkdirSync(out, { recursive: true });

const yes = (value: boolean): string => (value ? "yes" : "no");
const write = (file: string, run: object): void => {
  writeFileSync(join(out, file), `${JSON.stringify({ ...run, node: process.version, at: new Date().toISOString() }, null, 2)}\n`);
};
const report = (id: string, verdict: { readonly read: boolean; readonly pass: boolean; readonly problems: readonly string[] }, lines: readonly string[]): void => {
  const text = [...lines, ...(verdict.problems.length === 0 ? [] : ["", ...verdict.problems.map((problem) => `- ${problem}`)]), "", ""].join("\n");
  console.log(text);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined) appendFileSync(summary, text);
  if (!verdict.pass) {
    console.log(`::error::${id}: ${verdict.read ? "the gate failed" : "the case cannot read (no read is not a pass)"}. ${String(verdict.problems.length)} problems.`);
    process.exitCode = 1;
  }
};

const cuts = await runCutInBody();
write("case-1.json", cuts);
report(cuts.id, cuts.verdict, [
  `## ${cuts.id}: a cut in the body of the main reply`,
  "",
  `The body has ${String(cuts.bodyBytes)} bytes. The seed is \`${cuts.seed}\`.`,
  "",
  "| Framing | Cuts | Network failures | Ok and complete | Other outcomes |",
  "| --- | --- | --- | --- | --- |",
  ...FRAMINGS.map((framing) => {
    const of = cuts.records.filter((r) => r.framing === framing);
    const network = of.filter((r) => !r.outcome.ok && r.outcome.kind === "network").length;
    const whole = of.filter((r) => r.outcome.ok && r.outcome.complete).length;
    return `| ${framing} | ${String(of.length)} | ${String(network)} | ${String(whole)} | ${String(of.length - network - whole)} |`;
  }),
  "",
  `Read: ${yes(cuts.verdict.read)}. Never ok and complete: ${yes(cuts.verdict.neverWhole)}. Pass: **${yes(cuts.verdict.pass)}**.`,
]);

const slow = await runSlowSource();
write("case-2.json", slow);
const { settings } = slow;
const armOf = {
  long: `a stall of ${String(settings.longStallMs)} ms`,
  trickle: `${String(settings.trickle.pieces)} writes, ${String(trickleMs(settings))} ms`,
  short: `a stall of ${String(settings.shortStallMs)} ms`,
} as const;
report(slow.id, slow.verdict, [
  `## ${slow.id}: a slow source`,
  "",
  `The limit of each query is ${String(settings.limitMs)} ms. The body has ${String(slow.bodyBytes)} bytes. The seed is \`${slow.seed}\`.`,
  "",
  "| Framing | Arm | Faults | Timeouts | Ok and complete | Other outcomes | Longest fetch (ms) |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...FRAMINGS.flatMap((framing) =>
    SLOW_ARMS.map((arm) => {
      const of = slow.records.filter((r) => r.framing === framing && r.arm === arm);
      const timeouts = of.filter((r) => !r.outcome.ok && r.outcome.kind === "timeout").length;
      const whole = of.filter((r) => r.outcome.ok && r.outcome.complete).length;
      const longest = of.reduce((most, r) => Math.max(most, r.ms), 0);
      return `| ${framing} | ${armOf[arm]} | ${String(of.length)} | ${String(timeouts)} | ${String(whole)} | ${String(of.length - timeouts - whole)} | ${String(longest)} |`;
    }),
  ),
  "",
  `Read: ${yes(slow.verdict.read)}. Gates: ${SLOW_ARMS.map((arm) => `${arm} ${yes(slow.verdict.gates[arm])}`).join(", ")}. Pass: **${yes(slow.verdict.pass)}**.`,
]);

const format = await runChangedFormat();
write("case-3.json", format);
const levelled = format.baseline.levels.filter((one) => one.level !== "none").length;
report(format.id, format.verdict, [
  `## ${format.id}: a changed format`,
  "",
  `The main body has ${String(format.bodyBytes)} bytes and ${String(format.baseline.reports)} reports. ${String(levelled)} alerts have a level for the person of the case.`,
  "",
  "| Arm | Answered | Reports | Fatal problems | Lossy problems | Notes | Health | Changed levels | Gate |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...format.records.map(
    (r) =>
      `| ${r.arm} | ${yes(r.answered)} | ${String(r.reports)} | ${String(r.fatal.length)} | ${String(r.lossy.length)} | ${String(r.notes.length)} | ${r.health} | ${String(changesOf(r).length)} | ${yes(format.verdict.gates[r.arm])} |`,
  ),
  "",
  `Read: ${yes(format.verdict.read)}. Pass: **${yes(format.verdict.pass)}**.`,
]);

const accept = await runLateAccept();
write("case-4.json", accept);
const limits = accept.settings;
report(accept.id, accept.verdict, [
  `## ${accept.id}: a late accept of the Pushover channel`,
  "",
  `The call limit of the delivery step is ${String(limits.callLimitMs)} ms, and its flight limit ${String(limits.flightLimitMs)} ms. The late answer comes at ${String(limits.lateMs)} ms. A hang lasts ${String(limits.hangMs)} ms, and each arm ${String(limits.armMs)} ms.`,
  "",
  "| Arm | Fault at its point | Sends | Reads | Cancels | Cancels by tag | Open messages | Failed calls | Duplicates | Delivered | Single | Stopped |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...accept.records.map((r) => {
    const open = r.ledger.messages.filter((m) => m.readAt === undefined && m.cancelledAt === undefined).length;
    const gates = accept.verdict.gates[r.arm];
    const c = r.ledger.counts;
    return `| ${r.arm} | ${yes(r.faulted)} | ${String(c.sends)} | ${String(c.reads)} | ${String(c.cancels)} | ${String(c.tagCancels)} | ${String(open)} | ${String(r.failures.length)} | ${String(r.duplicates)} | ${ACCEPT_GATES.map((g) => yes(gates[g])).join(" | ")} |`;
  }),
  "",
  `Read: ${yes(accept.verdict.read)}. Arms: ${ACCEPT_ARMS.join(", ")}. Pass: **${yes(accept.verdict.pass)}**.`,
]);

const down = await runSourceDown();
write("case-5.json", down);
const min = (ms: number | undefined): string => (ms === undefined ? "never" : (ms / 60_000).toFixed(1));
report(down.id, down.verdict, [
  `## ${down.id}: a source down`,
  "",
  `The case clock moves ${String(down.settings.speed)} times faster than real time. Each arm has ${min(down.settings.armMs)} min, and each outage starts at ${min(down.settings.outageAtMs)} min.`,
  `Each request goes through the fault proxy. The plan of an arm with an outage has one fault of a window. The seed is \`${down.seed}\`.`,
  `The health goes down in ${min(down.limits.detectMs)} min and comes up in ${min(down.limits.recoverMs)} min.`,
  "",
  "| Arm | Outage (min) | Requests (in the window) | To the server | Faults | Failed fetches | Down after (min) | Up after (min) | Detected | Recovered |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...DOWN_ARMS.map((arm) => {
    const record = down.records.find((one) => one.arm === arm);
    const result = down.verdict.results[arm];
    const outage = record?.outage === undefined ? "none" : `${min(record.outage.from)} to ${min(record.outage.to)}`;
    const failed = record?.passes.filter((pass) => pass.failure !== undefined).length ?? 0;
    const after = (ms: number | undefined): string => (result === undefined ? "-" : min(ms));
    const requests = record === undefined ? "-" : `${String(record.requests.sent)} (${String(record.requests.inWindow)})`;
    return `| ${arm} | ${outage} | ${requests} | ${String(record?.requests.reached ?? 0)} | ${String(record?.faults ?? 0)} | ${String(failed)} | ${after(result?.detectMs)} | ${after(result?.recoverMs)} | ${result?.detected ?? "-"} | ${result?.recovered ?? "-"} |`;
  }),
  "",
  `Read: ${yes(down.verdict.read)}. Pass: **${yes(down.verdict.pass)}**.`,
]);

const stale = await runStaleList();
write("case-6.json", stale);
const rowsAt = (events: readonly { readonly fetch: number; readonly row: string }[]): string => events.map((event) => `${event.row} at ${String(event.fetch)}`).join(", ") || "none";
report(stale.id, stale.verdict, [
  `## ${stale.id}: a stale or repeated list of a snapshot source`,
  "",
  `Each arm has ${String(stale.settings.fetches)} fetches of the IEM source. The case clock moves ${String(stale.settings.speed)} times faster than real time.`,
  `The row r2 is in the true list from fetch ${String(R2_FROM)}, and the row r3 leaves it at fetch ${String(R3_UNTIL)}.`,
  "",
  "| Arm | Old lists (fetch: list) | Faults | Not complete | False ends | False returns | Ended at the end | No false end | No false return | Settles |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...STALE_ARMS.map((arm) => {
    const record = stale.records.find((one) => one.arm === arm);
    const result = stale.verdict.results[arm];
    const olds = [...OLD_LISTS[arm]].map(([fetch, list]) => `${String(fetch)}: ${String(list)}`).join(", ") || "none";
    const incomplete = record?.fetches.filter((fetch) => !fetch.complete).map((fetch) => fetch.fetch).join(", ") || "none";
    const gates = STALE_GATES.map((gate) => (result === undefined ? "-" : yes(result.gates[gate]))).join(" | ");
    return `| ${arm} | ${olds} | ${String(record?.faults ?? 0)} | ${incomplete} | ${rowsAt(result?.falseEnds ?? [])} | ${rowsAt(result?.falseBacks ?? [])} | ${result?.endedAtEnd.join(", ") || "none"} | ${gates} |`;
  }),
  "",
  `Read: ${yes(stale.verdict.read)}. Pass: **${yes(stale.verdict.pass)}**.`,
]);
