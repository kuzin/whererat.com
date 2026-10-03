import { describe, it, expect, vi, beforeEach } from "vitest";

class Redirect extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}
const h = vi.hoisted(() => ({ session: undefined as undefined | { id: string; role: "owner" | "moderator" } }));

vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Redirect(u); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "c" }) }) }));
vi.mock("@/lib/auth", () => ({ MODERATOR_SESSION_COOKIE: "whererat_moderator" }));
vi.mock("@/lib/moderator-session", () => ({ verifyModeratorSession: async () => h.session }));
vi.mock("@/lib/media-storage", () => ({ persistImageFile: vi.fn() }));
vi.mock("@/lib/user-store", () => ({
  createStoredModerator: vi.fn(),
  updateUserByOwner: vi.fn(),
  deleteUserById: vi.fn(),
}));

import { deleteUserAction, updateUserAction } from "@/app/moderation/users/actions";
import { deleteUserById, updateUserByOwner } from "@/lib/user-store";

const mockDelete = vi.mocked(deleteUserById);
const mockUpdate = vi.mocked(updateUserByOwner);

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
};
async function run(fn: (fd: FormData) => Promise<unknown>, fd: FormData) {
  try {
    await fn(fd);
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
}

beforeEach(() => {
  h.session = { id: "owner-1", role: "owner" };
  mockDelete.mockReset().mockResolvedValue({ success: true });
  mockUpdate.mockReset().mockResolvedValue({ success: true });
});

describe("deleteUserAction", () => {
  it("is owner-only", async () => {
    h.session = { id: "m1", role: "moderator" };
    expect(await run(deleteUserAction, form({ userId: "x" }))).toBe("/moderation");
    expect(mockDelete).not.toHaveBeenCalled();
    h.session = undefined;
    expect(await run(deleteUserAction, form({ userId: "x" }))).toBe("/moderation");
  });

  it("refuses to delete your own account, on the server (not just by hiding the button)", async () => {
    expect(await run(deleteUserAction, form({ userId: "owner-1" }))).toBe("/moderation/users?error=self_delete");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes another account", async () => {
    expect(await run(deleteUserAction, form({ userId: "m1" }))).toBe("/moderation/users?toast=user-deleted");
    expect(mockDelete).toHaveBeenCalledWith("m1");
  });

  it("reports the store refusing to remove the last owner", async () => {
    mockDelete.mockResolvedValue({ success: false, error: "last_owner" });
    expect(await run(deleteUserAction, form({ userId: "o2" }))).toBe("/moderation/users?error=last_owner");
  });

  it("a missing id deletes nothing", async () => {
    expect(await run(deleteUserAction, form({ userId: "  " }))).toBe("/moderation/users");
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("updateUserAction", () => {
  const ok = (over: Record<string, string> = {}) => form({ userId: "m1", name: "N", email: "n@x.io", role: "moderator", ...over });

  it("is owner-only", async () => {
    h.session = { id: "m1", role: "moderator" };
    expect(await run(updateUserAction, ok())).toBe("/moderation");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("surfaces the last-owner refusal back on the edit modal", async () => {
    mockUpdate.mockResolvedValue({ success: false, error: "last_owner" });
    expect(await run(updateUserAction, ok({ userId: "owner-1", role: "moderator" }))).toBe("/moderation/users?edit=owner-1&error=last_owner");
  });

  it("any role value other than 'owner' means moderator", async () => {
    await run(updateUserAction, ok({ role: "OWNER" }));
    expect(mockUpdate.mock.calls[0]![0].role).toBe("moderator");
    await run(updateUserAction, ok({ role: "owner" }));
    expect(mockUpdate.mock.calls[1]![0].role).toBe("owner");
  });

  it("saves and redirects with the success toast", async () => {
    expect(await run(updateUserAction, ok())).toBe("/moderation/users?toast=user-updated");
  });
});
