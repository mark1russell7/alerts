import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FORMAT, type AlertConfig, type ChannelDescriptor, type ChannelId, type PersonId, type PlaceId } from "@mark1russell7/alerts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigRefused, type FileText, type InstanceCheck, type PrivateTexts } from "./config.ts";
import {
  GOOD_CONFIG_FILE,
  privateFiles,
  readPrivateTexts,
  readRestartRequest,
  reloadHook,
  reloadStep,
  requestKey,
  requestRestart,
  RESTART_REQUEST_FILE,
  startConfig,
  textsKey,
  type PrivateFiles,
  type ReloadState,
  type RestartCause,
  type RestartPorts,
} from "./reload.ts";

const PUSHOVER = "pushover" as ChannelId;
const PERSON = "person:a" as PersonId;

const CHANNEL: ChannelDescriptor = {
  id: PUSHOVER,
  title: "Pushover",
  dependsOn: ["provider:pushover"],
  uses: ["internet", "dns", "power"],
  breaksThrough: true,
  repeats: true,
  ack: "poll",
  maxTitle: 250,
  maxBody: 1024,
};

// The start of each private value. A check looks for it in each problem and each message.
const PRIVATE = "PRIVATE";

// A public place in Kansas, with a made-up label. The contact names a secret, not its value.
const configWith = (label: string): AlertConfig => ({
  format: CONFIG_FORMAT,
  places: [{ id: "place:a" as PlaceId, label, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 }],
  people: [{ watch: { person: PERSON, places: ["place:a" as PlaceId], rules: [] } }],
  contacts: [{ person: PERSON, channel: PUSHOVER, address: { user: { secret: "PUSHOVER_USER" } } }],
  policies: [{ level: "life-safety", steps: [{ channel: PUSHOVER, at: 0 }], exhaustedAfter: 600_000 }],
});
const GOOD = JSON.stringify(configWith("Place A"));
const OTHER = JSON.stringify(configWith("Place B"));
// A configuration with a private value in a wrong field: the check refuses it.
const BAD = JSON.stringify({ ...configWith("Place A"), format: `${PRIVATE}-format` });
const KEYS = `PUSHOVER_USER=${PRIVATE}-user\n`;
const CHECK: InstanceCheck = { channels: [CHANNEL], problems: () => [] };

const write = (path: string, text: string): Promise<void> => writeFile(path, text, "utf8");

