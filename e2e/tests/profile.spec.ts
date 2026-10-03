import { test, expect, loginThroughForm } from "../fixtures";
import { ADMIN, MODERATOR } from "../config";
import { query } from "../support/db";

test.describe("profile: roles can't be self-assigned", () => {
  test("a moderator who tampers with the role field stays a moderator and gets no owner pages", async ({ page }) => {
    await loginThroughForm(page, MODERATOR.username, MODERATOR.password);
    await page.waitForURL(/toast=logged-in/);
    await page.goto("/profile");

    // Even if a role field is injected into the form (the page no longer renders one).
    await page.evaluate(() => {
      const form = [...document.forms].find((f) => f.querySelector('[name="email"]'))!;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "role";
      input.value = "owner";
      form.appendChild(input);
    });
    await page.getByRole("button", { name: "Save profile changes" }).click();
    await expect(page).toHaveURL(/status=profile-updated/);

    const [row] = await query<{ role: string }>(`select role from accounts where username = $1`, [MODERATOR.username]);
    expect(row!.role).toBe("moderator");
    for (const path of ["/moderation/users", "/moderation/news"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/moderation$/);
    }
  });

  test("the profile page shows the role as read-only text, not a control", async ({ page }) => {
    await loginThroughForm(page, MODERATOR.username, MODERATOR.password);
    await page.waitForURL(/toast=logged-in/);
    await page.goto("/profile");
    await expect(page.locator('select[name="role"]')).toHaveCount(0);
    await expect(page.getByTestId("profile-role")).toHaveText(/moderator/i);
  });

  test("an owner editing their own profile keeps the owner role", async ({ page, login }) => {
    await login();
    await page.goto("/profile");
    await page.getByLabel("Display name").fill("Renamed Owner");
    await page.getByRole("button", { name: "Save profile changes" }).click();
    await expect(page).toHaveURL(/status=profile-updated/);

    const [row] = await query<{ role: string; display_name: string }>(`select role, display_name from accounts where username = $1`, [ADMIN.username]);
    expect(row).toEqual({ role: "owner", display_name: "Renamed Owner" });
    await page.goto("/moderation/users");
    await expect(page).toHaveURL(/\/moderation\/users$/);
  });
});
