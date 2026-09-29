import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Live multi-browser runs need the Worker: see playwright.live.config.ts.
  testIgnore: ["live/**"],
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
  },
  // QA-008: CI also runs Firefox and WebKit (Safari engine); Edge is Chromium.
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    ...(process.env.CROSS_BROWSER === "1"
      ? [{ name: "firefox", use: { browserName: "firefox" as const } }, { name: "webkit", use: { browserName: "webkit" as const } }]
      : []),
  ],
  webServer: {
    command: "pnpm --filter @moneygame/web dev",
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
});
