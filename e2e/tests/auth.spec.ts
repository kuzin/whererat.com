import { test, expect, loginThroughForm } from "../fixtures";
import { ADMIN, LEGACY, MODERATOR } from "../config";
import { query } from "../support/db";

const PROTECTED = ["/moderation", "/moderation/users", "/moderation/news", "/profile"];

test.describe("access control", () => {
  for (const path of PROTECTED) {
    test(`${path} sends a logged-out visitor to the login page`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/%2F/g, "(?:/|%2F)")}`));
    });
  }

  test("a moderator (not owner) can use the queue but not user management or news", async ({ page }) => {
    await loginThroughForm(page, MODERATOR.username, MODERATOR.password);
    await expect(page).toHaveURL(/\/moderation\?toast=logged-in/);
    for (const path of ["/moderation/users", "/moderation/news"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/moderation$/);
    }
  });

  test("the owner can open user management", async ({ page, login }) => {
    await login();
    await page.goto("/moderation/users");
    await expect(page).toHaveURL(/\/moderation\/users$/);
    await expect(page.getByText(MODERATOR.name).first()).toBeVisible();
  });
});

test.describe("logging in", () => {
  test("the right password signs in with a hardened session cookie", async ({ page, context }) => {
    await loginThroughForm(page, ADMIN.username, ADMIN.password);
    await expect(page).toHaveURL(/\/moderation\?toast=logged-in/);
    const cookie = (await context.cookies()).find((c) => c.name === "whererat_moderator");
    expect(cookie).toBeTruthy();
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(cookie!.value).not.toContain(ADMIN.password);
  });

  test("a wrong password is refused with no session", async ({ page, context }) => {
    await loginThroughForm(page, ADMIN.username, "wrong-password");
    await expect(page).toHaveURL(/error=invalid/);
    await expect(page.getByText("Login failed")).toBeVisible();
    expect((await context.cookies()).find((c) => c.name === "whererat_moderator")).toBeUndefined();
  });

  test("an unknown username gets the same answer as a wrong password", async ({ page }) => {
    await loginThroughForm(page, "nobody", "whatever-123");
    await expect(page).toHaveURL(/error=invalid/);
    await expect(page.getByText("Login failed")).toBeVisible();
  });

  test("logging out ends the session", async ({ page, login }) => {
    await login();
    await page.getByRole("button", { name: "Log out" }).first().click();
    await expect(page).toHaveURL(/\/login\?toast=logged-out/);
    await page.goto("/moderation");
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  for (const next of ["//evil.example", "/\\evil.example", "https://evil.example/phish"]) {
    test(`a hostile next=${next} never redirects off-site`, async ({ page }) => {
      await loginThroughForm(page, ADMIN.username, ADMIN.password, next);
      await expect(page).toHaveURL(/127\.0\.0\.1:3200\/moderation\?toast=logged-in/);
    });
  }

  test("a same-site next is honoured", async ({ page }) => {
    await loginThroughForm(page, ADMIN.username, ADMIN.password, "/profile");
    await expect(page).toHaveURL(/\/profile\?toast=logged-in/);
  });
});

test.describe("passwords at rest", () => {
  test("seeded hashed accounts hold no plaintext", async () => {
    const rows = await query<{ username: string; password_hash: string }>(`select username, password_hash from accounts`);
    for (const r of rows.filter((x) => x.username !== LEGACY.username)) {
      expect(r.password_hash.startsWith("scrypt$")).toBe(true);
      expect(r.password_hash).not.toContain(ADMIN.password);
    }
  });

  test("a legacy plaintext account logs in once and is upgraded to a hash in place", async ({ page }) => {
    const before = await query<{ password_hash: string }>(`select password_hash from accounts where username = $1`, [LEGACY.username]);
    expect(before[0]!.password_hash).toBe(LEGACY.password);

    await loginThroughForm(page, LEGACY.username, LEGACY.password);
    await expect(page).toHaveURL(/toast=logged-in/);

    const [after] = await query<{ password_hash: string }>(`select password_hash from accounts where username = $1`, [LEGACY.username]);
    expect(after!.password_hash.startsWith("scrypt$")).toBe(true);
    expect(after!.password_hash).not.toContain(LEGACY.password);

    // …and the same password keeps working against the new hash.
    await page.context().clearCookies();
    await loginThroughForm(page, LEGACY.username, LEGACY.password);
    await expect(page).toHaveURL(/toast=logged-in/);
  });

  test("changing the password from the profile page: old stops working, new works, still hashed", async ({ page, login }) => {
    await login();
    await page.goto("/profile");
    await page.getByLabel("Current password").fill(ADMIN.password);
    await page.getByLabel("New password", { exact: true }).fill("a-brand-new-password-9");
    await page.getByLabel("Confirm new password").fill("a-brand-new-password-9");
    await page.getByRole("button", { name: "Update passphrase" }).click();
    await expect(page).toHaveURL(/status=password-updated/);

    await page.context().clearCookies();
    await loginThroughForm(page, ADMIN.username, ADMIN.password);
    await expect(page).toHaveURL(/error=invalid/);
    await loginThroughForm(page, ADMIN.username, "a-brand-new-password-9");
    await expect(page).toHaveURL(/toast=logged-in/);

    const [row] = await query<{ password_hash: string }>(`select password_hash from accounts where username = $1`, [ADMIN.username]);
    expect(row!.password_hash.startsWith("scrypt$")).toBe(true);
  });

  test("a wrong current password is refused and nothing changes", async ({ page, login }) => {
    await login();
    const [before] = await query<{ password_hash: string }>(`select password_hash from accounts where username = $1`, [ADMIN.username]);
    await page.goto("/profile");
    await page.getByLabel("Current password").fill("not-my-password");
    await page.getByLabel("New password", { exact: true }).fill("a-brand-new-password-9");
    await page.getByLabel("Confirm new password").fill("a-brand-new-password-9");
    await page.getByRole("button", { name: "Update passphrase" }).click();
    await expect(page).toHaveURL(/status=password-invalid/);
    const [after] = await query<{ password_hash: string }>(`select password_hash from accounts where username = $1`, [ADMIN.username]);
    expect(after!.password_hash).toBe(before!.password_hash);
  });
});

test.describe("brute-force protection", () => {
  test("every attempt is counted, and once over the limit even the CORRECT password is refused", async ({ page }) => {
    await loginThroughForm(page, ADMIN.username, "guess-1");
    await expect(page).toHaveURL(/error=invalid/);
    const [bucket] = await query<{ count: number }>(`select count from rate_limits where key like 'login:%'`);
    expect(bucket!.count).toBe(1);

    // Fast-forward to the edge of the limit (10 attempts / 15 minutes).
    await query(`update rate_limits set count = 10 where key like 'login:%'`);
    await loginThroughForm(page, ADMIN.username, ADMIN.password);
    await expect(page).toHaveURL(/error=too-many-attempts/);
    await expect(page.getByText("Too many login attempts")).toBeVisible();
    await page.goto("/moderation");
    await expect(page).toHaveURL(/\/login\?next=/); // no session was created
  });

  test("the limit is per address: another client is unaffected", async ({ page, browser }) => {
    await loginThroughForm(page, ADMIN.username, "guess");
    await query(`update rate_limits set count = 50 where key like 'login:%'`);

    const other = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "203.0.113.200" } });
    const otherPage = await other.newPage();
    await loginThroughForm(otherPage, ADMIN.username, ADMIN.password);
    await expect(otherPage).toHaveURL(/toast=logged-in/);
    await other.close();
  });
});

test.describe("sessions are re-verified against the account", () => {
  test("a demoted owner loses owner pages immediately, with the same cookie", async ({ page, login }) => {
    await login();
    await page.goto("/moderation/users");
    await expect(page).toHaveURL(/\/moderation\/users$/);

    await query(`update accounts set role = 'moderator' where username = $1`, [ADMIN.username]);
    await page.goto("/moderation/users");
    await expect(page).toHaveURL(/\/moderation$/);
  });

  test("a deleted account's cookie stops working immediately", async ({ page, login }) => {
    await login();
    await query(`delete from accounts where username = $1`, [ADMIN.username]);
    await page.goto("/moderation");
    await expect(page).toHaveURL(/\/login\?next=/);
  });
});
