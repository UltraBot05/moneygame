import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Single flat config for the whole workspace. Non-type-checked TS rules keep it
// fast; React-hooks rules apply only to the web app.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.wrangler/**",
      "app/worker/worker-configuration.d.ts",
      "app/worker/scripts/**",
      "scripts/**",
      // Claude Design deliverables: static .dc.html mockups + a generated browser
      // runtime bundle (docs/support.js). Design artifacts, not app source.
      "docs/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["app/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
  },

  // GOV-005 — cross-layer dependency boundary enforcement.
  // game-core: pure TypeScript, no framework/runtime imports.
  {
    files: ["packages/game-core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["react", "react-dom", "react/*", "react-dom/*"], message: "game-core must not import React (ARCHITECTURE.md §5)" },
          { group: ["@cloudflare/*", "wrangler", "wrangler/*"], message: "game-core must not import Cloudflare/wrangler" },
          { group: ["@moneygame/web", "@moneygame/web/**", "@moneygame/worker", "@moneygame/worker/**"], message: "game-core must not import app packages" },
          { group: ["../**/app/worker/**", "../**/app/worker", "../**/app/web/**", "../**/app/web"], message: "game-core must not import app implementations via relative path" },
        ],
      }],
    },
  },
  // shared: transport/framework-agnostic protocol definitions.
  {
    files: ["packages/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["react", "react-dom", "react/*", "react-dom/*"], message: "shared must not import React" },
          { group: ["@cloudflare/*", "wrangler", "wrangler/*"], message: "shared must not import Cloudflare/wrangler" },
          { group: ["@moneygame/web", "@moneygame/web/**", "@moneygame/worker", "@moneygame/worker/**"], message: "shared must not import app packages" },
          { group: ["../**/app/worker/**", "../**/app/worker", "../**/app/web/**", "../**/app/web"], message: "shared must not import app implementations via relative path" },
        ],
      }],
    },
  },
  // web: cannot import Worker internals.
  {
    files: ["app/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@moneygame/worker", "@moneygame/worker/**"], message: "web must not import Worker package" },
          { group: ["wrangler", "wrangler/*", "@cloudflare/*"], message: "web must not import Cloudflare/wrangler" },
          { group: ["../**/worker/**", "../**/worker"], message: "web must not import Worker via relative path" },
        ],
      }],
    },
  },
  // worker: cannot import React/web.
  {
    files: ["app/worker/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["react", "react-dom", "react/*", "react-dom/*"], message: "Worker must not import React" },
          { group: ["@moneygame/web", "@moneygame/web/**"], message: "Worker must not import web package" },
          { group: ["../**/web/**", "../**/web"], message: "Worker must not import web via relative path" },
        ],
      }],
    },
  },
);