describe("startConfig", () => {
  let home = "";
  let files: PrivateFiles;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), `alerts-reload-${PRIVATE}-`));
    files = privateFiles(home, join(home, "config.json"));
    await write(files.secrets, KEYS);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("uses config.json when it passes the check, and writes it as the last good copy", async () => {
    await write(files.config, GOOD);
    const started = await startConfig(files, CHECK, write);
    expect(files.good).toBe(join(home, GOOD_CONFIG_FILE));
    expect(started.parsed.config).toEqual(configWith("Place A"));
    expect(started.keys).toEqual({ PUSHOVER_USER: `${PRIVATE}-user` });
    expect(started.texts).toEqual({ config: { text: GOOD }, secrets: { text: KEYS } });
    expect(started.fallback).toEqual([]);
    expect(started.notes).toEqual([]);
    expect(await readFile(files.good, "utf8")).toBe(GOOD);
    // No restart request exists at the first start.
    expect(files.request).toBe(join(home, RESTART_REQUEST_FILE));
    expect(started.request).toEqual({ code: "ENOENT" });
  });

  it("gives the text of the restart request at the start, thus the new runtime does not restart for it again", async () => {
    await write(files.config, GOOD);
    await write(files.request, "token 1\n");
    expect((await startConfig(files, CHECK, write)).request).toEqual({ text: "token 1\n" });
  });

  it("does not write the last good copy when it has the same text", async () => {
    await write(files.config, GOOD);
    await write(files.good, GOOD);
    let writes = 0;
    await startConfig(files, CHECK, async (path, text) => ((writes += 1), write(path, text)));
    expect(writes).toBe(0);
  });

  it("replaces an older last good copy", async () => {
    await write(files.config, OTHER);
    await write(files.good, GOOD);
    await startConfig(files, CHECK, write);
    expect(await readFile(files.good, "utf8")).toBe(OTHER);
  });

  it("uses the last good copy when config.json has problems, and gives the problems", async () => {
    await write(files.config, BAD);
    await write(files.good, GOOD);
    const started = await startConfig(files, CHECK, write);
    expect(started.parsed.config).toEqual(configWith("Place A"));
    expect(started.fallback).toHaveLength(1);
    expect(started.fallback.join("\n")).not.toContain(PRIVATE);
    // The texts of the start are the texts on the disk, thus the hook does not see the bad file as a change.
    expect(started.texts.config).toEqual({ text: BAD });
    // The last good copy stays.
    expect(await readFile(files.good, "utf8")).toBe(GOOD);
  });

  it("uses the last good copy when config.json cannot be read", async () => {
    await write(files.good, GOOD);
    const started = await startConfig(files, CHECK, write);
    expect(started.fallback).toEqual(["The configuration file cannot be read (ENOENT)."]);
    expect(started.texts.config).toEqual({ code: "ENOENT" });
  });

  it("throws ConfigRefused with the problems of the two copies, and no private value", async () => {
    await write(files.config, BAD);
    await write(files.good, `{"label":"${PRIVATE}"`);
    const thrown = await startConfig(files, CHECK, write).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ConfigRefused);
    if (!(thrown instanceof ConfigRefused)) return;
    expect(thrown.problems).toHaveLength(2);
    expect(thrown.problems[1]).toBe(`The last good copy ${GOOD_CONFIG_FILE}: The configuration is not valid JSON.`);
    expect(thrown.message).not.toContain(PRIVATE);
  });

  it("throws ConfigRefused when config.json has problems and no last good copy exists", async () => {
    await write(files.config, BAD);
    const thrown = await startConfig(files, CHECK, write).catch((error: unknown) => error);
    expect(thrown instanceof ConfigRefused ? thrown.problems[1] : undefined).toBe(`The last good copy ${GOOD_CONFIG_FILE} cannot be read (ENOENT).`);
  });

  it("gives the problems of secrets.env, and does not use the last good copy with bad keys", async () => {
    await write(files.config, GOOD);
    await write(files.good, GOOD);
    await write(files.secrets, `${PRIVATE} no equals sign\n`);
    const thrown = await startConfig(files, CHECK, write).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ConfigRefused);
    expect(thrown instanceof ConfigRefused ? thrown.message : PRIVATE).not.toContain(PRIVATE);
  });

  it("starts with a note when the last good copy cannot be written", async () => {
    await write(files.config, GOOD);
    const failing = (): Promise<void> => Promise.reject(Object.assign(new Error(`${PRIVATE} path`), { code: "EACCES" }));
    const started = await startConfig(files, CHECK, failing);
    expect(started.parsed.config).toEqual(configWith("Place A"));
    expect(started.notes).toEqual([`The last good copy ${GOOD_CONFIG_FILE} cannot be written (EACCES). The old copy stays.`]);
  });
});

