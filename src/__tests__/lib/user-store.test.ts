/**
 * user-store against an in-memory fake of the `accounts` table (real password
 * hashing, real SQL parameter shapes). Covers hashing on every write path,
 * login with legacy-plaintext upgrade, and that no password material ever
 * leaves the store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Real scrypt (64 MiB, ~100-200 ms each) with several hashes per test: give it room
// when the machine is busy (e.g. under coverage instrumentation).
vi.setConfig({ testTimeout: 30_000 });

const holder = vi.hoisted(() => ({ pool: undefined as unknown }));
vi.mock("@/lib/db", () => ({
  getDbPool: () => holder.pool,
  // The fake pool has no real transactions; the callback just runs against it.
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: (sql: string, params?: unknown[]) => (holder.pool as { query: (...a: unknown[]) => unknown }).query(sql, params) }),
}));

import {
  authenticateStoredModerator,
  createStoredModerator,
  deleteUserById,
  getAccountForSession,
  readUserStore,
  updateStoredModeratorPassword,
  updateStoredModeratorProfile,
  updateUserByOwner,
} from "@/lib/user-store";
import { hashPassword, isPasswordHashed, verifyPassword } from "@/lib/password-hash";

type Row = {
  id: string;
  username: string;
  display_name: string;
  email: string;
  avatar_url: string;
  role: "owner" | "moderator";
  password_hash: string;
};

function makePool(initial: Row[] = []) {
  const rows: Row[] = initial.map((r) => ({ ...r }));
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pub = (r: Row, withHash = false) => {
    const { password_hash, ...rest } = r;
    return withHash ? { ...rest, password_hash } : rest;
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim().toLowerCase();
    calls.push({ sql: s, params });
    if (s.startsWith("select count(*)")) return { rows: [{ count: String(rows.length) }] };
    if (s.startsWith("insert into accounts")) {
      const [id, username, display_name, email, avatar_url, role, password_hash] = params as string[];
      if (rows.some((r) => r.username === username)) {
        throw Object.assign(new Error("dup"), { constraint: "accounts_username_key" });
      }
      if (rows.some((r) => r.email === email)) {
        throw Object.assign(new Error("dup"), { constraint: "accounts_email_key" });
      }
      rows.push({ id, username, display_name, email, avatar_url, role: role as Row["role"], password_hash });
      return { rows: [] };
    }
    if (s.startsWith("select") && s.includes("from accounts where username = $1")) {
      return { rows: rows.filter((r) => r.username === params[0]).map((r) => pub(r, s.includes("password_hash"))) };
    }
    if (s.startsWith("select id from accounts where role = 'owner' for update")) {
      return { rows: rows.filter((r) => r.role === "owner").map((r) => ({ id: r.id })) };
    }
    if (s.startsWith("select password_hash from accounts where id = $1")) {
      return { rows: rows.filter((r) => r.id === params[0]).map((r) => ({ password_hash: r.password_hash })) };
    }
    if (s.startsWith("select") && s.includes("from accounts where id = $1")) {
      return { rows: rows.filter((r) => r.id === params[0]).map((r) => pub(r)) };
    }
    if (s.startsWith("select") && s.includes("from accounts order by username")) {
      return { rows: [...rows].sort((a, b) => a.username.localeCompare(b.username)).map((r) => pub(r)) };
    }
    if (s.startsWith("update accounts set password_hash = $3")) {
      const [id, old, next] = params as string[];
      const hit = rows.find((r) => r.id === id && r.password_hash === old);
      if (!hit) return { rows: [], rowCount: 0 };
      hit.password_hash = next;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("update accounts") && s.includes("returning")) {
      const [id, name, email, avatar, role] = params as string[];
      const hit = rows.find((r) => r.id === id);
      if (!hit) return { rows: [] };
      Object.assign(hit, { display_name: name, email, avatar_url: avatar, role });
      return { rows: [pub(hit)] };
    }
    if (s.startsWith("update accounts")) {
      const id = params[0] as string;
      const hit = rows.find((r) => r.id === id);
      if (!hit) return { rows: [], rowCount: 0 };
      hit.display_name = params[1] as string;
      hit.email = params[2] as string;
      hit.role = params[3] as Row["role"];
      if (s.includes("avatar_url = $5")) hit.avatar_url = params[4] as string;
      const hash = params.find((p) => typeof p === "string" && (p as string).startsWith("scrypt$"));
      if (hash) hit.password_hash = hash as string;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("delete from accounts")) {
      const i = rows.findIndex((r) => r.id === params[0]);
      if (i >= 0) rows.splice(i, 1);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL in fake pool: ${s.slice(0, 90)}`);
  });
  return { query, rows, calls };
}

const legacyAdmin = (over: Partial<Row> = {}): Row => ({
  id: "admin",
  username: "admin",
  display_name: "Admin",
  email: "admin@whererat.local",
  avatar_url: "/favicon.svg",
  role: "owner",
  password_hash: "legacy-plaintext-pw",
  ...over,
});

let pool: ReturnType<typeof makePool>;
function use(rows: Row[] = []) {
  pool = makePool(rows);
  holder.pool = pool;
  return pool;
}

beforeEach(() => {
  vi.stubEnv("MODERATOR_ADMIN_PASSWORD", "seed-password-123");
  vi.spyOn(console, "error").mockImplementation(() => {});
  use([legacyAdmin()]);
});

describe("seeding", () => {
  it("hashes the env password when it seeds the first account", async () => {
    use([]);
    await readUserStore();
    expect(pool.rows).toHaveLength(1);
    expect(isPasswordHashed(pool.rows[0]!.password_hash)).toBe(true);
    expect(pool.rows[0]!.password_hash).not.toContain("seed-password-123");
    expect(await verifyPassword("seed-password-123", pool.rows[0]!.password_hash)).toBe(true);
  });
});

describe("authenticateStoredModerator", () => {
  it("logs in a legacy-plaintext account, then upgrades it to a hash in place", async () => {
    const account = await authenticateStoredModerator("admin", "legacy-plaintext-pw");
    expect(account).toMatchObject({ id: "admin", role: "owner" });
    const stored = pool.rows[0]!.password_hash;
    expect(isPasswordHashed(stored)).toBe(true);
    expect(stored).not.toContain("legacy-plaintext-pw");
    // …and the same password keeps working afterwards.
    expect(await authenticateStoredModerator("admin", "legacy-plaintext-pw")).toBeTruthy();
  });

  it("the upgrade is guarded on the old value (never overwrites a concurrent password change)", async () => {
    await authenticateStoredModerator("admin", "legacy-plaintext-pw");
    const upgrade = pool.calls.find((c) => c.sql.startsWith("update accounts set password_hash = $3"))!;
    expect(upgrade.sql).toContain("password_hash = $2");
    expect(upgrade.params[1]).toBe("legacy-plaintext-pw");
  });

  it("a wrong password fails and changes nothing", async () => {
    expect(await authenticateStoredModerator("admin", "nope")).toBeUndefined();
    expect(pool.rows[0]!.password_hash).toBe("legacy-plaintext-pw");
  });

  it("logs in a hashed account without rewriting its hash", async () => {
    const h = await hashPassword("a-good-passphrase");
    use([legacyAdmin({ password_hash: h })]);
    expect(await authenticateStoredModerator("admin", "a-good-passphrase")).toBeTruthy();
    expect(pool.rows[0]!.password_hash).toBe(h);
    expect(await authenticateStoredModerator("admin", "a-bad-passphrase")).toBeUndefined();
  });

  it("username is trimmed and case-insensitive", async () => {
    expect(await authenticateStoredModerator("  ADMIN ", "legacy-plaintext-pw")).toBeTruthy();
  });

  it.each(["", "ghost", "admin' or '1'='1", "admin\u0000"])("unknown username %j fails (and does real work)", async (u) => {
    expect(await authenticateStoredModerator(u, "legacy-plaintext-pw")).toBeUndefined();
  });

  it("the typed username is only ever a bound parameter", async () => {
    await authenticateStoredModerator("x'; drop table accounts;--", "pw");
    for (const c of pool.calls) expect(c.sql).not.toContain("drop table");
  });

  it("an empty password never logs in, even for an account whose stored value is empty", async () => {
    use([legacyAdmin({ password_hash: "" })]);
    expect(await authenticateStoredModerator("admin", "")).toBeUndefined();
  });

  it("a failed upgrade write does not block the login", async () => {
    const original = pool.query.getMockImplementation()!;
    pool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/update accounts set password_hash = \$3/i.test(sql.replace(/\s+/g, " "))) throw new Error("db blip");
      return original(sql, params);
    });
    expect(await authenticateStoredModerator("admin", "legacy-plaintext-pw")).toBeTruthy();
  });

  it("never returns the password or its hash", async () => {
    const account = (await authenticateStoredModerator("admin", "legacy-plaintext-pw")) as Record<string, unknown>;
    expect(JSON.stringify(account)).not.toMatch(/legacy-plaintext-pw|scrypt\$|password/i);
  });

  it("an over-long password is rejected without being compared", async () => {
    expect(await authenticateStoredModerator("admin", "x".repeat(5000))).toBeUndefined();
  });
});

describe("updateStoredModeratorPassword", () => {
  it("changes the password when the current one is right, storing only a hash", async () => {
    expect(
      await updateStoredModeratorPassword({ userId: "admin", currentPassword: "legacy-plaintext-pw", nextPassword: "brand-new-secret" }),
    ).toBe(true);
    const stored = pool.rows[0]!.password_hash;
    expect(isPasswordHashed(stored)).toBe(true);
    expect(await verifyPassword("brand-new-secret", stored)).toBe(true);
    expect(await verifyPassword("legacy-plaintext-pw", stored)).toBe(false);
  });

  it("works for an already-hashed account too", async () => {
    use([legacyAdmin({ password_hash: await hashPassword("first-secret") })]);
    expect(await updateStoredModeratorPassword({ userId: "admin", currentPassword: "first-secret", nextPassword: "second-secret" })).toBe(true);
    expect(await verifyPassword("second-secret", pool.rows[0]!.password_hash)).toBe(true);
  });

  it("refuses a wrong current password and leaves the hash alone", async () => {
    expect(await updateStoredModeratorPassword({ userId: "admin", currentPassword: "wrong", nextPassword: "brand-new-secret" })).toBe(false);
    expect(pool.rows[0]!.password_hash).toBe("legacy-plaintext-pw");
  });

  it.each(["", "short", "x".repeat(201)])("refuses a new password that is too short / long (%#)", async (next) => {
    expect(await updateStoredModeratorPassword({ userId: "admin", currentPassword: "legacy-plaintext-pw", nextPassword: next })).toBe(false);
  });

  it("refuses an unknown user", async () => {
    expect(await updateStoredModeratorPassword({ userId: "ghost", currentPassword: "legacy-plaintext-pw", nextPassword: "brand-new-secret" })).toBe(false);
  });

  it("the write is guarded on the verified hash (a concurrent change wins, no silent overwrite)", async () => {
    await updateStoredModeratorPassword({ userId: "admin", currentPassword: "legacy-plaintext-pw", nextPassword: "brand-new-secret" });
    const write = pool.calls.filter((c) => c.sql.startsWith("update accounts set password_hash = $3")).at(-1)!;
    expect(write.sql).toContain("password_hash = $2");
    expect(write.params[1]).toBe("legacy-plaintext-pw");
  });
});

describe("createStoredModerator", () => {
  const input = { username: "newmod", name: "New Mod", email: "new@x.io", password: "initial-secret", role: "moderator" as const };

  it("stores a hash, never the password", async () => {
    expect(await createStoredModerator(input)).toEqual({ success: true });
    const row = pool.rows.find((r) => r.username === "newmod")!;
    expect(isPasswordHashed(row.password_hash)).toBe(true);
    expect(row.password_hash).not.toContain("initial-secret");
    expect(await verifyPassword("initial-secret", row.password_hash)).toBe(true);
  });

  it("the new account can log in", async () => {
    await createStoredModerator(input);
    expect(await authenticateStoredModerator("newmod", "initial-secret")).toMatchObject({ role: "moderator" });
  });

  it.each([
    [{ username: "admin" }, "username_taken"],
    [{ email: "admin@whererat.local" }, "email_taken"],
  ])("maps a unique violation %j to %s", async (over, error) => {
    expect(await createStoredModerator({ ...input, ...over })).toEqual({ success: false, error });
  });

  it("an over-long password is an error, not a stored value", async () => {
    expect(await createStoredModerator({ ...input, password: "x".repeat(500) })).toEqual({ success: false, error: "unknown" });
    expect(pool.rows.some((r) => r.username === "newmod")).toBe(false);
  });
});

describe("updateUserByOwner", () => {
  const base = { userId: "admin", name: "Admin", email: "admin@whererat.local", role: "owner" as const };

  it("hashes a new password (with or without an avatar)", async () => {
    expect(await updateUserByOwner({ ...base, newPassword: "owner-set-secret" })).toEqual({ success: true });
    expect(isPasswordHashed(pool.rows[0]!.password_hash)).toBe(true);
    expect(await verifyPassword("owner-set-secret", pool.rows[0]!.password_hash)).toBe(true);

    await updateUserByOwner({ ...base, newPassword: "owner-set-secret-2", avatarUrl: "/a.png" });
    expect(await verifyPassword("owner-set-secret-2", pool.rows[0]!.password_hash)).toBe(true);
    expect(pool.rows[0]!.avatar_url).toBe("/a.png");
  });

  it("leaves the password untouched when none is supplied", async () => {
    await updateUserByOwner({ ...base, name: "Renamed" });
    expect(pool.rows[0]!.password_hash).toBe("legacy-plaintext-pw");
    expect(pool.rows[0]!.display_name).toBe("Renamed");
  });

  it("an over-long password is an error and changes nothing", async () => {
    expect(await updateUserByOwner({ ...base, newPassword: "x".repeat(500) })).toEqual({ success: false, error: "unknown" });
    expect(pool.rows[0]!.password_hash).toBe("legacy-plaintext-pw");
  });
});

describe("nothing exposes password material", () => {
  it("readUserStore / getAccountForSession / updateStoredModeratorProfile carry no password or hash", async () => {
    const outputs = [
      await readUserStore(),
      await getAccountForSession("admin"),
      await updateStoredModeratorProfile({ userId: "admin", name: "A", email: "a@x.io", avatarUrl: "/a.png", role: "owner" }),
    ];
    for (const out of outputs) {
      expect(JSON.stringify(out)).not.toMatch(/legacy-plaintext-pw|scrypt\$|password/i);
    }
    // …and the SQL never even selects the hash for those reads.
    const reads = pool.calls.filter((c) => c.sql.startsWith("select") && !c.sql.includes("count(*)") && !c.sql.includes("where username"));
    for (const c of reads) expect(c.sql).not.toContain("password_hash");
  });

  it("getAccountForSession returns undefined for a deleted account", async () => {
    use([legacyAdmin(), legacyAdmin({ id: "o2", username: "o2", email: "o2@x.io" })]); // a 2nd owner so deleting is allowed
    await deleteUserById("admin");
    expect(await getAccountForSession("admin")).toBeUndefined();
  });
});

describe("the last owner can't be removed or demoted", () => {
  const owner = (id: string, username: string, email: string) => legacyAdmin({ id, username, email, role: "owner" });
  const mod = legacyAdmin({ id: "m1", username: "mod", email: "mod@x.io", role: "moderator" });
  const base = (id: string, role: "owner" | "moderator") => ({ userId: id, name: "N", email: `${id}@x.io`, role });

  it("demoting the only owner is refused and the role is unchanged", async () => {
    use([legacyAdmin(), mod]);
    expect(await updateUserByOwner(base("admin", "moderator"))).toEqual({ success: false, error: "last_owner" });
    expect(pool.rows.find((r) => r.id === "admin")!.role).toBe("owner");
  });

  it("deleting the only owner is refused and the account remains", async () => {
    use([legacyAdmin(), mod]);
    expect(await deleteUserById("admin")).toEqual({ success: false, error: "last_owner" });
    expect(pool.rows.some((r) => r.id === "admin")).toBe(true);
  });

  it("with two owners, one can be demoted and then deleted... but never the last", async () => {
    use([owner("o1", "o1", "o1@x.io"), owner("o2", "o2", "o2@x.io")]);
    expect(await updateUserByOwner(base("o1", "moderator"))).toEqual({ success: true });
    expect(await updateUserByOwner(base("o2", "moderator"))).toEqual({ success: false, error: "last_owner" });
    expect(await deleteUserById("o2")).toEqual({ success: false, error: "last_owner" });
    expect(pool.rows.filter((r) => r.role === "owner")).toHaveLength(1);
  });

  it("deleting a moderator or an extra owner is fine", async () => {
    use([owner("o1", "o1", "o1@x.io"), owner("o2", "o2", "o2@x.io"), mod]);
    expect(await deleteUserById("m1")).toEqual({ success: true });
    expect(await deleteUserById("o2")).toEqual({ success: true });
    expect(pool.rows.map((r) => r.id)).toEqual(["o1"]);
  });

  it("changing a moderator's role to owner, or an owner staying an owner, is unaffected", async () => {
    use([legacyAdmin(), mod]);
    expect(await updateUserByOwner(base("m1", "owner"))).toEqual({ success: true });
    expect(await updateUserByOwner(base("admin", "owner"))).toEqual({ success: true });
    expect(pool.rows.filter((r) => r.role === "owner")).toHaveLength(2);
  });

  it("promoting someone else then demoting yourself works (the supported way to hand over)", async () => {
    use([legacyAdmin(), mod]);
    await updateUserByOwner(base("m1", "owner"));
    expect(await updateUserByOwner(base("admin", "moderator"))).toEqual({ success: true });
  });

  it("deleting an unknown id is a harmless success when another owner exists", async () => {
    use([legacyAdmin()]);
    expect(await deleteUserById("ghost")).toEqual({ success: true });
  });
});
