import { fileURLToPath } from "node:url";
import { siteBase } from "@mark1russell7/site-pages/vite";
import { defineConfig } from "vite";
import { themeFile } from "./theme-file.ts";

const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

// Two pages: the demo (index.html), and the local page (local.html) that the runtime on this computer serves.
// The key of the theme is the key that setupTheme of each page reads.
export default defineConfig({
  base: siteBase(),
  plugins: [themeFile("theme")],
  build: { target: "es2022", rollupOptions: { input: { index: page("index.html"), local: page("local.html") } } },
});
