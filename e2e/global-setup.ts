import { readFile } from "node:fs/promises";
import path from "node:path";
import { E2E_DATABASE_URL } from "./config";
import { closeDb, db, resetDatabase } from "./support/db";
import { assertSafeE2EDatabase } from "./support/safety";

/** Applies db/schema.sql (idempotent) to the throwaway database and empties it. */
export default async function globalSetup() {
  assertSafeE2EDatabase(E2E_DATABASE_URL);
  const schema = await readFile(path.join(process.cwd(), "db", "schema.sql"), "utf8");
  try {
    await db().query(schema);
  } catch (error) {
    throw new Error(
      `Could not apply the schema to the e2e database. Is it running? Try \`yarn e2e:db:start\`.\n${String(error)}`,
    );
  }
  await resetDatabase();
  await closeDb();
}
