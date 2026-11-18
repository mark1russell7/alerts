import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // One call of priorsOf draws the bootstrap intervals over the whole committed rates file. It takes some seconds on a CI runner.
    testTimeout: 20_000,
  },
});
