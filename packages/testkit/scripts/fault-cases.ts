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
import { CHANNEL_ARMS, CHANNEL_GATES, recoverLimit, runChannelDown } from "../src/channel-down.ts";
import { runCutInBody } from "../src/cut-in-body.ts";
import { changesOf, runChangedFormat } from "../src/changed-format.ts";
import { ACCEPT_ARMS, ACCEPT_GATES, runLateAccept } from "../src/late-accept.ts";
import { runSlowSource, SLOW_ARMS, trickleMs } from "../src/slow-source.ts";
import { DOWN_ARMS, runSourceDown } from "../src/source-down.ts";
import {
  COPY_ARMS,
  COPY_GATES,
  COPY_ROUTES,
  type CopyArm,
  copyFaultsOf,
  type CopyGate,
  extFetchOf,
  KNOWN_FAULTS,
  knownFaultOf,
  LAG,
  outageWindowOf,
  PER_FETCH,
  runCopyLate,
  WINDOW,
} from "../src/copy-late.ts";
import {
  expectationOf,
  type GateKey,
  ORDER_ARMS,
  ORDER_GATES,
  ORDER_KNOWN_FAULTS,
  ORDER_PLACES,
  type OrderArm,
  orderKnownFaultOf,
  runOutOfOrder,
  sendLabel,
  STEP_GAP,
} from "../src/out-of-order.ts";
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

const channel = await runChannelDown();
write("case-7.json", channel);
const s = (ms: number | undefined): string => (ms === undefined || !Number.isFinite(ms) ? "never" : (ms / 1000).toFixed(1));
report(channel.id, channel.verdict, [
  `## ${channel.id}: a channel down`,
  "",
  `The case clock moves ${String(channel.settings.speed)} times faster than real time. Each arm has ${min(channel.settings.armMs)} min, and each outage lasts ${min(channel.settings.outageMs)} min from the start of the arm.`,
  `Each Pushover request goes through the fault proxy. The retry of a failed call is ${s(channel.times.retry)} s, and the first delivery comes in ${s(recoverLimit(channel.settings))} s after the outage.`,
  "",
  `| Arm | Requests (in the window) | To the server | Faults | Failed sends (kinds) | First delivery (s) | Pings (fail) | First fail ping (s) | ${CHANNEL_GATES.join(" | ")} |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- | ${CHANNEL_GATES.map(() => "---").join(" | ")} |`,
  ...CHANNEL_ARMS.map((arm) => {
    const record = channel.records.find((one) => one.arm === arm);
    if (record === undefined) return `| ${arm} | - | - | - | - | - | - | - | ${CHANNEL_GATES.map(() => "-").join(" | ")} |`;
    const sends = record.failures.filter((failure) => failure.call === "send");
    const kinds = [...new Set(sends.map((failure) => failure.kind))].sort().join(", ") || "none";
    const fails = record.pings.filter((ping) => ping.kind === "fail");
    const first = Math.min(...record.log.deliveries.map((delivery) => delivery.at));
    const gates = channel.verdict.gates[arm];
    return `| ${arm} | ${String(record.requests.sent)} (${String(record.requests.inWindow)}) | ${String(record.requests.reached)} | ${String(record.faults)} | ${String(sends.length)} (${kinds}) | ${s(first)} | ${String(record.pings.length)} (${String(fails.length)}) | ${s(fails[0]?.at)} | ${CHANNEL_GATES.map((gate) => (gates === undefined ? "-" : yes(gates[gate]))).join(" | ")} |`;
  }),
  "",
  `Read: ${yes(channel.verdict.read)}. Pass: **${yes(channel.verdict.pass)}**.`,
]);

