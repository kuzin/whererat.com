import { randomUUID } from "crypto";
import {
  createModeratorSession,
  getModeratorAccounts,
  SEEDED_MODERATOR_AVATAR_URL,
  type ModeratorAccount,
} from "@/lib/auth";
import { getDbPool } from "@/lib/db";

const LEGACY_ADMIN_AVATAR_URL = "https://placehold.co/160x160/292524/fef3c7/png?text=Admin";

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
        account.password,
      ],
    );
  }
}

function rowToAccount(row: {
  id: string;
  username: string;
  display_name: string;
  email: string;
  avatar_url: string;
  role: "owner" | "moderator";
  password_hash: string;
}): ModeratorAccount {
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
    password: row.password_hash,
  };
}

export async function readUserStore() {
  await ensureSeedAccounts();
  const pool = getDbPool();
  const result = await pool.query<{
    id: string;
    username: string;
    display_name: string;
    email: string;
    avatar_url: string;
    role: "owner" | "moderator";
    password_hash: string;
  }>(
    `select id, username, display_name, email, avatar_url, role, password_hash
     from accounts
     order by username asc`,
  );
  return {
    version: 1,
    accounts: result.rows.map(rowToAccount),
  };
}

export async function authenticateStoredModerator(
  username: string,
  password: string,
) {
  const state = await readUserStore();
  const normalizedUsername = username.trim().toLowerCase();

  return state.accounts.find(
    (account) =>
      account.username === normalizedUsername && account.password === password,
  );
}

/**
 * Current account behind a signed session cookie, or undefined if it was deleted.
 * A single primary-key read (no seeding), cheap enough to run on every request.
 */
export async function getAccountForSession(userId: string) {
  const pool = getDbPool();
  const result = await pool.query<{
    id: string;
    username: string;
    display_name: string;
    email: string;
    avatar_url: string;
    role: "owner" | "moderator";
    password_hash: string;
  }>(
    `select id, username, display_name, email, avatar_url, role, password_hash
     from accounts
     where id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const { password: _password, ...account } = rowToAccount(row);
  void _password;
  return account;
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
  const updated = await pool.query<{
    id: string;
    username: string;
    display_name: string;
    email: string;
    avatar_url: string;
    role: "owner" | "moderator";
    password_hash: string;
  }>(
    `update accounts
        set display_name = $2,
            email = $3,
            avatar_url = $4,
            role = $5,
            updated_at = now()
      where id = $1
      returning id, username, display_name, email, avatar_url, role, password_hash`,
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
  if (nextPassword.length < 6) {
    return false;
  }
  await ensureSeedAccounts();
  const pool = getDbPool();
  const result = await pool.query(
    `update accounts
        set password_hash = $3,
            updated_at = now()
      where id = $1 and password_hash = $2`,
    [userId, currentPassword, nextPassword],
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
      [id, username, name, email, avatarUrl ?? SEEDED_MODERATOR_AVATAR_URL, role, password],
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

export type UpdateUserError = "email_taken" | "unknown";

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
  const pool = getDbPool();
  try {
    if (newPassword && avatarUrl) {
      await pool.query(
        `update accounts
            set display_name = $2,
                email = $3,
                role = $4,
                avatar_url = $5,
                password_hash = $6,
                updated_at = now()
          where id = $1`,
        [userId, name, email, role, avatarUrl, newPassword],
      );
    } else if (newPassword) {
      await pool.query(
        `update accounts
            set display_name = $2,
                email = $3,
                role = $4,
                password_hash = $5,
                updated_at = now()
          where id = $1`,
        [userId, name, email, role, newPassword],
      );
    } else if (avatarUrl) {
      await pool.query(
        `update accounts
            set display_name = $2,
                email = $3,
                role = $4,
                avatar_url = $5,
                updated_at = now()
          where id = $1`,
        [userId, name, email, role, avatarUrl],
      );
    } else {
      await pool.query(
        `update accounts
            set display_name = $2,
                email = $3,
                role = $4,
                updated_at = now()
          where id = $1`,
        [userId, name, email, role],
      );
    }
    return { success: true };
  } catch (err: unknown) {
    const constraint =
      err && typeof err === "object" && "constraint" in err
        ? String((err as { constraint: unknown }).constraint)
        : "";
    if (constraint === "accounts_email_key") return { success: false, error: "email_taken" };
    return { success: false, error: "unknown" };
  }
}

export async function deleteUserById(userId: string): Promise<void> {
  await ensureSeedAccounts();
  const pool = getDbPool();
  await pool.query(`delete from accounts where id = $1`, [userId]);
}
