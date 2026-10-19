import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "api/**/*.test.ts"],
    environment: "node",
    coverage: {
      // On for `npm test` (`--coverage`), so running one test file does not fail the floor.
      enabled: false,
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "api/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary"],
      // The floor is the coverage on 2026-10-19. Raise it as tests are added; never lower it.
      thresholds: { statements: 52, branches: 47, functions: 50, lines: 55 },
    },
  },
});
