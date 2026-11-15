import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_FORMAT, type AlertConfig, type ChannelDescriptor, type ChannelId, type PersonId, type PlaceId } from "@mark1russell7/alerts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertsHome, ConfigRefused, configPath, DEFAULT_ALERTS_HOME, envSecrets, fileSource, readConfig, requireConfig, type ConfigSource } from "./config.ts";

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

// A public place in Kansas, with a made-up label. The contact names a secret, not its value.
const CONFIG: AlertConfig = {
  format: CONFIG_FORMAT,
  places: [{ id: "place:a" as PlaceId, label: "Place A", codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 }],
  people: [{ watch: { person: PERSON, places: ["place:a" as PlaceId], rules: [] } }],
  contacts: [{ person: PERSON, channel: PUSHOVER, address: { user: { secret: "PUSHOVER_USER" } } }],
  policies: [{ level: "life-safety", steps: [{ channel: PUSHOVER, at: 0 }], exhaustedAfter: 600_000 }],
};

// The start of each private value. A check looks for it in each problem and each message.
const PRIVATE = "PRIVATE";
const SECRETS = envSecrets({ PUSHOVER_USER: `${PRIVATE}-user` });
const textSource = (text: string): ConfigSource => ({ name: "The test source", read: async () => text });

describe("alertsHome and configPath", () => {
  // Absolute paths on each system: on Windows, resolve adds the drive.
  const home = resolve("/home/a");
  const base = resolve("/work/b");

  it("give the folder .alerts in the home folder when the variable is not set or empty", () => {
    expect(DEFAULT_ALERTS_HOME).toBe("~/.alerts");
    expect(alertsHome({}, base, home)).toBe(join(home, ".alerts"));
    expect(alertsHome({ ALERTS_HOME: "" }, base, home)).toBe(join(home, ".alerts"));
    expect(configPath({}, base, home)).toBe(join(home, ".alerts", "config.json"));
  });

  it("expand a leading ~, and resolve a relative path against the base", () => {
    expect(alertsHome({ ALERTS_HOME: "~/private" }, base, home)).toBe(join(home, "private"));
    expect(configPath({ ALERTS_HOME: "test-home" }, base, home)).toBe(join(base, "test-home", "config.json"));
  });

  it("read only ALERTS_HOME, so a test folder holds each private file", () => {
    const test = resolve("/tmp/alerts-test");
    expect(configPath({ ALERTS_HOME: test, ALERTS_CONFIG: join(home, "real.json") }, base, home)).toBe(join(test, "config.json"));
  });
});

describe("envSecrets", () => {
  it("gives the value of a key, and no value for an empty or absent key", () => {
    const secret = envSecrets({ A: "a", EMPTY: "" });
    expect(secret("A")).toBe("a");
    expect(secret("EMPTY")).toBeUndefined();
    expect(secret("ABSENT")).toBeUndefined();
  });
});

describe("readConfig", () => {
  let folder = "";
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), `alerts-config-${PRIVATE}-`));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("reads and parses a file, and gives the recipients with the values of the secrets", async () => {
    const path = join(folder, "config.json");
    await writeFile(path, JSON.stringify(CONFIG), "utf8");
    const parsed = await readConfig(fileSource(path), [CHANNEL], SECRETS);
    expect(parsed.tag).toBe("ok");
    if (parsed.tag === "ok") {
      expect(parsed.value.config).toEqual(CONFIG);
      expect(parsed.value.recipients.map((recipient) => recipient.addresses)).toEqual([{ [PUSHOVER]: { user: `${PRIVATE}-user` } }]);
    }
  });

  it("gives the code of a file that cannot be read, and not its path", async () => {
    const parsed = await readConfig(fileSource(join(folder, "absent.json")), [CHANNEL], SECRETS);
    expect(parsed).toEqual({ tag: "err", error: ["The configuration file cannot be read (ENOENT)."] });
  });

  it("gives no code when the thrown value has no text code, and keeps no text of the thrown value", async () => {
    const failing: ConfigSource = { name: "The test source", read: () => Promise.reject(Object.assign(new Error(`${PRIVATE} text`), { code: `${PRIVATE} code` })) };
    expect(await readConfig(failing, [CHANNEL], SECRETS)).toEqual({ tag: "err", error: ["The test source cannot be read (no code)."] });
    const throwing: ConfigSource = {
      name: "The test source",
      read: () => {
        throw new Error(PRIVATE);
      },
    };
    expect(await readConfig(throwing, [CHANNEL], SECRETS)).toEqual({ tag: "err", error: ["The test source cannot be read (no code)."] });
  });

  it("gives the problems of the parse: the JSON, the form and the references", async () => {
    const problemsOf = async (text: string, secret = SECRETS): Promise<readonly string[]> => {
      const parsed = await readConfig(textSource(text), [CHANNEL], secret);
      return parsed.tag === "err" ? parsed.error : [];
    };
    expect(await problemsOf("{")).toEqual(["The configuration is not valid JSON."]);
    expect(await problemsOf(JSON.stringify({ ...CONFIG, extra: 1 }))).toHaveLength(1);
    expect(await problemsOf(JSON.stringify(CONFIG), envSecrets({}))).toEqual([expect.stringContaining("names the secret PUSHOVER_USER")]);
  });
});

describe("requireConfig", () => {
  it("gives the parsed configuration", async () => {
    const parsed = await requireConfig(textSource(JSON.stringify(CONFIG)), [CHANNEL], SECRETS);
    expect(parsed.config).toEqual(CONFIG);
  });

  it("throws ConfigRefused with each problem in the message, and no private value", async () => {
    const wrong = { ...CONFIG, format: `${PRIVATE}-format`, places: [{ ...CONFIG.places[0], label: [`${PRIVATE}-label`] }] };
    const thrown = await requireConfig(textSource(JSON.stringify(wrong)), [CHANNEL], SECRETS).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(ConfigRefused);
    if (!(thrown instanceof ConfigRefused)) return;
    expect(thrown.problems).toHaveLength(2);
    expect(thrown.message).toMatch(/^The runtime does not start\. The configuration has 2 problems:\n- /);
    for (const problem of thrown.problems) expect(thrown.message).toContain(`- ${problem}`);
    expect(thrown.message).not.toContain(PRIVATE);
  });

  it("says one problem in the singular", async () => {
    const thrown = await requireConfig(textSource("{"), [CHANNEL], SECRETS).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ConfigRefused);
    expect(thrown instanceof Error ? thrown.message : "").toBe("The runtime does not start. The configuration has 1 problem:\n- The configuration is not valid JSON.");
  });
});
