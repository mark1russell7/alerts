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
    expect(page).toContain("git clone https://github.com/metrograph-labs/alerts.git");
  });

  it("links to the pages of site-pages and to the repository", () => {
    expect(page).toContain('href="./releases/"');
    expect(page).toContain('href="./status/"');
    expect(page).toContain('href="https://github.com/metrograph-labs/alerts"');
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
    for (const call of ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon"]) expect(demoCode).not.toContain(call);
  });

  it("loads one file after its start: the code of the globe, which is a file of the site", () => {
    // The text has "import(" two times: the type of the module, and the load.
    expect(code.split("import(")).toHaveLength(3);
    expect(read("globe-load.ts").split('import("./globe-stage.ts")')).toHaveLength(3);
  });

  it("has the code of the globe in no file that a page loads at its start", () => {
    // A value that a file imports from these modules brings the code of the globe into the file.
    const GLOBE_CODE = /^import (?!type\b)[^;]*from "(?:\.\/globe-stage\.ts|@mark1russell7\/visuals\/(?:three|globe|labels)|three(?:\/[^"]*)?)";/m;
    expect('import { startGlobe } from "./globe-stage.ts";').toMatch(GLOBE_CODE);
    expect('import { createGlobe, type GlobeStyle } from "@mark1russell7/visuals/globe";').toMatch(GLOBE_CODE);
    expect('import type { GlobeArea, GlobePoint } from "@mark1russell7/visuals/globe";').not.toMatch(GLOBE_CODE);
    expect('import { stageSupported } from "@mark1russell7/visuals";').not.toMatch(GLOBE_CODE);
    // Only the module of the globe has it, and a page gets this module from the load.
    expect(SOURCES.filter((name) => GLOBE_CODE.test(read(name)))).toEqual(["globe-stage.ts"]);
  });

  it("reads no configuration from the address of the page", () => {
    for (const read of ["location.search", "location.hash", "URLSearchParams"]) expect(code).not.toContain(read);
  });
});

describe("the local page", () => {
  const entry = read(LOCAL_ENTRY);

  it("has each part of the page, and asks the search engines not to list it", () => {
    const ids = ["theme", "read", "brief", "problem", "globe", "map", "time", "past", "past-text", "now", "time-problem", "globe-tools", "words", "whole", "incidents", "unshaped", "sources-h", "health-past", "health-sum", "health-problem", "health", "health-hint"];
    for (const id of ids) expect(local).toContain(`id="${id}"`);
    // The link at the top goes to the panel of the sources on the same page.
    expect(local).toContain('<a id="brief" href="#sources-h">');
    expect(local).toContain('<meta name="robots" content="noindex">');
    expect(local).toContain('<script type="module" src="./src/local.ts"></script>');
  });

  it("calls fetch once, with the path of a reader, and names no URL with a host", () => {
    expect(entry.split("fetch(")).toHaveLength(2);
    // The readers of the map, of the history and of the health get this one function. Each gives it a path with no host.
    expect(entry).toContain("const get = (path: string): Promise<Response> => fetch(path, {");
    expect(entry).toContain("readMap(get)");
    expect(entry).toContain("readHistories(get, ");
    expect(entry).toContain("readHealth(get)");
    for (const text of [entry, read("map-read.ts"), read("history-read.ts"), read("health-read.ts"), read("health-view.ts"), read("health-look.ts"), read("scrub.ts"), read("map-view.ts"), read("globe-view.ts"), read("globe-stage.ts"), read("globe-load.ts"), local]) expect(text).not.toMatch(/https?:|\/\/[a-z0-9.-]+[.:]/i);
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
