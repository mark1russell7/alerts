import { themeScript } from "@mark1russell7/site-pages/vite";
import { describe, expect, it } from "vitest";
import { serveTheme, THEME_FILE, themeCode, themeFile, themeTag, type ThemeResponse } from "../theme-file.ts";

// A hook of a Vite plugin is a function or an object with a handler. The test calls the function.
const call = (hook: unknown, self: unknown, ...args: unknown[]): unknown => {
  const handler = typeof hook === "function" ? hook : (hook as { handler: (...values: unknown[]) => unknown }).handler;
  return handler.apply(self, args);
};

const recorder = (): ThemeResponse & { headers: Record<string, string>; body?: string } => {
  const response: ThemeResponse & { headers: Record<string, string>; body?: string } = {
    headers: {},
    setHeader(name, value) {
      response.headers[name] = value;
    },
    end(body) {
      response.body = body;
    },
  };
  return response;
};

describe("themeFile", () => {
  it("gives the theme script of site-pages as the text of the file", () => {
    expect(themeCode("theme")).toBe(`${themeScript("theme")}\n`);
    // The file is a classic script: no import and no export.
    expect(themeCode("theme")).not.toMatch(/\b(import|export)\b/);
  });

  it("adds a classic script element with the base of the site to the head of each page", () => {
    expect(themeTag("/")).toEqual({ tag: "script", attrs: { src: `/${THEME_FILE}` }, injectTo: "head" });
    expect(themeTag("/alerts/").attrs).toEqual({ src: "/alerts/theme.js" });
    const plugin = themeFile("theme");
    call(plugin.configResolved, plugin, { base: "/alerts/" });
    expect(call(plugin.transformIndexHtml, plugin)).toEqual([themeTag("/alerts/")]);
  });

  it("emits the file in the root of the build", () => {
    const plugin = themeFile("theme");
    const files: unknown[] = [];
    call(plugin.generateBundle, { emitFile: (file: unknown) => files.push(file) });
    expect(files).toEqual([{ type: "asset", fileName: THEME_FILE, source: themeCode("theme") }]);
  });

  it("serves the file in the dev server, and gives each other request to the next part", () => {
    const code = themeCode("theme");
    const response = recorder();
    expect(serveTheme("/", code, { url: "/theme.js?t=1" }, response)).toBe(true);
    expect(response.headers).toEqual({ "Content-Type": "text/javascript; charset=utf-8" });
    expect(response.body).toBe(code);
    const other = recorder();
    expect(serveTheme("/", code, { url: "/local.html" }, other)).toBe(false);
    expect(serveTheme("/alerts/", code, { url: "/theme.js" }, other)).toBe(false);
    expect(serveTheme("/", code, {}, other)).toBe(false);
    expect(other.body).toBeUndefined();
  });
});
