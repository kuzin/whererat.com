import { randomUUID } from "crypto";
import {
  createModeratorSession,
  getModeratorAccounts,
  SEEDED_MODERATOR_AVATAR_URL,
  type ModeratorAccount,
} from "@/lib/auth";
import { getDbPool, withTransaction } from "@/lib/db";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  needsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from "@/lib/password-hash";

/** An account as the app sees it: never carries the password or its hash. */
export type StoredAccount = Omit<ModeratorAccount, "password">;

const LEGACY_ADMIN_AVATAR_URL = "https://placehold.co/160x160/292524/fef3c7/png?text=Admin";

const ACCOUNT_COLUMNS = "id, username, display_name, email, avatar_url, role";

type AccountRow = {
  id: string;
  username: string;
  display_name: string;
  email: string;
  avatar_url: string;
  role: "owner" | "moderator";
};

async function ensureSeedAccounts() {
  const pool = getDbPool();
  const existing = await pool.query<{ count: string }>("select count(*)::text as count from accounts");
  if ((Number(existing.rows[0]?.count ?? "0") || 0) > 0) return;
  for (const account of getModeratorAccounts()) {
    await pool.query(
      `insert into accounts
        (id, username, display_name, email, avatar_url, role, password_hash)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        account.id,
        account.username,
        account.name,
        account.email,
        account.avatarUrl,
        account.role,
        await hashPassword(account.password),
      ],
    );
  }
}

function rowToAccount(row: AccountRow): StoredAccount {
  const avatarUrl =
    row.username === "admin" &&
      (!row.avatar_url || row.avatar_url === LEGACY_ADMIN_AVATAR_URL)
      ? SEEDED_MODERATOR_AVATAR_URL
      : row.avatar_url;

  return {
    id: row.id,
    username: row.username,
    name: row.display_name,
    email: row.email,
    avatarUrl,
    role: row.role,
  };
}

export async function readUserStore() {
  await ensureSeedAccounts();
  const pool = getDbPool();
  const result = await pool.query<AccountRow>(
    `select ${ACCOUNT_COLUMNS}
     from accounts
     order by username asc`,
  );
  return {
    version: 1,
    accounts: result.rows.map(rowToAccount),
  };
}

/**
 * Checks a username + password. Passwords are stored as scrypt hashes; an account
 * still holding a legacy plaintext value is accepted once and upgraded to a hash
 * in place. Unknown usernames cost the same CPU as a real check, so response time
 * doesn't reveal which usernames exist.
 */
export async function authenticateStoredModerator(
  username: string,
  password: string,
): Promise<StoredAccount | undefined> {
  await ensureSeedAccounts();
  const normalizedUsername = username.trim().toLowerCase();
  const pool = getDbPool();
  const result = await pool.query<AccountRow & { password_hash: string }>(
    `select ${ACCOUNT_COLUMNS}, password_hash from accounts where username = $1`,
    [normalizedUsername],
  );
  const row = result.rows[0];
  if (!row) {
    await verifyAgainstDummy(password);
    return undefined;
  }

  if (!(await verifyPassword(password, row.password_hash))) return undefined;

  if (needsRehash(row.password_hash)) {
    try {
      // Guarded on the old value so a concurrent password change is never overwritten.
      await pool.query(
        `update accounts set password_hash = $3, updated_at = now()
         where id = $1 and password_hash = $2`,
        [row.id, row.password_hash, await hashPassword(password)],
      );
    } catch (error) {
      // Logging in must not fail because the upgrade did; it retries next login.
      console.error("[user-store] could not upgrade password hash:", error);
    }
  }
  return rowToAccount(row);
}

/**
 * Current account behind a signed session cookie, or undefined if it was deleted.
 * A single primary-key read (no seeding), cheap enough to run on every request.
 */
export async function getAccountForSession(userId: string): Promise<StoredAccount | undefined> {
  const pool = getDbPool();
  const result = await pool.query<AccountRow>(
    `select ${ACCOUNT_COLUMNS} from accounts where id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return row ? rowToAccount(row) : undefined;
}

export async function getStoredModeratorById(userId: string) {
  const state = await readUserStore();

  return state.accounts.find((account) => account.id === userId);
}

export async function updateStoredModeratorProfile({
  userId,
  name,
  email,
  avatarUrl,
  role,
}: {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string;
  role: ModeratorAccount["role"];
}) {
  await ensureSeedAccounts();
  const pool = getDbPool();
  const updated = await pool.query<AccountRow>(
    `update accounts
        set display_name = $2,
            email = $3,
            avatar_url = $4,
            role = $5,
            updated_at = now()
      where id = $1
      returning ${ACCOUNT_COLUMNS}`,
    [userId, name, email, avatarUrl, role],
  );
  const updatedAccount = updated.rows[0];
  if (!updatedAccount) return undefined;
  const account = rowToAccount(updatedAccount);
  return {
    account,
    sessionValue: createModeratorSession(account),
  };
}

export async function updateStoredModeratorPassword({
  userId,
  currentPassword,
  nextPassword,
}: {
  userId: string;
  currentPassword: string;
  nextPassword: string;
}) {
  if (nextPassword.length < 6 || nextPassword.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  await ensureSeedAccounts();
  const pool = getDbPool();
  const current = await pool.query<{ password_hash: string }>(
    `select password_hash from accounts where id = $1`,
    [userId],
  );
  const storedHash = current.rows[0]?.password_hash;
  if (!storedHash || !(await verifyPassword(currentPassword, storedHash))) return false;

  // Guarded on the value we just verified, so a concurrent change isn't clobbered.
  const result = await pool.query(
    `update accounts
        set password_hash = $3,
            updated_at = now()
      where id = $1 and password_hash = $2`,
    [userId, storedHash, await hashPassword(nextPassword)],
  );
  return (result.rowCount ?? 0) > 0;
}

export type CreateModeratorError = "username_taken" | "email_taken" | "unknown";

export async function createStoredModerator({
  username,
  name,
  email,
  password,
  role,
  avatarUrl,
}: {
  username: string;
  name: string;
  email: string;
  password: string;
  role: ModeratorAccount["role"];
  avatarUrl?: string;
}): Promise<{ success: true } | { success: false; error: CreateModeratorError }> {
  await ensureSeedAccounts();
  const pool = getDbPool();
  const id = randomUUID();
  try {
    await pool.query(
      `insert into accounts (id, username, display_name, email, avatar_url, role, password_hash)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        username,
        name,
        email,
        avatarUrl ?? SEEDED_MODERATOR_AVATAR_URL,
        role,
        await hashPassword(password),
      ],
    );
    return { success: true };
  } catch (err: unknown) {
    const constraint =
      err && typeof err === "object" && "constraint" in err
        ? String((err as { constraint: unknown }).constraint)
        : "";
    if (constraint === "accounts_username_key") return { success: false, error: "username_taken" };
    if (constraint === "accounts_email_key") return { success: false, error: "email_taken" };
    return { success: false, error: "unknown" };
  }
}

export type UpdateUserError = "email_taken" | "last_owner" | "unknown";

export async function updateUserByOwner({
  userId,
  name,
  email,
  role,
  avatarUrl,
  newPassword,
}: {
  userId: string;
  name: string;
  email: string;
  role: ModeratorAccount["role"];
  avatarUrl?: string;
  newPassword?: string;
}): Promise<{ success: true } | { success: false; error: UpdateUserError }> {
  await ensureSeedAccounts();
  try {
    const passwordHash = newPassword ? await hashPassword(newPassword) : undefined;
    return await withTransaction(async (client) => {
      if (role !== "owner" && (await isLastOwner(client, userId))) {
        return { success: false as const, error: "last_owner" as const };
      }
      // Build one UPDATE from the fields that were actually supplied.
      const sets = ["display_name = $2", "email = $3", "role = $4"];
      const params: unknown[] = [userId, name, email, role];
      if (avatarUrl) {
        params.push(avatarUrl);
        sets.push(`avatar_url = $${params.length}`);
      }
      if (passwordHash) {
        params.push(passwordHash);
        sets.push(`password_hash = $${params.length}`);
      }
      await client.query(`update accounts set ${sets.join(", ")}, updated_at = now() where id = $1`, params);
      return { success: true as const };
    });
  } catch (err: unknown) {
    const constraint =
      err && typeof err === "object" && "constraint" in err
        ? String((err as { constraint: unknown }).constraint)
        : "";
    if (constraint === "accounts_email_key") return { success: false, error: "email_taken" };
    return { success: false, error: "unknown" };
  }
}

/**
 * True when `userId` is currently an owner and no other owner exists. Locks the owner rows
 * for the rest of the transaction, so two owners demoting/deleting each other at the same
 * moment can't both pass the check and leave the system with nobody able to manage it.
 */
async function isLastOwner(client: { query: (sql: string) => Promise<{ rows: Array<{ id: string }> }> }, userId: string) {
  const owners = await client.query(`select id from accounts where role = 'owner' for update`);
  return owners.rows.length === 1 && owners.rows[0]!.id === userId;
}

export type DeleteUserError = "last_owner" | "unknown";

export async function deleteUserById(
  userId: string,
): Promise<{ success: true } | { success: false; error: DeleteUserError }> {
  await ensureSeedAccounts();
  try {
    return await withTransaction(async (client) => {
      if (await isLastOwner(client, userId)) return { success: false as const, error: "last_owner" as const };
      await client.query(`delete from accounts where id = $1`, [userId]);
      return { success: true as const };
    });
  } catch {
    return { success: false, error: "unknown" };
  }
}
