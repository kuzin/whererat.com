import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      // Server-side logic: shared libs plus API routes and server actions. UI
      // components and page JSX are covered by the Playwright e2e suite instead.
      include: [
        "src/lib/**/*.ts",
        "src/app/**/route.ts",
        "src/app/**/actions.ts",
      ],
      exclude: ["src/**/*.stories.*", "src/__tests__/**"],
      thresholds: {
        // Ratchet: set a few points under current coverage (88 / 87 / 84 / 88).
        lines: 85,
        functions: 84,
        branches: 80,
        statements: 85,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
