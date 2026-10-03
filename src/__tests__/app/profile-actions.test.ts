import { describe, it, expect, vi, beforeEach } from "vitest";

class Redirect extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}
const h = vi.hoisted(() => ({
  session: undefined as undefined | { id: string; role: "owner" | "moderator"; name: string },
  cookieSet: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "cookie" }), set: h.cookieSet }),
}));
vi.mock("@/lib/auth", () => ({ MODERATOR_SESSION_COOKIE: "whererat_moderator" }));
vi.mock("@/lib/moderator-session", () => ({ verifyModeratorSession: async () => h.session }));
vi.mock("@/lib/user-store", () => ({
  updateStoredModeratorProfile: vi.fn(),
  updateStoredModeratorPassword: vi.fn(),
}));
vi.mock("@/lib/media-storage", () => ({ persistImageFile: vi.fn() }));

import { updatePassword, updateProfile } from "@/app/profile/actions";
import { updateStoredModeratorPassword, updateStoredModeratorProfile } from "@/lib/user-store";
import { persistImageFile } from "@/lib/media-storage";

const mockProfile = vi.mocked(updateStoredModeratorProfile);
const mockPassword = vi.mocked(updateStoredModeratorPassword);
const mockPersist = vi.mocked(persistImageFile);

function form(entries: Record<string, string | File>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}
async function run(fn: (fd: FormData) => Promise<void>, fd: FormData) {
  try {
    await fn(fd);
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
  return undefined;
}
const valid = (over: Record<string, string | File> = {}) =>
  form({ name: "New Name", email: "new@x.io", currentAvatarUrl: "/a.png", ...over });

beforeEach(() => {
  h.session = { id: "u1", role: "moderator", name: "Mo" };
  h.cookieSet.mockReset();
  mockProfile.mockReset().mockResolvedValue({ account: {} as never, sessionValue: "new-cookie" });
  mockPassword.mockReset().mockResolvedValue(true);
  mockPersist.mockReset();
});

describe("updateProfile: a profile edit never changes the caller's role", () => {
  it.each(["owner", "OWNER", " owner ", "admin", "", "moderator"])(
    "a MODERATOR submitting role=%j stays a moderator",
    async (role) => {
      await run(updateProfile, valid({ role }));
      expect(mockProfile).toHaveBeenCalledOnce();
      expect(mockProfile.mock.calls[0]![0].role).toBe("moderator");
    },
  );

  it("an OWNER submitting role=moderator is not demoted by editing their profile", async () => {
    h.session = { id: "o1", role: "owner", name: "Boss" };
    await run(updateProfile, valid({ role: "moderator" }));
    expect(mockProfile.mock.calls[0]![0].role).toBe("owner");
  });

  it("the edit is applied to the caller's own account only, whatever id the form claims", async () => {
    await run(updateProfile, valid({ userId: "someone-else", id: "someone-else" }));
    expect(mockProfile.mock.calls[0]![0].userId).toBe("u1");
  });

  it("saves the name/email, refreshes the session cookie and redirects with a success status", async () => {
    const url = await run(updateProfile, valid());
    expect(url).toBe("/profile?status=profile-updated");
    expect(mockProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "New Name", email: "new@x.io", avatarUrl: "/a.png" }));
    expect(h.cookieSet).toHaveBeenCalledWith("whererat_moderator", "new-cookie", expect.objectContaining({ httpOnly: true, sameSite: "lax" }));
  });
});

describe("updateProfile: other behaviour", () => {
  it("requires a session", async () => {
    h.session = undefined;
    expect(await run(updateProfile, valid())).toBe("/login?next=/profile");
    expect(mockProfile).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([{ name: "" }, { email: "" }, { name: "   " }])("missing required field %j is refused", async (over) => {
    expect(await run(updateProfile, valid(over))).toBe("/profile?status=missing");
    expect(mockProfile).not.toHaveBeenCalled();
  });

  it("a stored-account failure shows an error and does not touch the cookie", async () => {
    mockProfile.mockResolvedValue(undefined);
    expect(await run(updateProfile, valid())).toBe("/profile?status=error");
    expect(h.cookieSet).not.toHaveBeenCalled();
  });

  it("an uploaded avatar replaces the current one", async () => {
    mockPersist.mockResolvedValue("/uploads/avatars/x.png");
    await run(updateProfile, valid({ avatarImage: new File([new Uint8Array([1])], "a.png", { type: "image/png" }) }));
    expect(mockProfile.mock.calls[0]![0].avatarUrl).toBe("/uploads/avatars/x.png");
  });

  it("a rejected upload (e.g. not really an image) keeps the current avatar", async () => {
    mockPersist.mockResolvedValue(undefined);
    await run(updateProfile, valid({ avatarImage: new File(["<script>"], "evil.png", { type: "image/png" }) }));
    expect(mockProfile.mock.calls[0]![0].avatarUrl).toBe("/a.png");
  });
});

describe("updatePassword", () => {
  it("requires a session", async () => {
    h.session = undefined;
    expect(await run(updatePassword, form({ currentPassword: "a", nextPassword: "b", confirmPassword: "b" }))).toBe("/login?next=/profile");
    expect(mockPassword).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { currentPassword: "", nextPassword: "new-secret", confirmPassword: "new-secret" },
    { currentPassword: "old", nextPassword: "", confirmPassword: "" },
    { currentPassword: "old", nextPassword: "new-secret", confirmPassword: "different" },
  ])("%j is refused before reaching the store", async (entries) => {
    expect(await run(updatePassword, form(entries))).toBe("/profile?status=password-invalid");
    expect(mockPassword).not.toHaveBeenCalled();
  });

  it("changes the password for the caller's own account only", async () => {
    const url = await run(updatePassword, form({ currentPassword: "old", nextPassword: "new-secret", confirmPassword: "new-secret", userId: "someone-else" }));
    expect(url).toBe("/profile?status=password-updated");
    expect(mockPassword).toHaveBeenCalledWith({ userId: "u1", currentPassword: "old", nextPassword: "new-secret" });
  });

  it("a wrong current password is reported", async () => {
    mockPassword.mockResolvedValue(false);
    expect(await run(updatePassword, form({ currentPassword: "bad", nextPassword: "new-secret", confirmPassword: "new-secret" }))).toBe("/profile?status=password-invalid");
  });
});
