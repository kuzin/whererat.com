/**
 * One-off: replace any legacy plaintext `accounts.password_hash` values with
 * scrypt hashes, so plaintext passwords stop sitting in the database.
 *
 * The app already upgrades an account the first time its owner logs in; this just
 * does it for everyone at once. Safe to re-run (hashed rows are skipped).
 *
 *   yarn passwords:hash            # dry run: lists accounts that would change
 *   yarn passwords:hash --apply    # writes, in one transaction
 *
 * Every new hash is verified against the original password before anything is
 * committed; any mismatch aborts the whole run with nothing changed.
 */
import "./load-env";
import { closeDbPool, getDbPool } from "../src/lib/db";
import { hashPassword, isPasswordHashed, verifyPassword } from "../src/lib/password-hash";

async function main() {
  const apply = process.argv.includes("--apply");
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string; username: string; password_hash: string }>(
      `select id, username, password_hash from accounts order by username for update`,
    );
    const legacy = rows.filter((r) => !isPasswordHashed(r.password_hash));
    console.log(`${rows.length} account(s); ${legacy.length} still hold a plaintext password.`);

    for (const row of legacy) {
      const plain = row.password_hash;
      // Accounts created before the 200-char cap can't be hashed; leave them for a manual reset.
      let hash: string;
      try {
        hash = await hashPassword(plain);
      } catch {
        console.warn(`  skip  ${row.username}: password not hashable (empty or longer than 200 chars) — reset it manually`);
        continue;
      }
      if (!(await verifyPassword(plain, hash))) {
        throw new Error(`Verification failed for "${row.username}"; aborting, nothing changed.`);
      }
      console.log(`  ${apply ? "hash" : "would hash"}  ${row.username}`);
      if (apply) {
        const result = await client.query(
          `update accounts set password_hash = $3, updated_at = now()
           where id = $1 and password_hash = $2`,
          [row.id, plain, hash],
        );
        if (result.rowCount !== 1) throw new Error(`"${row.username}" changed during the run; aborting.`);
      }
    }

    if (apply) {
      await client.query("commit");
      console.log("Committed.");
    } else {
      await client.query("rollback");
      console.log("Dry run only. Re-run with --apply to write.");
    }
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
    await closeDbPool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
