import { test, expect, MODERATOR } from "../fixtures";
import { BASE_URL } from "../config";
import { query } from "../support/db";

// The suite runs a production build — exactly where these previews used to 404.
test.describe("email previews", () => {
  test("the owner can open them, with brand images served from this site", async ({ page, login }) => {
    await login();
    for (const slug of ["newsletter", "moderation", "submitter-receipt", "submitter-approved", "submitter-declined"]) {
      const response = await page.goto(`/email-preview/${slug}`);
      expect(response?.status(), slug).toBe(200);
      await expect(page.getByRole("img", { name: "WhereRat" })).toHaveAttribute("src", `${BASE_URL}/brand/email/wordmark.svg`);
    }
    await page.goto("/email-preview/newsletter");
    await expect(page.getByRole("heading", { name: "Fresh from WhereRat" })).toBeVisible();
  });

  test("the owner-controls button opens them", async ({ page, login }) => {
    await login();
    await page.getByRole("link", { name: "Email previews" }).click();
    await expect(page).toHaveURL(/\/email-preview\/newsletter$/);
    await expect(page.getByRole("heading", { name: "Fresh from WhereRat" })).toBeVisible();
  });

  test("the newsletter composer shows a live preview of the chosen post", async ({ page, login }) => {
    await query(
      `insert into news_items (id, title, body, type, author_id, author_name, author_avatar_url, published_at)
       values ('news-e2e', 'Rats spotted in the pantry', 'A fresh batch of sightings.', 'announcement', 'acct-admin', 'E2E Admin', '/favicon.svg', now())`,
    );
    await login();
    await page.goto("/moderation/news?compose=1");
    await page.getByRole("button", { name: /Rats spotted in the pantry/ }).click();

    const preview = page.frameLocator('iframe[title="Email preview"]');
    await expect(preview.getByRole("heading", { name: "Rats spotted in the pantry" }).first()).toBeVisible();
    await expect(preview.locator("p", { hasText: "A fresh batch of sightings." })).toBeVisible();
  });

  test("a moderator who is not the owner is turned away", async ({ page, login }) => {
    await login(MODERATOR);
    await expect(page.getByRole("link", { name: "Email previews" })).toHaveCount(0);
    await page.goto("/email-preview/newsletter");
    await expect(page).toHaveURL(/\/moderation$/);
  });

  test("signed-out visitors are sent to log in", async ({ page }) => {
    await page.goto("/email-preview/moderation");
    await expect(page).toHaveURL(/\/login\?next=%2Femail-preview%2Fmoderation$/);
  });
});