describe("reloadStep", () => {
  const texts = (config: string, secrets = KEYS): PrivateTexts => ({ config: { text: config }, secrets: { text: secrets } });
  // No restart request at the start.
  const NONE: FileText = { code: "ENOENT" };
  const start: ReloadState = { started: textsKey(texts(GOOD)), request: requestKey(NONE) };

  it("gives no action for the texts of the start", () => {
    expect(reloadStep(start, texts(GOOD), CHECK, NONE)).toEqual({ state: start, action: { kind: "none" } });
  });

  it("restarts for a change of either file that passes the check", () => {
    expect(reloadStep(start, texts(OTHER), CHECK, NONE).action).toEqual({ kind: "restart", cause: "changed" });
    expect(reloadStep(start, texts(GOOD, `${KEYS}OTHER=value\n`), CHECK, NONE).action).toEqual({ kind: "restart", cause: "changed" });
  });

  it("gives the problems of a bad change one time", () => {
    const first = reloadStep(start, texts(BAD), CHECK, NONE);
    expect(first.action.kind).toBe("refused");
    expect(first.state.refused).toBe(textsKey(texts(BAD)));
    expect(reloadStep(first.state, texts(BAD), CHECK, NONE)).toEqual({ state: first.state, action: { kind: "none" } });
  });

  it("checks a second bad change, and restarts for a good change after a bad one", () => {
    const first = reloadStep(start, texts(BAD), CHECK, NONE);
    expect(reloadStep(first.state, texts(BAD, "OTHER=value\n"), CHECK, NONE).action.kind).toBe("refused");
    expect(reloadStep(first.state, texts(OTHER), CHECK, NONE).action).toEqual({ kind: "restart", cause: "changed" });
  });

  it("clears the refusal after a return to the texts of the start", () => {
    const first = reloadStep(start, texts(BAD), CHECK, NONE);
    const back = reloadStep(first.state, texts(GOOD), CHECK, NONE);
    expect(back).toEqual({ state: start, action: { kind: "none" } });
    expect(reloadStep(back.state, texts(BAD), CHECK, NONE).action.kind).toBe("refused");
  });

  it("sees a read error as a change, and refuses a missing file", () => {
    const step = reloadStep(start, { config: { code: "ENOENT" }, secrets: { text: KEYS } }, CHECK, NONE);
    expect(step.action).toEqual({ kind: "refused", problems: ["The configuration file cannot be read (ENOENT)."] });
  });

  it("gives the problems of the check of the instance", () => {
    const check: InstanceCheck = { channels: [CHANNEL], problems: () => ["The file secrets.env has no PING_URL."] };
    expect(reloadStep(start, texts(OTHER), check, NONE).action).toEqual({ kind: "refused", problems: ["The file secrets.env has no PING_URL."] });
  });

  it("restarts for a new text of the request with no check, also when the files have problems", () => {
    const refusing: InstanceCheck = { channels: [CHANNEL], problems: () => ["The check refuses each file."] };
    const requested = { kind: "restart", cause: "requested" };
    expect(reloadStep(start, texts(GOOD), refusing, { text: "token 1\n" }).action).toEqual(requested);
    expect(reloadStep(start, texts(BAD), CHECK, { text: "token 1\n" }).action).toEqual(requested);
    // A second request replaces the request of the start.
    const later: ReloadState = { ...start, request: requestKey({ text: "token 1\n" }) };
    expect(reloadStep(later, texts(GOOD), CHECK, { text: "token 2\n" }).action).toEqual(requested);
  });

  it("gives no restart for the request of the start, or for a read error of the request", () => {
    const later: ReloadState = { ...start, request: requestKey({ text: "token 1\n" }) };
    expect(reloadStep(later, texts(GOOD), CHECK, { text: "token 1\n" })).toEqual({ state: later, action: { kind: "none" } });
    // A busy file or a removed file does not stop the runtime.
    expect(reloadStep(later, texts(GOOD), CHECK, { code: "EBUSY" })).toEqual({ state: later, action: { kind: "none" } });
    expect(reloadStep(later, texts(GOOD), CHECK, NONE)).toEqual({ state: later, action: { kind: "none" } });
  });
});

describe("reloadHook", () => {
  let home = "";
  let files: PrivateFiles;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), `alerts-hook-${PRIVATE}-`));
    files = privateFiles(home, join(home, "config.json"));
    await write(files.secrets, KEYS);
    await write(files.config, GOOD);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const hookOf = async (): Promise<{ hook: ReturnType<typeof reloadHook>; restarts: RestartCause[]; refused: (readonly string[])[] }> => {
    const restarts: RestartCause[] = [];
    const refused: (readonly string[])[] = [];
    const hook = reloadHook({
      files,
      check: CHECK,
      started: await readPrivateTexts(files),
      request: await readRestartRequest(files),
      restart: (cause) => restarts.push(cause),
      onRefused: (problems) => refused.push(problems),
    });
    return { hook, restarts, refused };
  };

  it("restarts one time for a new restart request, also when config.json has problems", async () => {
    const { hook, restarts, refused } = await hookOf();
    await write(files.config, BAD);
    await write(files.request, "token 1\n");
    for (let pass = 0; pass < 2; pass += 1) {
      hook.onPass();
      await hook.idle();
    }
    expect(restarts).toEqual(["requested"]);
    expect(refused).toEqual([]);
  });

  it("does nothing while the files stay the same", async () => {
    const { hook, restarts, refused } = await hookOf();
    hook.onPass();
    await hook.idle();
    expect(restarts).toEqual([]);
    expect(refused).toEqual([]);
  });

  it("restarts one time for a good change, also after more passes", async () => {
    const { hook, restarts } = await hookOf();
    await write(files.config, OTHER);
    hook.onPass();
    await hook.idle();
    hook.onPass();
    await hook.idle();
    expect(restarts).toEqual(["changed"]);
  });

  it("gives the problems of a bad change one time, and keeps running", async () => {
    const { hook, restarts, refused } = await hookOf();
    await write(files.config, BAD);
    for (let pass = 0; pass < 3; pass += 1) {
      hook.onPass();
      await hook.idle();
    }
    expect(restarts).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused.join("\n")).not.toContain(PRIVATE);
    // A good change after it restarts the runtime.
    await write(files.config, OTHER);
    hook.onPass();
    await hook.idle();
    expect(restarts).toEqual(["changed"]);
  });

  it("has one read in flight: a pass during a read starts no second read", async () => {
    const { hook, restarts } = await hookOf();
    await write(files.config, OTHER);
    hook.onPass();
    hook.onPass();
    await hook.idle();
    expect(restarts).toEqual(["changed"]);
  });

  it("gives a problem with no private text when the restart throws, and does not throw", async () => {
    const refused: (readonly string[])[] = [];
    const hook = reloadHook({
      files,
      check: CHECK,
      started: await readPrivateTexts(files),
      request: await readRestartRequest(files),
      restart: () => {
        throw new Error(PRIVATE);
      },
      onRefused: (problems) => refused.push(problems),
    });
    await write(files.config, OTHER);
    hook.onPass();
    await hook.idle();
    expect(refused).toEqual([["The check of the private files failed (Error)."]]);
  });
});

