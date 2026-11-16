import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_FORMAT, type AlertConfig, type ChannelDescriptor, type ChannelId, type PersonId, type PlaceId } from "@mark1russell7/alerts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alertsHome,
  checkConfig,
  checkTexts,
  ConfigRefused,
  configPath,
  DEFAULT_ALERTS_HOME,
  envSecrets,
  fileSource,
  parseSecrets,
  readText,
  requireKey,
  SECRETS_FILE,
  type ConfigSource,
  type InstanceCheck,
  type PrivateTexts,
} from "./config.ts";

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
// The check of an instance with the one channel and no problem of its own.
const CHECK: InstanceCheck = { channels: [CHANNEL], problems: () => [] };

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

describe("readText", () => {
  let folder = "";
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), `alerts-config-${PRIVATE}-`));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("gives the text of a source", async () => {
    const path = join(folder, "config.json");
    await writeFile(path, JSON.stringify(CONFIG), "utf8");
    expect(await readText(fileSource(path).read)).toEqual({ text: JSON.stringify(CONFIG) });
  });

  it("gives the code of a file that cannot be read, and not its path", async () => {
    const read = await readText(fileSource(join(folder, "absent.json")).read);
    expect(read).toEqual({ code: "ENOENT" });
  });

  it("gives no code when the thrown value has no text code, and keeps no text of the thrown value", async () => {
    expect(await readText(() => Promise.reject(Object.assign(new Error(`${PRIVATE} text`), { code: `${PRIVATE} code` })))).toEqual({ code: "no code" });
    const throwing = (): Promise<string> => {
      throw new Error(PRIVATE);
    };
    expect(await readText(throwing)).toEqual({ code: "no code" });
  });
});

describe("parseSecrets", () => {
  it("gives the keys of the text of secrets.env", () => {
    expect(parseSecrets({ text: `# a comment\nPUSHOVER_USER=${PRIVATE}-user\nEMPTY=\n` })).toEqual({ tag: "ok", value: { PUSHOVER_USER: `${PRIVATE}-user`, EMPTY: "" } });
  });

  it("gives the code of a read error", () => {
    expect(parseSecrets({ code: "ENOENT" })).toEqual({ tag: "err", error: ["The file secrets.env cannot be read (ENOENT)."] });
  });

  it("gives the problem of a bad line with its line and no value", () => {
    const parsed = parseSecrets({ text: `PUSHOVER_USER=${PRIVATE}-user\n${PRIVATE} no equals sign\n` });
    const problems = parsed.tag === "err" ? parsed.error : [];
    expect(problems).toEqual([expect.stringMatching(/^The file secrets\.env: .*2/)]);
    expect(problems.join("\n")).not.toContain(PRIVATE);
  });
});

describe("checkTexts", () => {
  const texts = (config: string, secrets = `PUSHOVER_USER=${PRIVATE}-user\n`): PrivateTexts => ({ config: { text: config }, secrets: { text: secrets } });

  it("gives the configuration, the recipients with the values of the secrets, and the keys", () => {
    const checked = checkTexts(texts(JSON.stringify(CONFIG)), CHECK);
    expect(checked.tag).toBe("ok");
    if (checked.tag !== "ok") return;
    expect(checked.value.parsed.config).toEqual(CONFIG);
    expect(checked.value.parsed.recipients.map((recipient) => recipient.addresses)).toEqual([{ [PUSHOVER]: { user: `${PRIVATE}-user` } }]);
    expect(checked.value.keys).toEqual({ PUSHOVER_USER: `${PRIVATE}-user` });
  });

  it("gives the problems of the parse: the JSON, the form and the references", () => {
    const problemsOf = (text: string, secrets?: string): readonly string[] => {
      const checked = checkTexts(texts(text, secrets), CHECK);
      return checked.tag === "err" ? checked.error : [];
    };
    expect(problemsOf("{")).toEqual(["The configuration is not valid JSON."]);
    expect(problemsOf(JSON.stringify({ ...CONFIG, extra: 1 }))).toHaveLength(1);
    expect(problemsOf(JSON.stringify(CONFIG), "OTHER=value\n")).toEqual([expect.stringContaining("names the secret PUSHOVER_USER")]);
  });

  it("gives the problems of secrets.env first, and then the read error of the configuration with its name", () => {
    expect(checkTexts({ config: { code: "ENOENT" }, secrets: { code: "EACCES" } }, CHECK)).toEqual({ tag: "err", error: ["The file secrets.env cannot be read (EACCES)."] });
    expect(checkTexts({ config: { code: "ENOENT" }, secrets: { text: "" } }, CHECK, "The test copy")).toEqual({ tag: "err", error: ["The test copy cannot be read (ENOENT)."] });
  });

  it("gives the problems of the instance after the check of the format, with the keys of secrets.env", () => {
    const seen: string[] = [];
    const check: InstanceCheck = {
      channels: [CHANNEL],
      problems: (parsed, secret) => (seen.push(`${parsed.config.places.length} ${secret("PUSHOVER_USER") === `${PRIVATE}-user`}`), ["No source covers the place place:a."]),
    };
    expect(checkTexts(texts(JSON.stringify(CONFIG)), check)).toEqual({ tag: "err", error: ["No source covers the place place:a."] });
    expect(seen).toEqual(["1 true"]);
    // A file with a bad format does not get the check of the instance.
    expect(checkTexts(texts("{"), check).tag).toBe("err");
    expect(seen).toHaveLength(1);
  });
});

