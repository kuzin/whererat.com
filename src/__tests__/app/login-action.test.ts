import { describe, it, expect, vi, beforeEach } from "vitest";

class Redirect extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}
const h = vi.hoisted(() => ({
  ip: "198.51.100.1" as string | null,
  cookieSet: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: h.cookieSet, delete: vi.fn() }),
  headers: async () => ({ get: (n: string) => (n === "x-forwarded-for" ? h.ip : null) }),
}));
vi.mock("@/lib/user-store", () => ({ authenticateStoredModerator: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  MODERATOR_SESSION_COOKIE: "whererat_moderator",
  createModeratorSession: vi.fn(() => "signed-cookie-value"),
}));

import { loginModerator } from "@/app/login/actions";
import { authenticateStoredModerator } from "@/lib/user-store";

const mockAuth = vi.mocked(authenticateStoredModerator);
const account = { id: "admin", username: "admin", name: "Admin", email: "a@x.io", avatarUrl: "/a.png", role: "owner" as const };

let n = 0;
const freshIp = () => `203.0.113.${(n += 1)}`;

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}
async function login(entries: Record<string, string>) {
  try {
    await loginModerator(form(entries));
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
  return undefined;
}

beforeEach(() => {
  h.ip = freshIp();
  h.cookieSet.mockReset();
  mockAuth.mockReset().mockResolvedValue(undefined);
});

describe("loginModerator: success", () => {
  it("sets an httpOnly, SameSite=lax session cookie and redirects with a toast", async () => {
    mockAuth.mockResolvedValue(account);
    const url = await login({ username: "admin", password: "pw-123456", next: "/moderation" });
    expect(url).toBe("/moderation?toast=logged-in");
    expect(h.cookieSet).toHaveBeenCalledWith(
      "whererat_moderator",
      "signed-cookie-value",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 8 * 60 * 60 }),
    );
  });

  it("passes the typed credentials to the store as-is (hashing/trim happen there)", async () => {
    mockAuth.mockResolvedValue(account);
    await login({ username: "Admin", password: "  spaced pw  " });
    expect(mockAuth).toHaveBeenCalledWith("Admin", "  spaced pw  ");
  });
});

describe("loginModerator: failure", () => {
  it("a wrong password redirects to /login?error=invalid and sets no cookie", async () => {
    const url = await login({ username: "admin", password: "wrong", next: "/moderation" });
    expect(url).toBe("/login?error=invalid&next=%2Fmoderation");
    expect(h.cookieSet).not.toHaveBeenCalled();
  });

  it("an over-long password is rejected without ever reaching the password check", async () => {
    const url = await login({ username: "admin", password: "x".repeat(10_000) });
    expect(url).toContain("/login?error=invalid");
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("an enormous username is truncated before the lookup", async () => {
    await login({ username: "u".repeat(10_000), password: "pw" });
    expect(String(mockAuth.mock.calls[0]![0]).length).toBeLessThanOrEqual(100);
  });
});

describe("loginModerator: brute-force limit", () => {
  it("allows 10 attempts, then blocks the 11th BEFORE checking the password", async () => {
    const ip = freshIp();
    h.ip = ip;
    for (let i = 0; i < 10; i++) {
      expect(await login({ username: "admin", password: `guess-${i}` })).toContain("error=invalid");
    }
    mockAuth.mockClear();
    mockAuth.mockResolvedValue(account); // even the CORRECT password is refused while blocked
    const url = await login({ username: "admin", password: "the-right-one", next: "/moderation" });
    expect(url).toBe("/login?error=too-many-attempts&next=%2Fmoderation");
    expect(mockAuth).not.toHaveBeenCalled();
    expect(h.cookieSet).not.toHaveBeenCalled();
  });

  it("limits per client IP: another address is unaffected", async () => {
    h.ip = freshIp();
    for (let i = 0; i < 11; i++) await login({ username: "admin", password: "x" });
    h.ip = freshIp();
    expect(await login({ username: "admin", password: "x" })).toContain("error=invalid");
  });

  it("treats IPv6 spellings of one address as the same client", async () => {
    const spellings = ["2001:db8::7", "2001:0db8:0000:0000:0000:0000:0000:0007", "2001:DB8::7"];
    for (let i = 0; i < 12; i++) {
      h.ip = spellings[i % 3]!;
      await login({ username: "admin", password: "x" });
    }
    h.ip = "2001:db8:0:0:0:0:0:7";
    expect(await login({ username: "admin", password: "x" })).toContain("too-many-attempts");
  });

  it("uses the first x-forwarded-for hop only", async () => {
    h.ip = `${freshIp()}, 10.0.0.1, 10.0.0.2`;
    expect(await login({ username: "admin", password: "x" })).toContain("error=invalid");
  });

  it("a request with no forwarded address still works (shared 'unknown' bucket)", async () => {
    h.ip = null;
    expect(await login({ username: "admin", password: "x" })).toBeDefined();
  });
});

describe("loginModerator: post-login redirect target", () => {
  const hostile = [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "evil.example",
    "",
  ];

  it.each(hostile)("never redirects off-site for next=%j", async (next) => {
    mockAuth.mockResolvedValue(account);
    const url = await login({ username: "admin", password: "pw-123456", next });
    expect(url).toBe("/moderation?toast=logged-in");
  });

  it.each(["/moderation/news", "/profile", "/moderation?tab=history"])("keeps a same-site next=%j", async (next) => {
    mockAuth.mockResolvedValue(account);
    const url = await login({ username: "admin", password: "pw-123456", next });
    expect(url).toBe(`${next}${next.includes("?") ? "&" : "?"}toast=logged-in`);
  });

  it("the failure redirect also carries only a safe next", async () => {
    const url = await login({ username: "admin", password: "x", next: "//evil.example" });
    expect(url).toBe("/login?error=invalid&next=%2Fmoderation");
  });
});