describe("requestRestart", () => {
  let home = "";
  let files: PrivateFiles;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), `alerts-restart-${PRIVATE}-`));
    files = privateFiles(home, join(home, "config.json"));
    await write(files.secrets, KEYS);
    await write(files.config, GOOD);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const OPTIONS = { check: CHECK, waitMs: 10_000, pollMs: 1000 };

  // Fake ports on a fake clock. Each read of the process ID takes the next value of `pids`, and the last value stays.
  const portsOf = (pids: readonly (number | undefined)[], ready: (call: number) => boolean): { ports: RestartPorts; writes: [string, string][]; reads: () => number } => {
    let time = 0;
    let read = 0;
    let probes = 0;
    const writes: [string, string][] = [];
    const ports: RestartPorts = {
      write: async (path, text) => {
        writes.push([path, text]);
      },
      pid: async () => pids[Math.min(read++, pids.length - 1)],
      ready: async () => ready(probes++),
      sleep: async (ms) => {
        time += ms;
      },
      now: () => time,
      token: () => "token 1",
    };
    return { ports, writes, reads: () => read };
  };

  it("refuses files with problems before it writes a request, and gives no private value", async () => {
    await write(files.config, BAD);
    const { ports, writes, reads } = portsOf([10], () => true);
    const outcome = await requestRestart({ files, ...OPTIONS }, ports);
    expect(outcome.kind).toBe("refused");
    expect(JSON.stringify(outcome)).not.toContain(PRIVATE);
    expect(writes).toEqual([]);
    expect(reads()).toBe(0);
  });

  it("writes no request when no runtime runs", async () => {
    const { ports, writes } = portsOf([undefined], () => true);
    expect(await requestRestart({ files, ...OPTIONS }, ports)).toEqual({ kind: "no-runtime" });
    expect(writes).toEqual([]);
  });

  it("writes a new request, then waits for a new process and its readiness", async () => {
    // The old process stays, then the discovery file has no process, then the new process starts. Its first probe fails.
    const { ports, writes } = portsOf([10, 10, undefined, 11], (call) => call > 0);
    expect(await requestRestart({ files, ...OPTIONS }, ports)).toEqual({ kind: "restarted", from: 10, to: 11, ready: true });
    expect(writes).toEqual([[files.request, "token 1\n"]]);
  });

  it("gives a restart that is not ready when the new process does not pass the probe in the wait", async () => {
    const { ports } = portsOf([10, 11], () => false);
    expect(await requestRestart({ files, ...OPTIONS }, ports)).toEqual({ kind: "restarted", from: 10, to: 11, ready: false });
  });

  it("gives no restart when the process stays the same for the whole wait", async () => {
    const { ports, reads } = portsOf([10], () => true);
    expect(await requestRestart({ files, ...OPTIONS }, ports)).toEqual({ kind: "no-restart", pid: 10 });
    // One read before the request, and one read at each poll of the wait.
    expect(reads()).toBe(1 + OPTIONS.waitMs / OPTIONS.pollMs);
  });
});
