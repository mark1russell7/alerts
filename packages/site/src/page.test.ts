import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const local = readFileSync(new URL("../local.html", import.meta.url), "utf8");
const SOURCES = readdirSync(new URL("./", import.meta.url)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
const read = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");
const code = SOURCES.map(read).join("\n");
// The local page reads the map from the runtime on this computer. Only its entry calls fetch.
const LOCAL_ENTRY = "local.ts";
const demoCode = SOURCES.filter((name) => name !== LOCAL_ENTRY)
  .map(read)
  .join("\n");

describe("the home page", () => {
  it("names the package and gives the install command", () => {
    expect(page).toContain("<title>alerts</title>");
    expect(page).toContain("git clone https://github.com/mark1russell7/alerts.git");
  });

  it("links to the pages of site-pages and to the repository", () => {
    expect(page).toContain('href="./releases/"');
    expect(page).toContain('href="./status/"');
    expect(page).toContain('href="https://github.com/mark1russell7/alerts"');
  });

  it("has each part of the demo", () => {
    for (const id of ["demo", "clock", "back", "play", "next", "rail", "story", "globe", "map", "globe-tools", "words", "whole", "levels", "sources", "incidents", "message"]) {
      expect(page).toContain(`id="${id}"`);
    }
  });
});

describe("the code of the demo", () => {
  it("makes no network call: it only reads the files of the site", () => {
    expect(SOURCES.length).toBeGreaterThan(3);
    expect(SOURCES).toContain(LOCAL_ENTRY);
    for (const call of ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import("]) expect(demoCode).not.toContain(call);
  });

  it("reads no configuration from the address of the page", () => {
    for (const read of ["location.search", "location.hash", "URLSearchParams"]) expect(code).not.toContain(read);
  });
});

describe("the local page", () => {
  const entry = read(LOCAL_ENTRY);

  it("has each part of the page, and asks the search engines not to list it", () => {
    for (const id of ["theme", "read", "problem", "globe", "map", "globe-tools", "words", "whole", "incidents", "unshaped"]) expect(local).toContain(`id="${id}"`);
    expect(local).toContain('<meta name="robots" content="noindex">');
    expect(local).toContain('<script type="module" src="./src/local.ts"></script>');
  });

  it("calls fetch once, with the path of readMap, and names no URL with a host", () => {
    expect(entry.split("fetch(")).toHaveLength(2);
    expect(entry).toContain("readMap((path) => fetch(path, {");
    for (const text of [entry, read("map-read.ts"), read("map-view.ts"), read("globe-view.ts"), read("globe-stage.ts"), local]) expect(text).not.toMatch(/https?:|\/\/[a-z0-9.-]+[.:]/i);
    for (const call of ["XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import("]) expect(entry).not.toContain(call);
  });

  it("has no inline script and no inline style, because the runtime serves each page with a policy that refuses them", () => {
    for (const html of [page, local]) {
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)];
      expect(scripts.length).toBeGreaterThan(0);
      for (const [, attributes, body] of scripts) {
        expect(attributes).toMatch(/\ssrc="/);
        expect(body?.trim()).toBe("");
      }
      expect(html).not.toMatch(/\sstyle="|\son[a-z]+="|<style/i);
      // The plugin themeFile adds the theme script to the head of each page, thus the page itself has no theme script.
      expect(html).not.toContain("theme.js");
    }
    // The plugin and the theme button of each page use one key.
    expect(readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8")).toContain('plugins: [themeFile("theme")]');
    for (const name of ["index.ts", LOCAL_ENTRY]) expect(read(name)).toContain('setupTheme(byId<HTMLButtonElement>("theme"), "theme");');
  });
});
