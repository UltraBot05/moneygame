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
);
