/**
 * The Vite plugin of the theme before the first paint, as a file. The runtime serves each page with a policy that refuses
 * each inline script. Thus the inline script of `siteShell` of `@mark1russell7/site-pages/vite` cannot run on the local page.
 * This plugin gives the same `themeScript` as the file `theme.js`. When `siteShell` can give that file, the site uses
 * `siteShell` and this file goes.
 */

import { themeScript } from "@mark1russell7/site-pages/vite";
import type { HtmlTagDescriptor, Plugin } from "vite";

/** The name of the file of the theme script, in the root of the built site. */
export const THEME_FILE = "theme.js";

/** The request of the dev server that the plugin reads: only its address. */
export interface ThemeRequest {
  readonly url?: string | undefined;
}

/** The answer of the dev server that the plugin writes. */
export interface ThemeResponse {
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

/** This function gives the text of the file: the theme script of `site-pages`, and a line end. */
export function themeCode(storageKey: string): string {
  return `${themeScript(storageKey)}\n`;
}

/**
 * This function gives the script element of the file for the head of each page. The element is a classic script, because
 * a module script starts after the parse of the page, and thus after the first paint.
 */
export function themeTag(base: string): HtmlTagDescriptor {
  return { tag: "script", attrs: { src: `${base}${THEME_FILE}` }, injectTo: "head" };
}

/**
 * This function answers the request of the file in the dev server. It gives `false` for each other request, and the
 * next part of the server answers it.
 */
export function serveTheme(base: string, code: string, request: ThemeRequest, response: ThemeResponse): boolean {
  if (request.url?.split("?")[0] !== `${base}${THEME_FILE}`) return false;
  response.setHeader("Content-Type", "text/javascript; charset=utf-8");
  response.end(code);
  return true;
}

/**
 * This function makes the plugin. In a build, the plugin adds the file to the root of the site. In the dev server, it
 * serves the file. In each page, it adds the script element of the file to the head.
 */
export function themeFile(storageKey: string): Plugin {
  const code = themeCode(storageKey);
  let base = "/";
  return {
    name: "alerts-theme-file",
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!serveTheme(base, code, request, response)) next();
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: THEME_FILE, source: code });
    },
    transformIndexHtml() {
      return [themeTag(base)];
    },
  };
}
