import { defineConfig } from "vitest/config";

// Single source of test config for the monorepo. GOV-001 is bootstrap only, so
// there is no game logic to test yet; the runner still runs green so the
// `pnpm test` check is wired for later tasks.
export default defineConfig({
  test: {
    projects: ["packages/*"],
    passWithNoTests: true,
  },
});
