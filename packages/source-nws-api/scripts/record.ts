/**
 * This script records the fixtures of the NWS API source: one real alert for each event code that
 * the tests use. It reads the national list of active alerts and the newest test messages, through
 * polite-crawler. The alerts of the NWS are public, and they hold no personal data.
 *
 * Start it in the folder of the package: `pnpm record`. The option `--avoid=<prefixes>` keeps the
 * alerts with a UGC code that starts with one of the prefixes out of the fixtures. The owner of an
 * instance uses it to keep the regions of the instance out of the public repository.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fetchTransport, send, type Reply } from "polite-crawler/api";
import { HostScheduler, realClock } from "polite-crawler/politeness";

const BASE_URL = "https://api.weather.gov";
const USER_AGENT = "alerts-dev-fixtures";
const OUT = new URL("../fixtures/", import.meta.url);

/** One fixture to record: an NWS event code and the facts that the alert must have. */
interface Wanted {
  readonly code: string;
  readonly polygon?: boolean;
  readonly update?: boolean;
}

const WANTED: readonly Wanted[] = [
  { code: "FLW", polygon: true, update: true },
  { code: "FAW" },
  { code: "BZW" },
  { code: "GLW" },
  { code: "SPS", polygon: true },
  { code: "FAA" },
  { code: "WWY" },
  { code: "FZW" },
  { code: "HWA" },
  { code: "CFS" },
  { code: "SCY", update: true },
  { code: "UPW" },
  { code: "SRW" },
];

type Feature = {
  readonly geometry: unknown;
  readonly properties: {
    readonly id: string;
    readonly messageType: string;
    readonly references?: readonly unknown[];
    readonly geocode?: { readonly UGC?: readonly string[] };
    readonly eventCode?: { readonly NationalWeatherService?: readonly string[] };
  };
};

const transport = fetchTransport({ userAgent: USER_AGENT });
const pace = { scheduler: new HostScheduler(realClock, 1), now: realClock.now };

async function get(path: string): Promise<Feature[]> {
  const answer = await send(pace, transport, {
    source: "nws-api-fixtures",
    host: new URL(BASE_URL).host,
    minIntervalMs: 2000,
    what: path,
    exchange: { method: "GET", url: `${BASE_URL}${path}`, headers: { accept: "application/geo+json" }, body: null },
  });
  const reply: Reply = answer.reply;
  if (answer.classified.outcome !== "ok") throw new Error(`${path}: ${String(reply.status)} ${reply.statusText}`);
  return (JSON.parse(reply.body) as { features: Feature[] }).features;
}

const avoid = (process.argv.find((arg) => arg.startsWith("--avoid=")) ?? "--avoid=")
  .slice("--avoid=".length)
  .split(",")
  .map((prefix) => prefix.trim().toUpperCase())
  .filter((prefix) => prefix !== "");
const allowed = (feature: Feature): boolean =>
  !(feature.properties.geocode?.UGC ?? []).some((ugc) => avoid.some((prefix) => ugc.toUpperCase().startsWith(prefix)));
const nwsCode = (feature: Feature): string | undefined => feature.properties.eventCode?.NationalWeatherService?.[0];

const active = (await get("/alerts/active")).filter(allowed);
const tests = await get("/alerts?status=test&limit=2");
await mkdir(OUT, { recursive: true });

const written: string[] = [];
for (const wanted of WANTED) {
  const candidates = active
    .filter((feature) => nwsCode(feature) === wanted.code)
    .filter((feature) => wanted.polygon !== true || feature.geometry !== null)
    .filter((feature) => wanted.update !== true || (feature.properties.messageType === "Update" && (feature.properties.references ?? []).length > 0))
    .sort((a, b) => JSON.stringify(a).length - JSON.stringify(b).length || a.properties.id.localeCompare(b.properties.id));
  const chosen = candidates[0];
  if (chosen === undefined) {
    console.log(`no active alert for ${wanted.code}: the old fixture stays`);
    continue;
  }
  await writeFile(new URL(`nws-${wanted.code.toLowerCase()}.json`, OUT), `${JSON.stringify(chosen, null, 2)}\n`);
  written.push(wanted.code);
}
const keepalive = tests.find((feature) => /KEEPALIVE/.test(feature.properties.id));
if (keepalive !== undefined) {
  await writeFile(new URL("nws-keepalive.json", OUT), `${JSON.stringify(keepalive, null, 2)}\n`);
  written.push("keepalive");
}
console.log(`recorded: ${written.join(", ")}`);
