/**
 * This file is the entry of the process, and the only file that uses `run()`. It starts one of two services:
 *
 * - `node src/main.ts` starts the runtime.
 * - `node src/main.ts supervise <folder>` starts the supervisor of the runtime (`supervise.ts`). The boot task starts it.
 *
 * The lifecycle owns the signals of the process. After SIGTERM or Ctrl-C, the service stops in its
 * phases, and the process exits with 0 or 1.
 *
 * The environment gives `PORT` (8080), `PROBE_PORT` (9090), `SERVICE_PROFILE` (`local`) and
 * `ALERTS_HOME` (the folder `.alerts` in the home folder). The value in parentheses is the value
 * without the variable. An empty value counts as no value, and a relative path starts at the working
 * folder. The folder holds the private files of the instance: `config.json`,
 * `secrets.env`, the log `runtime.sqlite`, the outlines `shapes.sqlite` and the counts of the quotas
 * `quotas.sqlite`. No repository holds them.
 *
 * The key `HEALTHCHECKS_PING_URL` of `secrets.env` gives the outside heartbeat (`heartbeat.ts`). The
 * profile `daemon` of the live instance does not start without it. Another profile starts with a warning.
 * The optional key `HEALTHCHECKS_LOUD_PING_URL` gives a second check. The heartbeat sends each ping to it too.
 *
 * The API also serves the built local page of `packages/site/dist` at the path `/`. Build it before the start:
 * `pnpm --filter ./packages/site build`. Without the build, the path `/` gives 404, and the routes still answer.
 *
 * The optional file `copy.json` gives the settings of this copy of the system (`copy.ts`): its rank and the key of its
 * first check. Without the file, the runtime is the only copy. A change of the file needs `install.ts restart`.
 *
 * The field `outage` of `config.json` gives the outage call. It needs the keys of Twilio and the key
 * `OUTAGE_TOKEN`. The worker `outage` deploys its Functions to Twilio (`outage.ts`).
 *
 * A copy with other copies reads them over HTTP (`exchange-http.ts`). A copy with the address `listen` serves its
 * shared events on that address. Both need the key `COPY_TOKEN` of `secrets.env`, with 32 or more characters.
 *
 * A bad `config.json` gives way to the last good copy `config.good.json` (`reload.ts`). In the profile
 * `daemon`, a change of the private files that passes the check stops the runtime. The supervisor starts it again.
 */
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configHash } from "@mark1russell7/alerts";
import { PUSHOVER_QUOTA, PUSHOVER_RESERVE_NOTICES } from "@mark1russell7/alerts-channel-pushover";
import { openShapeCache, SHAPES_FILE } from "@mark1russell7/alerts-shapes-nws";
import { realClock, wallClock } from "@mark1russell7/algebra/clock";
import type { ServiceBuilder } from "@mark1russell7/service";
import { errorMessage } from "@mark1russell7/text";
import { redactSecrets } from "@mark1russell7/text/redact";
import { SqliteHostStateStore } from "polite-crawler";
import { fetchTransport, quotaGate } from "polite-crawler/api";
import { writeFileAtomic } from "@procedures/fs/files";
import { alertsHome, ConfigRefused, configPath, envSecrets } from "./config.ts";
import { PAGE_INDEX, pageFolder } from "./api.ts";
import { COPY_TOKEN_KEY, readCopySettings } from "./copy.ts";
import { EXCHANGE_TOKEN_LENGTH, exchangeCall, exchangeHost } from "./exchange-http.ts";
import { heartbeat, heldOf, type PassSummary } from "./heartbeat.ts";
import { quotaNote } from "./quota.ts";
import { PROFILES, declare } from "./index.ts";
import { daemonCheck, INSTANCE_CHECK, LOUD_PING_URL_KEY, openInstance, pingKeyOf, pingTargets, userAgent } from "./instance.ts";
import { openCheckedRuntimeLog } from "./log.ts";
import type { ExchangeRound } from "./peers.ts";
import { GOOD_CONFIG_FILE, privateFiles, reloadHook, startConfig } from "./reload.ts";
import { shapeReport, zoneCodesText } from "./shapes.ts";
import { supervisor } from "./supervise.ts";

