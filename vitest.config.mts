import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/app/api/v1/**/*.ts",
        "src/lib/api-v1/**/*.ts",
        "src/lib/public-sighting-submit.ts",
        "src/lib/whererat.ts",
      ],
      thresholds: {
        lines: 79,
        functions: 80,
        branches: 70,
        statements: 77,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
