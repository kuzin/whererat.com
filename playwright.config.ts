import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, E2E_DATABASE_URL, E2E_PORT, E2E_SESSION_SECRET } from "./e2e/config";
import { assertSafeE2EDatabase } from "./e2e/support/safety";

assertSafeE2EDatabase(E2E_DATABASE_URL);

/**
 * The server under test runs the PRODUCTION build against a throwaway local
 * database. Every DB variable is forced to it, and third-party services are blanked
 * (no e-mail, uploads, OMDb/TMDB) with WHERERAT_OFFLINE=1, so a run is hermetic and
 * can never touch real data even if the shell has real credentials exported.
 */
export const serverEnv = {
  DATABASE_URL: E2E_DATABASE_URL,
  POSTGRES_URL: E2E_DATABASE_URL,
  POSTGRES_PRISMA_URL: E2E_DATABASE_URL,
  DATABASE_URL_UNPOOLED: E2E_DATABASE_URL,
  SESSION_SECRET: E2E_SESSION_SECRET,
  MODERATOR_ADMIN_PASSWORD: "unused-seed-password",
  RESEND_API_KEY: "",
  BLOB_READ_WRITE_TOKEN: "",
  OMDB_API_KEY: "",
  TMDB_READ_ACCESS_TOKEN: "",
  CRON_SECRET: "e2e-cron-secret",
  S3_PUBLIC_BASE_URL: "",
  WHERERAT_OFFLINE: "1",
  PORT: String(E2E_PORT),
};

export default defineConfig({
  testDir: "./e2e/tests",
  globalSetup: "./e2e/global-setup.ts",
  // One shared database: tests run serially and each starts from a reset DB.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `yarn start -p ${E2E_PORT}`,
    url: `${BASE_URL}/api/health/db`,
    // Never silently reuse a server that might be pointed at a different database.
    reuseExistingServer: false,
    timeout: 120_000,
    env: serverEnv,
    stdout: "ignore",
    stderr: "pipe",
  },
});