/** This function gives a port from the environment, or the fallback when the variable is not set. */
const port = (name: string, fallback: number): number => {
  const text = process.env[name];
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${name} is not a port: ${text}`);
  return value;
};

/** This function makes the service of the runtime from the environment and the private files. */
async function runtime(): Promise<ServiceBuilder> {
  const name = process.env["SERVICE_PROFILE"] ?? "local";
  const profile = PROFILES[name];
  if (profile === undefined) throw new Error(`SERVICE_PROFILE is "${name}". The profiles are: ${Object.keys(PROFILES).join(", ")}.`);

  const home = alertsHome(process.env, process.cwd());

  // The start checks config.json with the keys of secrets.env. A bad config.json gives way to the last good copy.
  // A problem names the line and the key of a bad line, or the code of a read error. It holds no value and no path.
  // The settings of this copy of the system. A problem stops the start, and it holds no address and no URL.
  const copied = await readCopySettings(home);
  if (copied.tag === "err") throw new ConfigRefused(copied.error);
  const copy = copied.value;
  const peers = copy.peers ?? [];
  if (peers.length > 0) console.log(`This runtime is the copy ${copy.id} with rank ${String(copy.rank)}. The other copies: ${peers.map((peer) => peer.id).join(", ")}.`);
  const check = name === "daemon" ? daemonCheck(copy) : INSTANCE_CHECK;
  const files = privateFiles(home, configPath(process.env, process.cwd()));
  const loaded = await startConfig(files, check, (path, text) => writeFileAtomic(path, text));
  if (loaded.fallback.length > 0) console.error(`The file config.json has problems. The runtime uses the last good copy ${GOOD_CONFIG_FILE}:\n- ${loaded.fallback.join("\n- ")}`);
  for (const note of loaded.notes) console.error(note);
  const keys = loaded.keys;
  const values = Object.values(keys);

  const secret = envSecrets(keys);
  const wall = wallClock();
  const config = loaded.parsed;
  // Each request to the server of another party has this User-Agent.
  const agent = userAgent(config.config.contact);

  // The exchange with the other copies. Each copy has the same token, and a problem holds no value of the token.
  const exchanges = peers.length > 0 || copy.listen !== undefined;
  const token = exchanges ? secret(COPY_TOKEN_KEY) : undefined;
  if (exchanges && (token === undefined || token.length < EXCHANGE_TOKEN_LENGTH)) {
    throw new ConfigRefused([`The file secrets.env needs ${COPY_TOKEN_KEY} with ${String(EXCHANGE_TOKEN_LENGTH)} or more characters. A copy with other copies or the address listen uses it.`]);
  }
  // Each problem of a page goes to the output. A failed read of a copy goes to the output once when it starts and once when it ends.
  const failing = new Set<string>();
  const onExchange = (round: ExchangeRound): void => {
    for (const problem of round.problems) console.error(redactSecrets(`The exchange: ${problem}`, values));
    for (const id of round.conflicts) console.error(`The exchange: the import ${id} has the id of a different event of the log. The log kept its event.`);
    for (const peer of peers) {
      const failure = instance.copies?.worker?.failure(peer.id);
      if (failure !== undefined && !failing.has(peer.id)) {
        failing.add(peer.id);
        console.error(redactSecrets(`The reads of the copy ${peer.id} fail: ${failure}`, values));
      } else if (failure === undefined && failing.delete(peer.id)) {
        console.log(`The reads of the copy ${peer.id} work again.`);
      }
    }
  };

  // The count of the Pushover messages of the month. The file keeps it across a restart. The key names the application, not its token.
  const quotas = new SqliteHostStateStore(join(home, "quotas.sqlite"));
  const pushoverQuota = quotaGate(PUSHOVER_QUOTA, { key: "pushover:app", store: quotas, now: () => wall.now() });
  const pushoverReserveNotices = quotaGate(PUSHOVER_RESERVE_NOTICES, { key: "pushover:reserve-notices", store: quotas, now: () => wall.now() });

  // The outside heartbeat. Without it, a stop of this process is silent. The check of the profile daemon needs it.
  // Each check has its own hook. The hooks make the same pings, and a slow ping to one check does not hold the other.
  const targets = pingTargets(secret, copy);
  if (!targets.some((target) => target.key === pingKeyOf(copy))) console.warn(`The file secrets.env has no ${pingKeyOf(copy)}. This runtime has no outside heartbeat.`);
  const beats = targets.map((target) =>
    heartbeat({
      url: target.url,
      fetch,
      clock: wall,
      userAgent: agent,
      held: (at) => heldOf(instance.runtime.state(), at),
      // The body of each ping tells the state of each quota. Thus the check shows the reserve.
      notes: () => instance.quotas().map(quotaNote),
      onError: (message) => console.error(redactSecrets(target.key === LOUD_PING_URL_KEY ? `The loud check: ${message}` : message, values)),
    }),
  );

  // A change of the private files, or a restart request, restarts the runtime. Only the profile daemon has a supervisor that starts it again.
  const reload =
    name === "daemon"
      ? reloadHook({
          files,
          check,
          started: loaded.texts,
          request: loaded.request,
          restart: (cause) => {
            const reason = cause === "requested" ? "A restart request came." : "The private files changed, and they pass the check.";
            console.error(`${reason} The runtime stops, and the supervisor starts it again.`);
            void service.lifecycle?.shutdown(cause === "requested" ? "A restart request came." : "The private files changed.");
          },
          onRefused: (problems) => console.error(`A change of the private files has problems. The runtime keeps its files:\n- ${problems.join("\n- ")}`),
        })
      : undefined;
  const onPass =
    beats.length === 0 && reload === undefined
      ? undefined
      : (pass: PassSummary) => {
          for (const beat of beats) beat(pass);
          reload?.onPass();
        };

  // A broken log file goes into quarantine. The new file gets each event that the salvage reads, and a system report tells the loss.
  const { log, recovered } = openCheckedRuntimeLog(join(home, "runtime.sqlite"), { now: () => wall.now() });
  if (recovered !== undefined) console.error(`The log file was broken. It is in the quarantine folder ${recovered.quarantine}. The new log kept ${String(recovered.added)} events and lost ${String(recovered.lost)}.`);
  // A broken file of shapes goes into quarantine, and the store starts empty. Then the outlines come again from the NWS API.
  const shapes = openShapeCache(join(home, SHAPES_FILE));
  if (shapes.quarantined !== undefined) console.error(`The file ${SHAPES_FILE} was broken. It is in quarantine, and the store of shapes starts empty.`);
  const instance = openInstance({
    config,
    secret,
    log,
    clock: realClock,
    wall,
    transport: fetchTransport({ userAgent: agent }),
    pushover: fetch,
    pushoverQuota,
    pushoverReserveNotices,
    // The Twilio calls and the read of the balance. The cap of the spend counts in quotas.sqlite.
    twilio: fetch,
    spendStore: quotas,
    run: randomUUID(),
    copy,
    ...(token === undefined ? {} : { exchange: { call: exchangeCall({ token }), configHash: configHash(config.config) }, onExchange }),
    ...(onPass === undefined ? {} : { onPass }),
    // The output gets no secret, also when an error quotes a request.
    onError: (error, failures) => console.error(`A pass failed (${failures} in sequence): ${redactSecrets(errorMessage(error), values)}`),
    shapes,
    onShapes: (outcome) => {
      const report = shapeReport(outcome);
      if (report !== undefined) console.error(redactSecrets(report, values));
    },
    // New outlines change the codes of a place. Only the profile daemon has a supervisor that starts the runtime again.
    onPlaceCodes: () => {
      if (name !== "daemon") {
        console.error("New outlines change the codes of a place. Start the runtime again to use them.");
        return;
      }
      console.error("New outlines change the codes of a place. The runtime stops, and the supervisor starts it again.");
      void service.lifecycle?.shutdown("The codes of a place changed.");
    },
    // The worker of the outage call deploys its Functions at the start and once in each day. A failed deploy goes again after a backoff.
    onOutageLog: (line) => console.log(line),
    onOutageError: (error, failures) => console.error(`A deploy of the outage call failed (${failures} in sequence): ${redactSecrets(errorMessage(error), values)}`),
  });
  if (instance.zones !== undefined) console.log(zoneCodesText(instance.zones));
  if (instance.runtime.skipped > 0) {
    console.error(`The log has ${String(instance.runtime.skipped)} events of types that this build does not know. A later build wrote them. The runtime skips them.`);
  }

  // The listener of the exchange is on the address listen of copy.json. Only the token check of the host guards it.
  const copies = instance.copies;
  const host = copies === undefined || copy.listen === undefined || token === undefined ? undefined : exchangeHost({ source: copies.source, token, listen: copy.listen });
  const exchange = { ...(copies?.loop === undefined ? {} : { loop: copies.loop }), ...(host === undefined ? {} : { host }) };

  // The built local page. The line tells if the page is built, and it holds no path.
  const page = pageFolder(fileURLToPath(new URL("..", import.meta.url)));
  const built = await access(join(page, PAGE_INDEX)).then(
    () => true,
    () => false,
  );
  console.log(built ? "The API serves the local page at the path /." : "The local page is not built, thus the path / gives 404. Build it: pnpm --filter ./packages/site build");

  // The service closes the log and the store of shapes in its shutdown.
  const service = declare({
    port: port("PORT", 8080),
    probePort: port("PROBE_PORT", 9090),
    profile,
    loop: instance.loop,
    log,
    shapes: instance.shapes,
    quotas,
    map: instance.map,
    page,
    ...(instance.outage === undefined ? {} : { outage: instance.outage }),
    exchange,
  });
  return service;
}

const MODES = ["supervise"];
const mode = process.argv[2];
if (mode !== undefined && !MODES.includes(mode)) throw new Error(`The first argument is "${mode}". Give no argument for the runtime, or one of: ${MODES.join(", ")}.`);

// The process exits after the shutdown of the service.
const started = mode === "supervise" ? supervisor(process.argv[3]) : await runtime();
await started.run();
