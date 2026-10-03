/**
 * `yarn e2e [--no-build] [playwright args…]`
 *
 * Builds the production app against the throwaway database (unless --no-build),
 * then runs Playwright, which starts `next start` itself. Start the database first
 * with `yarn e2e:db:start` (CI provides it as a service).
 */
import { spawnSync } from "node:child_process";
import { serverEnv } from "../playwright.config";
import { E2E_DATABASE_URL } from "./config";
import { assertSafeE2EDatabase } from "./support/safety";

assertSafeE2EDatabase(E2E_DATABASE_URL);

const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const passthrough = args.filter((a) => a !== "--no-build");

const env = { ...process.env, ...serverEnv };

function run(command: string, commandArgs: string[]) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!noBuild) run("yarn", ["build"]);
run("yarn", ["playwright", "test", ...passthrough]);
