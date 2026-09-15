import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "pnpm --filter @moneygame/web dev",
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
});
