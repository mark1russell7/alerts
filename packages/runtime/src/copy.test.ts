import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COPY_FORMAT, ONLY_COPY, type CopySettings } from "@mark1russell7/alerts";
import { afterEach, describe, expect, it } from "vitest";
import { COPY_FILE, copySettings, readCopySettings } from "./copy.ts";

// The settings of a copy with rank 1. The addresses are fake.
const CLOUD: CopySettings = { format: COPY_FORMAT, id: "cloud", rank: 1, listen: { host: "cloud.example", port: 4751 }, peers: [{ id: "home", url: "http://home.example:4751" }] };

let folders: string[] = [];

afterEach(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  folders = [];
});

/** This function makes an empty private folder for one test. */
function folder(): string {
  const made = mkdtempSync(join(tmpdir(), "alerts-copy-"));
  folders.push(made);
  return made;
}

describe("the settings of the copy", () => {
  it("gives the only copy when the private folder has no copy.json", async () => {
    expect(copySettings({ code: "ENOENT" })).toEqual({ tag: "ok", value: ONLY_COPY });
    expect(await readCopySettings(folder())).toEqual({ tag: "ok", value: ONLY_COPY });
  });

  it("reads copy.json of the private folder", async () => {
    const home = folder();
    writeFileSync(join(home, COPY_FILE), JSON.stringify(CLOUD));
    expect(await readCopySettings(home)).toEqual({ tag: "ok", value: CLOUD });
  });

  it("stops the start at another read error and at each problem of the text, with no address, no URL and no path", async () => {
    expect(copySettings({ code: "EACCES" })).toEqual({ tag: "err", error: ["The file copy.json cannot be read (EACCES)."] });
    expect(copySettings({ text: "{" })).toEqual({ tag: "err", error: ["The file copy.json: The settings of the copy are not valid JSON."] });
    const home = folder();
    writeFileSync(join(home, COPY_FILE), JSON.stringify({ ...CLOUD, rank: 2, listen: { host: "0.0.0.0", port: 4751 } }));
    const read = await readCopySettings(home);
    expect(read.tag).toBe("err");
    const problems = read.tag === "err" ? read.error : [];
    expect(problems).toHaveLength(2);
    for (const problem of problems) {
      expect(problem).toMatch(/^The file copy\.json: /u);
      expect(problem).not.toContain("example");
      expect(problem).not.toContain(home);
    }
  });
});