describe("requireKey", () => {
  const check = requireKey(CHECK, "PING_URL", "The test needs it.");

  it("adds a problem when the file of keys has no value for the key", () => {
    const parsed = checkTexts({ config: { text: JSON.stringify(CONFIG) }, secrets: { text: `PUSHOVER_USER=${PRIVATE}-user\nPING_URL=\n` } }, CHECK);
    expect(parsed.tag).toBe("ok");
    if (parsed.tag !== "ok") return;
    expect(check.channels).toBe(CHECK.channels);
    expect(check.problems(parsed.value.parsed, SECRETS)).toEqual(["The file secrets.env has no PING_URL. The test needs it."]);
    expect(check.problems(parsed.value.parsed, envSecrets({ PING_URL: `${PRIVATE}-url` }))).toEqual([]);
  });
});

describe("checkConfig", () => {
  let home = "";
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), `alerts-secrets-${PRIVATE}-`));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const writeSecrets = (text: string): Promise<void> => writeFile(join(home, SECRETS_FILE), text, "utf8");

  it("checks a configuration with the keys of the private folder, as the start does", async () => {
    await writeSecrets(`PUSHOVER_USER=${PRIVATE}-user\n`);
    const checked = await checkConfig(textSource(JSON.stringify(CONFIG)), home, CHECK);
    expect(checked.tag === "ok" ? checked.value.config : undefined).toEqual(CONFIG);
  });

  it("refuses a configuration that names a key that secrets.env does not have", async () => {
    await writeSecrets("OTHER=value\n");
    expect(await checkConfig(textSource(JSON.stringify(CONFIG)), home, CHECK)).toEqual({ tag: "err", error: [expect.stringContaining("names the secret PUSHOVER_USER")] });
  });

  it("gives the name of the source and the code of its read error", async () => {
    await writeSecrets(`PUSHOVER_USER=${PRIVATE}-user\n`);
    expect(await checkConfig(fileSource(join(home, "absent.json")), home, CHECK)).toEqual({ tag: "err", error: ["The configuration file cannot be read (ENOENT)."] });
  });

  it("gives the problems of secrets.env before it reads the configuration", async () => {
    let reads = 0;
    const counted: ConfigSource = { name: "The test source", read: async () => ((reads += 1), JSON.stringify(CONFIG)) };
    const checked = await checkConfig(counted, join(home, "absent"), CHECK);
    expect(checked).toEqual({ tag: "err", error: ["The file secrets.env cannot be read (ENOENT)."] });
    expect(reads).toBe(0);
  });
});

describe("ConfigRefused", () => {
  it("lists each problem in the message", () => {
    const refused = new ConfigRefused(["The first problem.", "The second problem."]);
    expect(refused.name).toBe("ConfigRefused");
    expect(refused.problems).toEqual(["The first problem.", "The second problem."]);
    expect(refused.message).toBe("The runtime does not start. The configuration has 2 problems:\n- The first problem.\n- The second problem.");
  });

  it("says one problem in the singular", () => {
    expect(new ConfigRefused(["The configuration is not valid JSON."]).message).toBe("The runtime does not start. The configuration has 1 problem:\n- The configuration is not valid JSON.");
  });
});
