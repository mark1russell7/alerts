import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PAGE_BUILD, PAGE_INDEX, pageFolder, pageStateOf, pageWarning, readPageState } from "./api.ts";

describe("the state of the built local page", () => {
  it("gives missing with no index file, stale with a newer source file, and current in each other case", () => {
    expect(pageStateOf(undefined, [])).toBe("missing");
    expect(pageStateOf(undefined, [5])).toBe("missing");
    expect(pageStateOf(10, [])).toBe("current");
    expect(pageStateOf(10, [3, 10])).toBe("current");
    expect(pageStateOf(10, [3, 11])).toBe("stale");
  });

  it("gives a warning with the build command for a missing or a stale page, and no warning for a current page", () => {
    expect(pageWarning("missing")).toContain("404");
    expect(pageWarning("missing")).toContain(PAGE_BUILD);
    expect(pageWarning("stale")).toContain(PAGE_BUILD);
    expect(pageWarning("current")).toBeUndefined();
  });

  describe("the read in a checkout", () => {
    const folders: string[] = [];
    afterEach(async () => {
      await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
    });

    /** This function makes a checkout with a core source file and the site files. It gives the folder `packages/runtime`. */
    async function checkout(): Promise<{ root: string; packages: string }> {
      const top = await mkdtemp(join(tmpdir(), "alerts-page-state-"));
      folders.push(top);
      const packages = join(top, "packages");
      const root = join(packages, "runtime");
      for (const folder of [join(root, "src"), join(packages, "core", "src", "deep"), join(packages, "site", "src"), join(packages, "site", "node_modules", "x")]) {
        await mkdir(folder, { recursive: true });
      }
      await writeFile(join(packages, "core", "src", "deep", "view.ts"), "export {};\n");
      await writeFile(join(packages, "site", "local.html"), "<!doctype html>\n");
      await writeFile(join(packages, "site", "src", "local.ts"), "export {};\n");
      await writeFile(join(packages, "site", "node_modules", "x", "index.js"), "\n");
      return { root, packages };
    }

    const at = (seconds: number): Date => new Date(Date.UTC(2026, 10, 17, 12, 0, seconds));

    /** This function sets the time of each file of the checkout, then the time of the files that the map names. */
    async function times(packages: string, base: number, newer: Readonly<Record<string, number>> = {}): Promise<void> {
      const files = ["core/src/deep/view.ts", "site/local.html", "site/src/local.ts", "site/node_modules/x/index.js"];
      for (const file of files) await utimes(join(packages, file), at(base), at(newer[file] ?? base));
    }

    it("gives missing when the page has no build", async () => {
      const { root } = await checkout();
      expect(await readPageState(root)).toBe("missing");
    });

    it("gives current when the build is newer than each source file", async () => {
      const { root, packages } = await checkout();
      await times(packages, 0);
      await mkdir(pageFolder(root), { recursive: true });
      await writeFile(join(pageFolder(root), PAGE_INDEX), "<!doctype html>\n");
      await utimes(join(pageFolder(root), PAGE_INDEX), at(10), at(10));
      expect(await readPageState(root)).toBe("current");
    });

    it("gives stale when a source file in a deep folder of a bundled package is newer than the build", async () => {
      const { root, packages } = await checkout();
      await times(packages, 0, { "core/src/deep/view.ts": 20 });
      await mkdir(pageFolder(root), { recursive: true });
      await writeFile(join(pageFolder(root), PAGE_INDEX), "<!doctype html>\n");
      await utimes(join(pageFolder(root), PAGE_INDEX), at(10), at(10));
      expect(await readPageState(root)).toBe("stale");
    });

    it("gives stale for a newer HTML file of the site, and current for a newer file of node_modules", async () => {
      const { root, packages } = await checkout();
      await mkdir(pageFolder(root), { recursive: true });
      await writeFile(join(pageFolder(root), PAGE_INDEX), "<!doctype html>\n");
      await utimes(join(pageFolder(root), PAGE_INDEX), at(10), at(10));
      await times(packages, 0, { "site/node_modules/x/index.js": 30 });
      expect(await readPageState(root)).toBe("current");
      await times(packages, 0, { "site/local.html": 30 });
      expect(await readPageState(root)).toBe("stale");
    });
  });
});
