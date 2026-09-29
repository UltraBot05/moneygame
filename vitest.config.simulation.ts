import { defineConfig } from "vitest/config";

// QA-011 / GRAND-004: long production-path economy runs, kept out of `pnpm test`.
export default defineConfig({
  test: {
    include: ["scripts/*.sim.ts"],
    testTimeout: 0,
  },
});
