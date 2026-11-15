import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const SOURCES = readdirSync(new URL("./", import.meta.url)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
const code = SOURCES.map((name) => readFileSync(new URL(name, import.meta.url), "utf8")).join("\n");

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
    for (const id of ["demo", "clock", "back", "play", "next", "rail", "story", "map", "levels", "sources", "incidents", "message"]) {
      expect(page).toContain(`id="${id}"`);
    }
  });
});

describe("the code of the demo", () => {
  it("makes no network call: it only reads the files of the site", () => {
    expect(SOURCES.length).toBeGreaterThan(3);
    for (const call of ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import("]) expect(code).not.toContain(call);
  });

  it("reads no configuration from the address of the page", () => {
    for (const read of ["location.search", "location.hash", "URLSearchParams"]) expect(code).not.toContain(read);
  });
});
