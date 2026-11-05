import { test, expect, loginThroughForm } from "../fixtures";
import { ADMIN, MODERATOR } from "../config";
import { query, seedNews } from "../support/db";

const ownerCount = async () => Number((await query<{ n: string }>(`select count(*)::text as n from accounts where role = 'owner'`))[0]!.n);

test.describe("user management", () => {
  test("creating a moderator stores a hashed password and the new account can log in", async ({ page, login, browser }) => {
    await login();
    await page.goto("/moderation/users?create=1");
    await page.getByLabel("Display name").fill("Casey Mod");
    await page.getByLabel("Username").fill("casey");
    await page.getByLabel("Email").fill("casey@e2e.test");
    await page.getByLabel("Initial password").fill("casey-password-1");
    await page.getByRole("button", { name: "Create user" }).click();
    await expect(page).toHaveURL(/toast=user-created/);

    const [row] = await query<{ role: string; password_hash: string }>(`select role, password_hash from accounts where username = 'casey'`);
    expect(row!.role).toBe("moderator");
    expect(row!.password_hash.startsWith("scrypt$")).toBe(true);
    expect(row!.password_hash).not.toContain("casey-password-1");

    const fresh = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "203.0.113.150" } });
    const freshPage = await fresh.newPage();
    await loginThroughForm(freshPage, "casey", "casey-password-1");
    await expect(freshPage).toHaveURL(/toast=logged-in/);
    await fresh.close();
  });

  const create = async (page: import("@playwright/test").Page, f: { name?: string; username: string; email: string; password: string }) => {
    await page.goto("/moderation/users?create=1");
    await page.evaluate(() => ((document.querySelector("form input[name=password]") as HTMLInputElement).minLength = 0));
    await page.getByLabel("Display name").fill(f.name ?? "Someone");
    await page.getByLabel("Username").fill(f.username);
    await page.getByLabel("Email").fill(f.email);
    await page.getByLabel("Initial password").fill(f.password);
    await page.getByRole("button", { name: "Create user" }).click();
  };

  test("a duplicate username or email is refused with a message", async ({ page, login }) => {
    await login();
    await create(page, { username: MODERATOR.username, email: "other@e2e.test", password: "long-enough-1" });
    await expect(page).toHaveURL(/create=1.*(error|addUser)|error=username_taken|username_taken/);
    await create(page, { username: "newname", email: "mod@e2e.test", password: "long-enough-1" });
    await expect(page).toHaveURL(/email_taken/);
    expect(await query(`select 1 from accounts`)).toHaveLength(3);
  });

  for (const [name, password] of [["too short", "abc"], ["too long", "x".repeat(300)]] as const) {
    test(`a password that is ${name} is refused and no account is created`, async ({ page, login }) => {
      await login();
      await create(page, { username: "weakling", email: "weak@e2e.test", password });
      await expect(page).toHaveURL(/weak_password/);
      expect(await query(`select 1 from accounts where username = 'weakling'`)).toHaveLength(0);
    });
  }

  test("an owner can edit a moderator: rename, promote, and reset their password", async ({ page, login, browser }) => {
    await login();
    await page.goto("/moderation/users?edit=acct-mod");
    await page.getByLabel("Display name").fill("Renamed Mod");
    await page.getByLabel("Role").selectOption("owner");
    await page.getByLabel("New password").fill("reset-by-owner-1");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/toast=user-updated/);

    const [row] = await query<{ display_name: string; role: string; password_hash: string }>(`select display_name, role, password_hash from accounts where username = $1`, [MODERATOR.username]);
    expect(row).toMatchObject({ display_name: "Renamed Mod", role: "owner" });
    expect(row!.password_hash.startsWith("scrypt$")).toBe(true);

    const fresh = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "203.0.113.151" } });
    const p = await fresh.newPage();
    await loginThroughForm(p, MODERATOR.username, MODERATOR.password);
    await expect(p).toHaveURL(/error=invalid/); // old password no longer works
    await loginThroughForm(p, MODERATOR.username, "reset-by-owner-1");
    await expect(p).toHaveURL(/toast=logged-in/);
    await fresh.close();
  });

  test("deleting a moderator removes the account and ends their session immediately", async ({ page, login, browser }) => {
    const modContext = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "203.0.113.152" } });
    const modPage = await modContext.newPage();
    await loginThroughForm(modPage, MODERATOR.username, MODERATOR.password);
    await expect(modPage).toHaveURL(/toast=logged-in/);

    await login();
    await page.goto("/moderation/users");
    // Accounts are listed by username (admin, legacy, mod) and your own row has no delete control,
    // so the last Delete button belongs to "mod".
    await expect(page.locator('button[title="Delete"]')).toHaveCount(2);
    await page.locator('button[title="Delete"]').last().click();
    await page.getByRole("button", { name: /^(Delete|Confirm|Yes)/ }).last().click(); // the in-page confirmation
    await expect(page).toHaveURL(/toast=user-deleted/);
    expect(await query(`select 1 from accounts where username = $1`, [MODERATOR.username])).toHaveLength(0);

    await modPage.goto("/moderation");
    await expect(modPage).toHaveURL(/\/login\?next=/);
    await modContext.close();
  });

  test("the system can't be left without an owner by demoting the only owner", async ({ page, login }) => {
    await query(`update accounts set role = 'moderator' where username <> $1`, [ADMIN.username]);
    expect(await ownerCount()).toBe(1);
    await login();
    await page.goto("/moderation/users?edit=acct-admin");
    await page.getByLabel("Role").selectOption("moderator");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/error=last_owner/);
    await expect(page.getByText("There must always be at least one owner").first()).toBeVisible();
    expect(await ownerCount(), "no owner left: nobody can manage users or news").toBe(1);
  });

  test("the last owner can't be deleted (there is no delete control for your own row)", async ({ page, login }) => {
    await query(`update accounts set role = 'moderator' where username <> $1`, [ADMIN.username]);
    await login();
    await page.goto("/moderation/users");
    // Three accounts, but only the two other ones can be deleted: there's no control on your own row.
    await expect(page.locator('button[title="Delete"]')).toHaveCount(2);
    expect(await ownerCount()).toBe(1);
  });

  test("an owner can hand over: promote someone else first, then step down", async ({ page, login }) => {
    await login();
    await page.goto("/moderation/users?edit=acct-mod");
    await page.getByLabel("Role").selectOption("owner");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/toast=user-updated/);

    await page.goto("/moderation/users?edit=acct-admin");
    await page.getByLabel("Role").selectOption("moderator");
    await page.getByRole("button", { name: "Save changes" }).click();
    // They are no longer an owner, so the (owner-only) users page sends them to the queue.
    await expect(page).toHaveURL(/\/moderation$/);
    expect(await ownerCount()).toBe(1);
    const [row] = await query<{ role: string }>(`select role from accounts where username = $1`, [MODERATOR.username]);
    expect(row!.role).toBe("owner");
  });

  test("a display name with markup is shown as text, never run", async ({ page, login }) => {
    await query(`update accounts set display_name = $1 where username = $2`, ['<img src=x onerror="window.__pwned=1">Evil', MODERATOR.username]);
    await login();
    await page.goto("/moderation/users", { waitUntil: "networkidle" });
    await expect(page.getByText("<img src=x onerror", { exact: false }).first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  });
});

