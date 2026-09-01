import { defineConfig } from "vitest/config";

// Root test config. Tests live in package source and run in the default (node)
// environment, which suits the pure game-core logic; a jsdom project can be
// added when UI tests arrive.
export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "app/worker/src/**/*.test.ts",
    ],
  },
});
