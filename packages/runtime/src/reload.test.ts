import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FORMAT, type AlertConfig, type ChannelDescriptor, type ChannelId, type PersonId, type PlaceId } from "@mark1russell7/alerts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigRefused, type InstanceCheck, type PrivateTexts } from "./config.ts";
import { GOOD_CONFIG_FILE, privateFiles, readPrivateTexts, reloadHook, reloadStep, startConfig, textsKey, type PrivateFiles, type ReloadState } from "./reload.ts";

const PUSHOVER = "pushover" as ChannelId;
const PERSON = "person:a" as PersonId;

const CHANNEL: ChannelDescriptor = {
  id: PUSHOVER,
  title: "Pushover",
  dependsOn: ["provider:pushover"],
  uses: ["internet", "power"],
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
  const start: ReloadState = { started: textsKey(texts(GOOD)) };

  it("gives no action for the texts of the start", () => {
    expect(reloadStep(start, texts(GOOD), CHECK)).toEqual({ state: start, action: { kind: "none" } });
  });

  it("restarts for a change of either file that passes the check", () => {
    expect(reloadStep(start, texts(OTHER), CHECK).action).toEqual({ kind: "restart" });
    expect(reloadStep(start, texts(GOOD, `${KEYS}OTHER=value\n`), CHECK).action).toEqual({ kind: "restart" });
  });

  it("gives the problems of a bad change one time", () => {
    const first = reloadStep(start, texts(BAD), CHECK);
    expect(first.action.kind).toBe("refused");
    expect(first.state.refused).toBe(textsKey(texts(BAD)));
    expect(reloadStep(first.state, texts(BAD), CHECK)).toEqual({ state: first.state, action: { kind: "none" } });
  });

  it("checks a second bad change, and restarts for a good change after a bad one", () => {
    const first = reloadStep(start, texts(BAD), CHECK);
    expect(reloadStep(first.state, texts(BAD, "OTHER=value\n"), CHECK).action.kind).toBe("refused");
    expect(reloadStep(first.state, texts(OTHER), CHECK).action).toEqual({ kind: "restart" });
  });

  it("clears the refusal after a return to the texts of the start", () => {
    const first = reloadStep(start, texts(BAD), CHECK);
    const back = reloadStep(first.state, texts(GOOD), CHECK);
    expect(back).toEqual({ state: start, action: { kind: "none" } });
    expect(reloadStep(back.state, texts(BAD), CHECK).action.kind).toBe("refused");
  });

  it("sees a read error as a change, and refuses a missing file", () => {
    const step = reloadStep(start, { config: { code: "ENOENT" }, secrets: { text: KEYS } }, CHECK);
    expect(step.action).toEqual({ kind: "refused", problems: ["The configuration file cannot be read (ENOENT)."] });
  });

  it("gives the problems of the check of the instance", () => {
    const check: InstanceCheck = { channels: [CHANNEL], problems: () => ["The file secrets.env has no PING_URL."] };
    expect(reloadStep(start, texts(OTHER), check).action).toEqual({ kind: "refused", problems: ["The file secrets.env has no PING_URL."] });
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

  const hookOf = async (): Promise<{ hook: ReturnType<typeof reloadHook>; restarts: number[]; refused: (readonly string[])[] }> => {
    const restarts: number[] = [];
    const refused: (readonly string[])[] = [];
    const hook = reloadHook({ files, check: CHECK, started: await readPrivateTexts(files), restart: () => restarts.push(1), onRefused: (problems) => refused.push(problems) });
    return { hook, restarts, refused };
  };

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
    expect(restarts).toEqual([1]);
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
    expect(restarts).toEqual([1]);
  });

  it("has one read in flight: a pass during a read starts no second read", async () => {
    const { hook, restarts } = await hookOf();
    await write(files.config, OTHER);
    hook.onPass();
    hook.onPass();
    await hook.idle();
    expect(restarts).toEqual([1]);
  });

  it("gives a problem with no private text when the restart throws, and does not throw", async () => {
    const refused: (readonly string[])[] = [];
    const hook = reloadHook({
      files,
      check: CHECK,
      started: await readPrivateTexts(files),
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
