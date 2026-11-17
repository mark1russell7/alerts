// The import boundaries of the workspace (@mark1russell7/boundaries): another package is imported only
// through an entry of its package.json. Start the check with `pnpm check:boundaries`.
import { boundaries, defaultOptions, type Config } from "@mark1russell7/boundaries";

// The default options exclude each path in node_modules, so no rule sees an import of a package. The walk
// still stops at node_modules, because the option doNotFollow of the defaults names it.
const exclude = defaultOptions(import.meta.dirname).exclude as { path: string[] };

const config: Config = boundaries(import.meta.dirname, {
  options: { exclude: { path: exclude.path.filter((path) => path !== "(^|/)node_modules/") } },
  forbidden: [
    {
      // A deploy installs only the dependencies (`pnpm install --prod`). On 2026-11-17 the second copy did not start,
      // because `runtime/src/reload.ts` imported a package of `devDependencies`. This rule stays until boundaries has it.
      name: "run-time-import-of-a-dev-dependency",
      severity: "error",
      comment:
        "A source file that is not a test imports a package of devDependencies. A production install does not have it. Move the package to dependencies.",
      // The site is not in the rule: vite puts each import of the site in its build, so a dev dependency is correct there.
      from: { path: "^packages/[^/]+/src/", pathNot: ["\\.test\\.ts$", "^packages/site/"] },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
  ],
});
export default config;
