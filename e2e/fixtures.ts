import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, MODERATOR } from "./config";
import { closeDb, seedBaseline } from "./support/db";

let ipCounter = 0;

/**
 * Extends the base test so every test:
 *  - starts from a freshly seeded database (movies + three accounts),
 *  - presents a unique client IP (x-forwarded-for), so rate limits never leak
 *    from one test into the next.
 */
export const test = base.extend<{ clientIp: string; login: (who?: { username: string; password: string }) => Promise<void> }>({
  clientIp: async ({}, use) => {
    ipCounter += 1;
    await use(`198.51.100.${(ipCounter % 250) + 1}`);
  },
  page: async ({ page, context, clientIp }, use) => {
    await seedBaseline();
    await context.setExtraHTTPHeaders({ "x-forwarded-for": clientIp });
    await use(page);
  },
  // API-only tests get the same clean database and unique client address.
  request: async ({ playwright, baseURL, clientIp }, use) => {
    await seedBaseline();
    const context: APIRequestContext = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { "x-forwarded-for": clientIp },
    });
    await use(context);
    await context.dispose();
  },
  login: async ({ page }, use) => {
    await use(async (who = ADMIN) => {
      await loginThroughForm(page, who.username, who.password);
      await expect(page).toHaveURL(/toast=logged-in/);
    });
  },
});

export { expect };
export { ADMIN, MODERATOR };

export async function loginThroughForm(page: Page, username: string, password: string, next = "/moderation") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

test.afterAll(async () => {
  await closeDb();
});
