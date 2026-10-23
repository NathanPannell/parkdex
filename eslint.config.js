import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output, generated and vendored files, and the native project are not linted.
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/.vercel/",
      "**/.wrangler/",
      "coverage/",
      "android/",
      "ios/",
      "public/",
      "operator/public/",
      "art-source/",
      "assets/",
      "database/",
      "docs/",
      "playwright-report/",
      "test-results/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // A leading underscore marks a parameter or binding that is unused on purpose, and rest
      // siblings are the usual way to omit a field from a copy.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      // Input sanitisers strip ASCII control characters with regular expressions on purpose.
      "no-control-regex": "off",
    },
  },
  {
    // Test doubles stand in for provider and platform objects that have no exported type, and
    // some capture `this` to assert the receiver a platform API was called with.
    files: ["**/*.test.ts", "**/*.test.mjs"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-this-alias": "off" },
  },
  {
    files: ["src/**/*.{ts,tsx}", "operator/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Off for now: 47 existing effects list their dependencies by hand, and adding the missing
      // ones changes when they run. Turn this on per screen as each one is reviewed.
      "react-hooks/exhaustive-deps": "off",
    },
  },
);
