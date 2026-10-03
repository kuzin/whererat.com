/**
 * Adversarial tests for the moderator session cookie / login helpers that gate
 * every moderation edit. Pure crypto, no I/O. `auth.ts` reads env at import
 * time, so each test re-imports it under a controlled environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

type Auth = typeof import("@/lib/auth");

const SECRET = "unit-test-secret-0123456789";

async function loadAuth(env: Record<string, string | undefined> = {}): Promise<Auth> {
  vi.resetModules();
  const merged: Record<string, string | undefined> = {
    SESSION_SECRET: SECRET,
    MODERATOR_ADMIN_PASSWORD: "correct horse",
    MODERATOR_CURATOR_PASSWORD: undefined,
    MODERATOR_PASSWORD: undefined,
    NODE_ENV: "test",
    ...env,
  };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) {
      vi.stubEnv(k, undefined as unknown as string);
      delete process.env[k];
    } else {
      vi.stubEnv(k, v);
    }
  }
  return import("@/lib/auth");
}

const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o), "utf8").toString("base64url");
const sign = (payload: string, secret = SECRET) => createHmac("sha256", secret).update(payload).digest("base64url");
const cookie = (obj: unknown, secret = SECRET) => {
  const p = b64(obj);
  return `${p}.${sign(p, secret)}`;
};

const nowS = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  username: "mod",
  name: "Mod",
  email: "m@x.io",
  avatarUrl: "/a.png",
  role: "moderator",
  exp: nowS() + 3600,
  ...over,
});

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseModeratorSession", () => {
  it("round-trips a session created by the server and strips exp", async () => {
    const a = await loadAuth();
    const [account] = a.getModeratorAccounts();
    const parsed = a.parseModeratorSession(a.createModeratorSession(account!));
    expect(parsed).toMatchObject({ id: "admin", role: "owner", username: "admin" });
    expect(parsed).not.toHaveProperty("exp");
    expect(parsed).not.toHaveProperty("password");
  });

  it.each([undefined, "", "   ", "no-dot-legacy-format", ".", "..", "a.b.c.d", "....."])(
    "rejects junk cookie %j",
    async (value) => {
      const a = await loadAuth();
      expect(a.parseModeratorSession(value as string | undefined)).toBeUndefined();
    },
  );

  it("rejects a payload whose role was tampered with (old signature)", async () => {
    const a = await loadAuth();
    const good = cookie(claims());
    const [, sig] = good.split(".");
    const forged = `${b64(claims({ role: "owner" }))}.${sig}`;
    expect(a.parseModeratorSession(good)?.role).toBe("moderator");
    expect(a.parseModeratorSession(forged)).toBeUndefined();
  });

  it("rejects signatures made with another secret", async () => {
    const a = await loadAuth();
    expect(a.parseModeratorSession(cookie(claims(), "attacker-secret"))).toBeUndefined();
  });

  it("rejects truncated, padded, empty and oversized signatures without throwing", async () => {
    const a = await loadAuth();
    const p = b64(claims());
    const sig = sign(p);
    // NB: `${sig}A` / `${sig}=` still decode to the same 32 bytes (Node ignores trailing sub-byte bits/padding),
    // so such non-canonical encodings are accepted. That is benign malleability, not a forgery, so it is not asserted here.
    for (const bad of [sig.slice(0, -1), sig.slice(0, 10), "", "A".repeat(10_000), "%%%", sig.toUpperCase()]) {
      expect(a.parseModeratorSession(`${p}.${bad}`), JSON.stringify(bad).slice(0, 30)).toBeUndefined();
    }
  });

  it("rejects an expired session", async () => {
    const a = await loadAuth();
    expect(a.parseModeratorSession(cookie(claims({ exp: nowS() - 1 })))).toBeUndefined();
    expect(a.parseModeratorSession(cookie(claims({ exp: 0 })))).toBeUndefined();
    expect(a.parseModeratorSession(cookie(claims({ exp: nowS() + 60 })))?.id).toBe("m1");
  });

  it.each([
    ["id", { id: "" }],
    ["username", { username: "" }],
    ["name", { name: "" }],
    ["role", { role: "" }],
  ])("rejects a correctly signed payload with empty %s", async (_n, over) => {
    const a = await loadAuth();
    expect(a.parseModeratorSession(cookie(claims(over)))).toBeUndefined();
  });

  it("rejects a correctly signed payload that is not JSON / not an object", async () => {
    const a = await loadAuth();
    for (const raw of ["not json", "null", "[]", '"str"', "123"]) {
      const p = b64(raw);
      expect(a.parseModeratorSession(`${p}.${sign(p)}`), raw).toBeUndefined();
    }
  });

  it("a 1 MB cookie is rejected cheaply and never throws", async () => {
    const a = await loadAuth();
    const start = performance.now();
    expect(a.parseModeratorSession("x".repeat(1024 * 1024) + "." + "y".repeat(100))).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("a session minted with the server secret cannot be replayed against a rotated secret", async () => {
    const a1 = await loadAuth({ SESSION_SECRET: "secret-one" });
    const [account] = a1.getModeratorAccounts();
    const token = a1.createModeratorSession(account!);
    const a2 = await loadAuth({ SESSION_SECRET: "secret-two" });
    expect(a2.parseModeratorSession(token)).toBeUndefined();
  });
});

describe("fail-closed configuration", () => {
  it("BUG: with SESSION_SECRET unset in production the cookie is signed with a hard-coded, public default key (forgeable owner session)", async () => {
    const a = await loadAuth({ SESSION_SECRET: undefined, NODE_ENV: "production" });
    const forged = cookie(claims({ role: "owner", username: "admin", id: "admin" }), "dev-insecure-secret-change-in-prod");
    expect(a.parseModeratorSession(forged)).toBeUndefined();
  });

  it("BUG: an EMPTY SESSION_SECRET (env var present but blank) is accepted as the HMAC key", async () => {
    const a = await loadAuth({ SESSION_SECRET: "", NODE_ENV: "production" });
    const forged = cookie(claims({ role: "owner", username: "admin", id: "admin" }), "");
    expect(a.parseModeratorSession(forged)).toBeUndefined();
  });

  it("with no moderator password in production nobody can log in (random per-call password)", async () => {
    const a = await loadAuth({ MODERATOR_ADMIN_PASSWORD: undefined, NODE_ENV: "production" });
    for (const pw of ["", "ratpack", "undefined", "null", "admin"]) {
      expect(a.authenticateModerator("admin", pw), JSON.stringify(pw)).toBeUndefined();
    }
  });

  it("BUG: an EMPTY MODERATOR_ADMIN_PASSWORD (blank env var) lets anyone log in as the owner with an empty password", async () => {
    const a = await loadAuth({ MODERATOR_ADMIN_PASSWORD: "", NODE_ENV: "production" });
    expect(a.authenticateModerator("admin", "")).toBeUndefined();
  });
});

describe("authenticateModerator", () => {
  it("accepts the configured password (username is trimmed/case-insensitive)", async () => {
    const a = await loadAuth();
    expect(a.authenticateModerator("  ADMIN ", "correct horse")?.id).toBe("admin");
  });

  it.each(["", " ", "Correct Horse", "correct horse ", "correct", "x".repeat(100_000)])(
    "rejects wrong password %j",
    async (pw) => {
      const a = await loadAuth();
      expect(a.authenticateModerator("admin", pw)).toBeUndefined();
    },
  );

  it.each(["", "root", "admin'; --", "admin\u0000", "admin2"])("rejects unknown username %j", async (u) => {
    const a = await loadAuth();
    expect(a.authenticateModerator(u, "correct horse")).toBeUndefined();
  });

  it("canAutoApproveSubmissions is true only for a real session", async () => {
    const a = await loadAuth();
    expect(a.canAutoApproveSubmissions(undefined)).toBe(false);
  });
});