const copy = await runCopyLate();
write("case-8.json", copy);
// A gate of a known fault shows "no (known)" when it fails, and "YES (fixed)" when it passes.
const copyGate = (arm: CopyArm, gate: CopyGate, value: boolean | undefined): string => {
  if (value === undefined) return "-";
  if (knownFaultOf(arm, gate) === undefined) return yes(value);
  return value ? "YES (fixed)" : "no (known)";
};
report(copy.id, { ...copy.verdict, problems: [...copy.verdict.problems, ...copy.verdict.fixed] }, [
  `## ${copy.id}: a copy feed that stops, lags or comes as a backlog`,
  "",
  `Each arm has ${String(copy.settings.fetches)} fetches of the NWS source and of the IPAWS source. The case clock moves ${String(copy.settings.speed)} times faster than real time.`,
  `Each NWS fetch gives ${String(PER_FETCH)} WEA messages. The faults are in the fetches from ${String(WINDOW.from)} to ${String(WINDOW.to - 1)}. A lag gives the answer of ${String(LAG)} fetches before.`,
  `In copy-backlog, the IPAWS feed gives HTTP 503 from ${s(outageWindowOf().from)} s to ${s(outageWindowOf().to)} s of the case clock. The next good fetch gets the backlog.`,
  "",
  `| Arm | Faults (route) | EXT at | IPAWS faults (fetches) | Limit before (s) | Largest limit after (s) | Late periods (first fetch) | First late | First met after | Met after (s) | Smallest gap NWS, IPAWS (s) | False clears | Double threats | ${COPY_GATES.join(" | ")} |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ${COPY_GATES.map(() => "---").join(" | ")} |`,
  ...COPY_ARMS.map((arm) => {
    const record = copy.records.find((one) => one.arm === arm);
    const result = copy.verdict.results[arm];
    const faults = copyFaultsOf(arm);
    const routes =
      arm === "copy-backlog"
        ? `${String(record?.faults.feed ?? 0)} feed (503), ${String(record?.outage?.inWindow ?? 0)} in the window`
        : COPY_ROUTES.filter((route) => faults[route].size > 0).map((route) => `${String(faults[route].size)} ${route}`).join(", ") || "none";
    const span = result?.faultFetches === undefined ? "none" : `${String(result.faultFetches.from)} to ${String(result.faultFetches.to - 1)}`;
    const periods = result?.periods.map((period) => String(period.nws - 1)).join(", ") || "none";
    const fetchOf = (count: number | undefined): string => (count === undefined ? "none" : String(count - 1));
    const gates = COPY_GATES.map((gate) => copyGate(arm, gate, result?.gates[gate])).join(" | ");
    return `| ${arm} | ${routes} | ${String(extFetchOf(arm, copy.settings.fetches))} | ${span} | ${s(result?.limitBefore)} | ${s(result?.limitAfter)} | ${String(result?.periods.length ?? 0)} (${periods}) | ${fetchOf(result?.toldAt)} | ${fetchOf(result?.metAt)} | ${s(result?.metAfter)} | ${s(result?.smallestGaps.nws)}, ${s(result?.smallestGaps.ipaws)} | ${String(result?.falseClears.length ?? 0)} | ${String(result?.doubles.length ?? 0)} | ${gates} |`;
  }),
  "",
  `Known faults: ${KNOWN_FAULTS.map((fault) => `${fault.arm} ${fault.gate}`).join(", ")}. ${[...new Set(KNOWN_FAULTS.map((fault) => fault.reason))].join(" ")}`,
  "",
  `Read: ${yes(copy.verdict.read)}. Pass: **${yes(copy.verdict.pass)}**.`,
]);

const order = await runOutOfOrder();
write("case-9.json", order);
// A gate of a known fault shows "no (known)" when it fails, and "YES (fixed)" when it passes.
const orderGate = (arm: OrderArm, gate: GateKey, value: boolean | undefined): string => {
  if (value === undefined) return "-";
  if (orderKnownFaultOf(arm, gate) === undefined) return yes(value);
  return value ? "YES (fixed)" : "no (known)";
};
const labels = (list: readonly string[]): string => list.join(" ") || "none";
report(order.id, { ...order.verdict, problems: [...order.verdict.problems, ...order.verdict.fixed] }, [
  `## ${order.id}: reports out of order, and duplicates`,
  "",
  `Each arm has ${String(order.settings.fetches)} fetches of the NWS source and of the IPAWS source. The case clock moves ${String(order.settings.speed)} times faster than real time.`,
  `One event line comes as NWS messages and as their IPAWS copies. Each arm changes the order or the count of the messages. Each policy has a step at 0 and a step at ${min(STEP_GAP)} min.`,
  "A send is the level (u or ls), the step and the episode, with c for a send with a cancel. The values in brackets are the expected values.",
  "",
  `| Arm | Place | Expected sends | Sends | Ends | Live | Sends while away (s) | Passes | ${ORDER_GATES.join(" | ")} |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- | ${ORDER_GATES.map(() => "---").join(" | ")} |`,
  ...ORDER_ARMS.flatMap((arm) => {
    const record = order.records.find((one) => one.arm === arm);
    const result = order.verdict.results[arm];
    const expected = expectationOf(arm);
    return ORDER_PLACES.map((place) => {
      const want = expected[place];
      const gates = ORDER_GATES.map((gate) => {
        const key: GateKey = `${place}:${gate}`;
        return orderGate(arm, key, result?.gates[key]);
      }).join(" | ");
      const away = result?.awaySends[place].map((ms) => s(ms)).join(", ") || "none";
      const live = record === undefined ? "-" : `${yes(record.live[place])} (${yes(want.live)})`;
      return `| ${arm} | ${place} | ${labels(want.sends.map((send) => sendLabel(send)))} | ${labels(result?.sends[place] ?? [])} | ${String(result?.ends[place] ?? "-")} (${String(want.ends)}) | ${live} | ${away} | ${String(record?.passes ?? 0)} | ${gates} |`;
    });
  }),
  "",
  `Known faults: ${ORDER_KNOWN_FAULTS.length === 0 ? "none" : ORDER_KNOWN_FAULTS.map((fault) => `${fault.arm} ${fault.gate}`).join(", ")}.`,
  "",
  `Read: ${yes(order.verdict.read)}. Pass: **${yes(order.verdict.pass)}**.`,
]);
