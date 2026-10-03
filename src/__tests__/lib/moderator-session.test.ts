import { describe, it, expect, vi, beforeEach } from "vitest";

const getAccount = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-store", () => ({ getAccountForSession: getAccount }));

import { createModeratorSession } from "@/lib/auth";
import { verifyModeratorSession } from "@/lib/moderator-session";

const account = (over: Record<string, unknown> = {}) => ({
  id: "m-1",
  username: "mod",
  name: "Mo Derator",
  email: "mo@x.io",
  avatarUrl: "/a.png",
  role: "moderator" as const,
  password: "pw",
  ...over,
});
const cookieFor = (a = account()) => createModeratorSession(a);

beforeEach(() => {
  getAccount.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("verifyModeratorSession", () => {
  it("returns the live account for a valid cookie", async () => {
    getAccount.mockResolvedValue({ ...account(), password: undefined });
    const s = await verifyModeratorSession(cookieFor());
    expect(s).toMatchObject({ id: "m-1", role: "moderator", name: "Mo Derator" });
    expect(getAccount).toHaveBeenCalledWith("m-1");
  });

  it("a DELETED account's cookie stops working immediately", async () => {
    getAccount.mockResolvedValue(undefined);
    expect(await verifyModeratorSession(cookieFor())).toBeUndefined();
  });

  it("a DEMOTED owner loses owner rights immediately (role comes from the DB, not the cookie)", async () => {
    getAccount.mockResolvedValue({ ...account({ id: "o-1", role: "moderator" }), password: undefined });
    const s = await verifyModeratorSession(cookieFor(account({ id: "o-1", role: "owner" })));
    expect(s?.role).toBe("moderator");
  });

  it("a promoted moderator picks up the new role without re-login", async () => {
    getAccount.mockResolvedValue({ ...account({ role: "owner" }), password: undefined });
    expect((await verifyModeratorSession(cookieFor()))?.role).toBe("owner");
  });

  it("renamed / re-emailed accounts show current data, not the 30-day-old cookie copy", async () => {
    getAccount.mockResolvedValue({ ...account({ name: "New Name", email: "new@x.io" }), password: undefined });
    expect(await verifyModeratorSession(cookieFor())).toMatchObject({ name: "New Name", email: "new@x.io" });
  });

  it("fails CLOSED when the account lookup errors", async () => {
    getAccount.mockRejectedValue(new Error("db down"));
    expect(await verifyModeratorSession(cookieFor())).toBeUndefined();
  });

  it.each([undefined, "", "garbage", "a.b", "x".repeat(2000)])(
    "an unsigned / forged cookie (%#) never even reaches the DB",
    async (value) => {
      expect(await verifyModeratorSession(value)).toBeUndefined();
      expect(getAccount).not.toHaveBeenCalled();
    },
  );

  it("never exposes the password hash on the session", async () => {
    getAccount.mockResolvedValue(account());
    const s = (await verifyModeratorSession(cookieFor())) as Record<string, unknown> | undefined;
    // getAccountForSession strips it; the session object must not carry one either.
    expect(s && "password" in s && s.password).toBeFalsy();
  });
});
