import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const site = process.env["SITE_BASE"];
const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

// Two pages: the demo (index.html), and the local page (local.html) that the runtime on this computer serves.
export default defineConfig({
  base: site ? `${site.replace(/\/$/, "")}/` : "/",
  build: { target: "es2022", rollupOptions: { input: { index: page("index.html"), local: page("local.html") } } },
});