test.describe("news", () => {
  test("a published post appears on /news (markdown rendered); unpublishing hides it", async ({ page, login }) => {
    await login();
    await page.goto("/moderation/news?create=1");
    await page.getByLabel("Title").fill("Big announcement");
    await page.locator('textarea[name="body"]').fill("We **now** do this.\n\n- one\n- two");
    await page.getByLabel("Publish immediately").check({ force: true });
    await page.getByRole("button", { name: "Create post" }).click();
    await expect(page).toHaveURL(/toast=news-created/);

    await page.goto("/news");
    await expect(page.locator("text=Big announcement >> visible=true").first()).toBeVisible();
    await expect(page.locator("strong:visible", { hasText: "now" }).first()).toBeVisible();
    await expect(page.locator("li:visible", { hasText: "two" }).first()).toBeVisible();

    await query(`update news_items set published_at = null`);
    await page.goto("/news");
    await expect(page.locator("text=Big announcement")).toHaveCount(0);
  });

  test("an unpublished draft is never shown publicly", async ({ page }) => {
    await seedNews([{ id: "draft", title: "Secret draft", body: "nope", published: false }]);
    await page.goto("/news");
    await expect(page.getByText("Secret draft")).toHaveCount(0);
    const res = await page.goto("/news?post=draft");
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByText("Secret draft")).toHaveCount(0);
  });

  test("markup in a post title/body is escaped on the public page", async ({ page }) => {
    await seedNews([{ id: "x1", title: "<script>window.__pwned=1</script>Title", body: "<img src=x onerror=\"window.__pwned=2\"> [c](javascript:window.__pwned=3)" }]);
    await page.goto("/news", { waitUntil: "networkidle" });
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  });

  test("a tampered post type is coerced rather than crashing", async ({ page, login }) => {
    await login();
    await page.goto("/moderation/news?create=1");
    await page.getByLabel("Title").fill("Typed post");
    await page.locator('textarea[name="body"]').fill("body");
    await page.evaluate(() => {
      const sel = document.querySelector('select[name="type"]') as HTMLSelectElement;
      sel.add(new Option("bogus", "bogus"));
      sel.value = "bogus";
    });
    await page.getByRole("button", { name: "Create post" }).click();
    await expect(page).toHaveURL(/toast=news-created/);
    const [row] = await query<{ type: string }>(`select type from news_items`);
    expect(["announcement", "product-news", "community", "update"]).toContain(row!.type);
  });

  test("an empty title or body creates nothing", async ({ page, login }) => {
    await login();
    await page.goto("/moderation/news?create=1");
    await page.evaluate(() => ((document.querySelector("form") as HTMLFormElement).noValidate = true));
    await page.getByRole("button", { name: "Create post" }).click();
    await page.waitForLoadState("networkidle");
    expect(await query(`select 1 from news_items`)).toHaveLength(0);
  });

  test("editing a post saves the changes", async ({ page, login }) => {
    await seedNews([{ id: "e1", title: "Before", body: "old body" }]);
    await login();
    await page.goto("/moderation/news?edit=e1");
    await page.getByLabel("Title").fill("After");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/toast=news-updated/);
    const [row] = await query<{ title: string }>(`select title from news_items where id = 'e1'`);
    expect(row!.title).toBe("After");
  });

  test("a moderator (not owner) can't reach news management", async ({ page }) => {
    await loginThroughForm(page, MODERATOR.username, MODERATOR.password);
    await page.waitForURL(/toast=logged-in/);
    await page.goto("/moderation/news?create=1");
    await expect(page).toHaveURL(/\/moderation$/);
  });
});
