import { defineConfig } from "@playwright/test";

/**
 * QA-012 live browser E2E: real Worker + Durable Objects + local D1 under `wrangler dev`, serving
 * the built web app on one origin. Sign-in uses the localhost-only test route, enabled here by
 * E2E_TEST_LOGIN. Run with `pnpm test:e2e:live` (builds and migrates first).
 */
export default defineConfig({
  testDir: "./e2e/live",
  retries: 0,
  timeout: 10 * 60_000,
  // A blocked click should fail the run quickly, not wait for the whole test timeout.
  use: { baseURL: "http://127.0.0.1:8787", actionTimeout: 15_000 },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "pnpm --filter @moneygame/worker exec wrangler dev --port 8787 --ip 127.0.0.1"
      + " --var SESSION_SECRET:e2e-local-session-secret-0123456789 --var E2E_TEST_LOGIN:1 --var GOOGLE_CLIENT_SECRET:unused",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
